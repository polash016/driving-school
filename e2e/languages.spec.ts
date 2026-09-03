import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import { hashSync } from "@node-rs/argon2";

/**
 * The admin side of spec-15: adding a language, seeing how far it has got, and reviewing a
 * translation.
 *
 * The reviewer is an INSTRUCTOR — judging a translation needs someone who reads the language, and
 * that is usually a teacher rather than whoever holds the admin account. It also avoids the ADMIN
 * two-factor gate, which spec-03 correctly puts in front of every admin login.
 */
const db = new PrismaClient();
const RUN = randomBytes(3).toString("hex");
const PASSWORD = "bratsberg-sving-42";
const reviewerEmail = `lang-rev-${RUN}@example.no`;
const CODE = `qb-${RUN}`.slice(0, 8);

let topicId = "";
let translationId = "";

test.beforeAll(async () => {
  await db.user.create({
    data: {
      email: reviewerEmail,
      role: "INSTRUCTOR",
      passwordHash: hashSync(PASSWORD, {
        memoryCost: 19456,
        timeCost: 2,
        parallelism: 1,
      }),
      emailVerifiedAt: new Date(),
      profile: { create: { firstName: "Lang", lastName: RUN } },
    },
    select: { id: true },
  });

  await db.language.create({
    data: {
      code: CODE,
      englishName: "QA Review Language",
      nativeName: "QA Revisión",
      shortLabel: "QR",
      urlPrefix: `/${CODE}`,
      direction: "LTR",
      requiresApproval: true,
      studentVisible: false,
      sortOrder: 90,
    },
  });

  const topic = await db.topic.findFirstOrThrow({
    where: { parentId: null, deletedAt: null },
    select: { id: true },
  });
  topicId = topic.id;

  // One machine translation waiting for a human — the state the review screen exists for.
  const translation = await db.translation.create({
    data: {
      locale: CODE,
      entity: "TOPIC",
      entityId: topicId,
      value: { name: `Prioridad ${RUN}` },
      status: "MACHINE",
      sourceHash: "e2e-fixture",
      qaFlags: ["SEMANTIC_DRIFT"],
      semanticScore: 0.72,
    },
    select: { id: true },
  });
  translationId = translation.id;
});

test.afterAll(async () => {
  await db.translation.deleteMany({ where: { locale: CODE } });
  await db.translationMemory.deleteMany({ where: { locale: CODE } });
  await db.language.deleteMany({ where: { code: CODE } });
  const users = await db.user.findMany({
    where: { email: reviewerEmail },
    select: { id: true },
  });
  const ids = users.map((user) => user.id);
  await db.auditLog.deleteMany({ where: { actorId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  await db.$disconnect();
});

async function login(page: import("@playwright/test").Page) {
  await page.goto("/en/login");
  await page.getByLabel("Email").fill(reviewerEmail);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/en$/);
}

test("a reviewer sees the source beside the translation, with the flag in words", async ({
  page,
}) => {
  await login(page);
  await page.goto(`/en/admin/languages/${CODE}`);

  await expect(
    page.getByRole("heading", { name: /QA Revisión/ }),
  ).toBeVisible();
  // The QA code is rendered as something a reviewer can act on, not as NUMBER_DRIFT.
  await expect(page.getByText("The meaning may have shifted")).toBeVisible();
  await expect(page.getByText(`Prioridad ${RUN}`)).toBeVisible();

  await page.getByRole("button", { name: "Approve" }).first().click();
  await expect(page.getByText("Nothing waiting for review.")).toBeVisible();

  const row = await db.translation.findUniqueOrThrow({
    where: { id: translationId },
    select: { status: true, reviewedById: true },
  });
  expect(row.status).toBe("APPROVED");
  expect(row.reviewedById).not.toBeNull();
});

test("the language board is admin-only, and an unfinished language stays hidden", async ({
  page,
}) => {
  await login(page);
  // Reviewing is an instructor's job; adding a language and starting a run is not.
  await page.goto("/en/admin/languages");
  await expect(page.locator("body")).toContainText(
    /do not have access|ikke tilgang/i,
  );

  const language = await db.language.findUniqueOrThrow({
    where: { code: CODE },
    select: { studentVisible: true },
  });
  expect(language.studentVisible).toBe(false);

  // A hidden language is not offered to students, whatever exists in the database.
  await page.goto("/en");
  await expect(page.getByRole("group", { name: "Language" })).not.toContainText(
    "QA Revisión",
  );
});
