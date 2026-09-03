import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import { hashSync } from "@node-rs/argon2";

/**
 * The Sign Test tile, end to end (spec-08/09).
 *
 * What this pins down is the thing that was actually broken: the homepage offered one way into a
 * test, and a sign question could not exist at all. So it asserts the tile is there, that tapping
 * it serves a question WITH ITS PICTURE, and that the picture is not cropped away or unlabelled.
 *
 * The answer-key invariant is re-checked here rather than left to student-quiz.spec.ts, because
 * sign questions travel a different path into the payload (they carry `sourceImage`) and a leak
 * introduced there would not show up in the text-only test.
 */
const db = new PrismaClient();
const RUN = randomBytes(4).toString("hex");
const EMAIL = `elev-skilt-${RUN}@example.no`;
const PASSWORD = "bratsberg-sving-42";

test.beforeAll(async () => {
  await db.user.create({
    data: {
      email: EMAIL,
      role: "STUDENT",
      emailVerifiedAt: new Date(),
      passwordHash: hashSync(PASSWORD, {
        memoryCost: 19456,
        timeCost: 2,
        parallelism: 1,
      }),
      profile: { create: { firstName: "Skilt", lastName: RUN } },
    },
    select: { id: true },
  });
});

test.afterAll(async () => {
  const user = await db.user.findUnique({
    where: { email: EMAIL },
    select: { id: true },
  });
  if (user) {
    const attempts = await db.examAttempt.findMany({
      where: { userId: user.id },
      select: { id: true },
    });
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        "SET LOCAL session_replication_role = 'replica'",
      );
      await tx.examAttemptQuestion.deleteMany({
        where: { attemptId: { in: attempts.map((a) => a.id) } },
      });
      await tx.examAttempt.deleteMany({
        where: { id: { in: attempts.map((a) => a.id) } },
      });
    });
    await db.auditLog.deleteMany({ where: { actorId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  }
  await db.$disconnect();
});

async function logIn(page: import("@playwright/test").Page) {
  await page.goto("/en/login");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/en$/);
}

test("the homepage offers a sign test, and it serves a question with its picture", async ({
  page,
}) => {
  const signQuestions = await db.masterItem.count({
    where: {
      type: "SIGN",
      status: "APPROVED",
      deletedAt: null,
      variants: { some: { isActive: true } },
    },
  });
  test.skip(signQuestions === 0, "no approved sign questions in this database");

  const seen: { method: string; url: string; body: string }[] = [];
  page.on("response", async (response) => {
    try {
      if (response.url().startsWith("http://localhost:3100")) {
        seen.push({
          method: response.request().method(),
          url: response.url(),
          body: await response.text(),
        });
      }
    } catch {
      // an unreadable body tells us nothing either way
    }
  });

  await logIn(page);

  // The complaint this work started from: only one way in was offered.
  await expect(
    page.getByRole("button", { name: /^Sign test\b/ }),
  ).toBeVisible();

  await page.getByRole("button", { name: /^Sign test\b/ }).click();
  await page.waitForURL(/\/quiz\//);
  await expect(page.getByText(/Question 1 of \d+/)).toBeVisible();

  // A sign question without its sign is unanswerable, so the image is part of the assertion.
  // Located BY ITS ACCESSIBLE NAME, which is also the check that it has one: an empty alt would
  // make this image invisible to the accessibility tree and unfindable here.
  const image = page.getByRole("img", { name: "Picture for this question" });
  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute("src", /\/signs\/|\/api\/images\//);

  // ...and that the name does NOT describe the sign, which would hand over the answer.
  const alt = (await image.getAttribute("alt")) ?? "";
  const answer = await page.getByRole("radio").first().textContent();
  expect(alt.toLowerCase()).not.toContain(
    (answer ?? "unmatchable").trim().toLowerCase(),
  );

  // `contain`, not `cover`: a cropped road sign can read as a different sign entirely.
  await expect(image).toHaveClass(/object-contain/);
  const box = await image.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(0);

  await page.getByRole("radio").first().click();
  await expect(
    page.getByText("Answer recorded — it cannot be changed."),
  ).toBeVisible();

  // No render may carry the key before submission, sign questions included.
  const leaks = seen.filter(
    (entry) =>
      entry.method === "GET" &&
      !entry.url.includes("/_next/static/") &&
      /correctOptionKey/.test(entry.body),
  );
  expect(leaks.map((entry) => entry.url)).toEqual([]);
});

test("an empty sign pool renders a genuinely disabled tile, not one that fails on tap", async ({
  page,
}) => {
  const signQuestions = await db.masterItem.count({
    where: {
      type: "SIGN",
      status: "APPROVED",
      deletedAt: null,
      variants: { some: { isActive: true } },
    },
  });
  test.skip(
    signQuestions > 0,
    "this database has sign questions, so the tile is live",
  );

  await logIn(page);

  // Spec-16 removed the Theory and Image tiles; Sign test is the one that is still pool-gated,
  // and it must be genuinely disabled rather than faded-but-live.
  const tile = page.getByRole("button", { name: /Sign test not ready/ });
  await expect(tile).toBeVisible();
  await expect(tile).toBeDisabled();
});

test("sign graphics are public, uploaded photographs are not", async ({
  page,
  request,
}) => {
  const sign = await db.sign.findFirst({
    where: { isActive: true },
    select: { svgPath: true },
  });
  test.skip(!sign, "sign registry is empty");

  // Reference material: spec-10 puts these in a browsable catalogue and a logged-out demo quiz.
  expect((await request.get(sign!.svgPath)).status()).toBe(200);

  // Exam photographs are the opposite: no session, no bytes — not a redirect to a login page that
  // an <img> would render as a broken image, but a real 401.
  const response = await request.get("/api/images/does-not-exist", {
    maxRedirects: 0,
  });
  expect(response.status()).toBe(401);
  await page.close();
});
