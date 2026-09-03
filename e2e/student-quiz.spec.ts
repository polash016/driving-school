import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import { hashSync } from "@node-rs/argon2";

/**
 * The student's path (spec-07 integration / spec-08): start a practice quiz, answer, hand in, see
 * the paper.
 *
 * The assertion that matters most is the last one: no page render may carry the correct answer
 * before the student has submitted. Practice mode reveals only what the SERVER returns after
 * grading that specific answer — which is a different thing from shipping the key with the paper.
 */
const db = new PrismaClient();
const RUN = randomBytes(4).toString("hex");
/**
 * A user PER TEST, not per file.
 *
 * These tests run in parallel workers, and since a half-finished test is now resumable, sharing
 * one student meant one test could pick up the attempt another had left open — which showed up as
 * a flake, not as a failure, and would have been miserable to chase later.
 */
const EMAILS = {
  practice: `elev-p-${RUN}@example.no`,
  lock: `elev-l-${RUN}@example.no`,
  setup: `elev-s-${RUN}@example.no`,
} as const;
const emails = Object.values(EMAILS);
const PASSWORD = "bratsberg-sving-42";

test.beforeAll(async () => {
  for (const email of emails) {
    await db.user.create({
      data: {
        email,
        role: "STUDENT",
        emailVerifiedAt: new Date(),
        passwordHash: hashSync(PASSWORD, {
          memoryCost: 19456,
          timeCost: 2,
          parallelism: 1,
        }),
        profile: { create: { firstName: "Kari", lastName: RUN } },
      },
      select: { id: true },
    });
  }
});

test.afterAll(async () => {
  const users = await db.user.findMany({
    where: { email: { in: emails } },
    select: { id: true },
  });
  const ids = users.map((user) => user.id);
  const attempts = await db.examAttempt.findMany({
    where: { userId: { in: ids } },
    select: { id: true },
  });
  // Submitted attempts are protected by triggers, which is the point of them — so cleanup has to
  // suspend them deliberately. `SET LOCAL session_replication_role` does that for THIS transaction
  // only: no global `ALTER TABLE`, so a concurrently-running spec file cannot re-enable the
  // triggers underneath us, and nothing is left disabled if this process dies.
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
  await db.auditLog.deleteMany({ where: { actorId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  await db.$disconnect();
});

test("practice: start, answer, hand in, and never receive the answer key early", async ({
  page,
}) => {
  const approved = await db.masterItem.count({
    where: {
      status: "APPROVED",
      deletedAt: null,
      variants: { some: { isActive: true } },
    },
  });
  test.skip(approved === 0, "no approved questions in this database");

  // Record every response, tagged with the phase and method, to check the invariant afterwards.
  const seen: { phase: string; method: string; url: string; body: string }[] =
    [];
  let phase = "pre-submit";
  page.on("response", async (response) => {
    try {
      if (response.url().startsWith("http://localhost:3100")) {
        seen.push({
          phase,
          method: response.request().method(),
          url: response.url(),
          body: await response.text(),
        });
      }
    } catch {
      // a response body that cannot be read tells us nothing either way
    }
  });

  await page.goto("/en/login");
  await page.getByLabel("Email").fill(EMAILS.practice);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/en$/);

  // Practice now opens the setup screen (spec-16): the Theory Test tile is gone, and the
  // configurable path IS practice. A short paper keeps this test quick.
  await page.getByRole("link", { name: /^Practice\b/ }).click();
  await page.waitForURL(/\/quiz\/new/);
  await page.locator('input[type="range"]').fill("10");
  await page.getByRole("button", { name: "Start test" }).click();
  // Negative lookahead: /quiz/new matches a bare /quiz/<segment> too, so without
  // it this resolves instantly and captures the SETUP url as the attempt url.
  await page.waitForURL(/\/quiz\/(?!new)[^/]+$/);
  await expect(page.getByText(/Question 1 of \d+/)).toBeVisible();

  // Answer the first question; practice grades it server-side and reveals.
  await page.getByRole("radio").first().click();
  // Wait for the reveal to land before touching anything else: the explanation appears below the
  // options and moves what is under the pointer. (A real defect, not just a test timing problem —
  // spec-08 asks for CLS ≈ 0 on answer reveal; see the KNOWN DEFECT note in question-card.tsx.)
  // The lock and the explanation are TWO separate paints, so waiting for the lock alone races the
  // second one and the navigator shifts out from under the click.
  await expect(
    page.getByText("Answer recorded — it cannot be changed."),
  ).toBeVisible();
  await expect(page.getByTestId("explanation")).toBeVisible();

  // Hand-in lives on the last question, so jump there through the navigator.
  const navigator = page.getByRole("navigation", { name: "Jump to question" });
  await navigator.getByRole("button").last().click();

  phase = "post-submit";
  await page
    .getByRole("button", { name: /Hand in/ })
    .first()
    .click();
  await page.waitForURL(/account\/history\//);
  // Anchored: with a ten-question quiz, /Question 1/ also matches "Question 10".
  await expect(page.getByText(/^Question 1\b/).first()).toBeVisible();

  // THE invariant: a page render must never carry the key before submission. Server-action
  // responses may (that is practice-mode grading), and so may the post-submit paper.
  const leakingRenders = seen.filter(
    (entry) =>
      entry.phase === "pre-submit" &&
      entry.method === "GET" &&
      !entry.url.includes("/_next/static/") &&
      /correctOptionKey/.test(entry.body),
  );
  expect(leakingRenders.map((entry) => entry.url)).toEqual([]);
});

test("setup screen says up front whether a test counts towards the guarantee", async ({
  page,
}) => {
  const approved = await db.masterItem.count({
    where: {
      status: "APPROVED",
      deletedAt: null,
      variants: { some: { isActive: true } },
    },
  });
  test.skip(approved === 0, "no approved questions in this database");

  await page.goto("/en/login");
  await page.getByLabel("Email").fill(EMAILS.setup);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/en$/);

  await page.goto("/en/quiz/new");

  // Defaults mirror the official test: 45 questions, every category, clock on.
  await expect(page.locator('input[type="range"]')).toHaveValue("45");
  await expect(
    page.getByText("This test will count towards the pass guarantee."),
  ).toBeVisible();

  // Drop a category → the categories warning, in the developer's exact words.
  const categoryBoxes = page.getByRole("checkbox");
  await categoryBoxes.nth(2).uncheck();
  await expect(
    page.getByText(
      "This test will not count towards the pass guarantee. All categories must be enabled for it to count.",
    ),
  ).toBeVisible();
  await categoryBoxes.nth(2).check();

  // Shorten it → the length warning.
  await page.locator('input[type="range"]').fill("20");
  await expect(
    page.getByText(
      "This test will not count towards the pass guarantee. Tests need at least 45 questions to count.",
    ),
  ).toBeVisible();
  // The pass mark follows the length rather than staying at the official 38.
  await expect(page.getByText("Pass mark: 17 of 20 correct.")).toBeVisible();

  // Back to a qualifying setup, and the promise returns.
  await page.locator('input[type="range"]').fill("45");
  await expect(
    page.getByText("This test will count towards the pass guarantee."),
  ).toBeVisible();
});

test("an answer cannot be changed once it is given, and the test resumes where it was left", async ({
  page,
}) => {
  const approved = await db.masterItem.count({
    where: {
      status: "APPROVED",
      deletedAt: null,
      variants: { some: { isActive: true } },
    },
  });
  test.skip(approved < 3, "not enough approved questions in this database");

  await page.goto("/en/login");
  await page.getByLabel("Email").fill(EMAILS.lock);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/en$/);

  await page.getByRole("link", { name: /^Practice\b/ }).click();
  await page.waitForURL(/\/quiz\/new/);
  await page.locator('input[type="range"]').fill("10");
  await page.getByRole("button", { name: "Start test" }).click();
  // Negative lookahead: /quiz/new matches a bare /quiz/<segment> too, so without
  // it this resolves instantly and captures the SETUP url as the attempt url.
  await page.waitForURL(/\/quiz\/(?!new)[^/]+$/);
  const attemptUrl = page.url();

  // Answer question 1, then move on.
  await page.getByRole("radio").first().click();
  await expect(
    page.getByText("Answer recorded — it cannot be changed."),
  ).toBeVisible();
  // The lock and the explanation do NOT land in the same update — see the KNOWN DEFECT note in
  // question-card.tsx. Waiting only for the options to go disabled races the second paint, which
  // then shifts the Next button out from under the click. Wait for the explanation itself.
  await expect(page.getByRole("radio").first()).toBeDisabled();
  await expect(page.getByTestId("explanation")).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText(/Question 2 of \d+/)).toBeVisible();

  // Back to question 1: it is locked, and it still shows what was answered.
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByText(/Question 1 of \d+/)).toBeVisible();
  await expect(
    page.getByText("Answer recorded — it cannot be changed."),
  ).toBeVisible();
  for (const option of await page.getByRole("radio").all()) {
    await expect(option).toBeDisabled();
  }

  // A reload is the same story — the answer lives in the database, not in the page.
  await page.goto(attemptUrl);
  await page
    .getByRole("navigation", { name: "Jump to question" })
    .getByRole("button")
    .first()
    .click();
  await expect(
    page.getByText("Answer recorded — it cannot be changed."),
  ).toBeVisible();
  await expect(page.getByRole("radio").first()).toBeDisabled();

  // Leaving and coming home offers the unfinished test back.
  await page.goto("/en");
  await expect(page.getByText("Pick up where you left off")).toBeVisible();
  await page.getByRole("link", { name: "Continue test" }).click();
  await expect(page).toHaveURL(new RegExp(attemptUrl.split("/quiz/")[1]));
});
