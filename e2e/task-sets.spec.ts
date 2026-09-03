import { randomBytes } from "node:crypto";
import { hashSync } from "@node-rs/argon2";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";

/**
 * Task sets (spec-16), end to end.
 *
 * Three things are proved here that unit tests cannot: the student can actually reach a set from
 * the homepage, the whole path works from a keyboard alone, and no page render carries the answer
 * key before the paper is handed in.
 */
const db = new PrismaClient();
const RUN = randomBytes(4).toString("hex");
// A user per test: these run in parallel workers, and a resumable attempt left open by one test
// would be picked up by another as a "Resume" tile rather than a "Start" one.
const EMAILS = {
  flow: `oppgave-f-${RUN}@example.no`,
  keyboard: `oppgave-k-${RUN}@example.no`,
  secrecy: `oppgave-s-${RUN}@example.no`,
} as const;
const PASSWORD = "bratsberg-sving-42";

test.beforeAll(async () => {
  for (const email of Object.values(EMAILS)) {
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
    where: { email: { in: Object.values(EMAILS) } },
    select: { id: true },
  });
  const ids = users.map((user) => user.id);
  const attempts = await db.examAttempt.findMany({
    where: { userId: { in: ids } },
    select: { id: true },
  });
  // Submitted attempts are protected by triggers — cleanup suspends them for THIS transaction
  // only, so a concurrent spec file cannot be left running without them.
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      "SET LOCAL session_replication_role = 'replica'",
    );
    await tx.examAttemptQuestion.deleteMany({
      where: { attemptId: { in: attempts.map((a) => a.id) } },
    });
    await tx.taskSetProgress.deleteMany({ where: { userId: { in: ids } } });
    await tx.examAttempt.deleteMany({
      where: { id: { in: attempts.map((a) => a.id) } },
    });
  });
  await db.auditLog.deleteMany({ where: { actorId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  await db.$disconnect();
});

async function publishedSets(): Promise<number> {
  return db.taskSet.count({ where: { status: "PUBLISHED" } });
}

async function logIn(page: Page, email: string): Promise<void> {
  await page.goto("/en/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/en$/);
}

test("home → grid → sheet → sit a set, at 390px with no horizontal scroll", async ({
  page,
}) => {
  test.skip((await publishedSets()) === 0, "no published task sets");

  await logIn(page, EMAILS.flow);

  // The homepage's primary action is the task set hero.
  await page.getByRole("link", { name: /Task sets/ }).click();
  await expect(page).toHaveURL(/\/en\/task-sets$/);

  // Mandate: 390px is the design target, and the page must not scroll sideways at it.
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  const tile = page.getByRole("button", { name: /Open task set #1\b/ });
  await expect(tile).toBeVisible();
  // 44px minimum touch target.
  const box = await tile.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(box!.width).toBeGreaterThanOrEqual(44);

  await tile.click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  // The honest line about why a retry is not the same paper.
  await expect(sheet.getByText(/no two attempts are the same/i)).toBeVisible();

  await sheet.getByRole("button", { name: "Start", exact: true }).click();
  // Negative lookahead: /quiz/new matches a bare /quiz/<segment> too, so without
  // it this resolves instantly and captures the SETUP url as the attempt url.
  await page.waitForURL(/\/quiz\/(?!new)[^/]+$/);
  await expect(page.getByText(/Question 1 of \d+/)).toBeVisible();
});

test("the whole path works from the keyboard, and Esc returns focus to the tile", async ({
  page,
}) => {
  test.skip((await publishedSets()) === 0, "no published task sets");

  await logIn(page, EMAILS.keyboard);
  await page.goto("/en/task-sets");

  const label = "Open task set #1";
  // Tab to the first tile rather than clicking it — this is the path the a11y requirement covers.
  for (let i = 0; i < 30; i += 1) {
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() =>
      document.activeElement?.getAttribute("aria-label"),
    );
    if (focused?.startsWith(label)) break;
  }
  await expect(
    page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
  ).resolves.toContain(label);

  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  // Focus must move INTO the dialog, or a keyboard user is typing at the page behind it.
  await expect(
    page.evaluate(
      () => !!document.activeElement?.closest('[data-slot="sheet-content"]'),
    ),
  ).resolves.toBe(true);

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  // …and back to the tile that opened it, not to <body>.
  await expect(
    page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
  ).resolves.toContain(label);
});

test("a task set never ships the answer key before it is handed in", async ({
  page,
}) => {
  test.skip((await publishedSets()) === 0, "no published task sets");

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
      // a body that cannot be read tells us nothing either way
    }
  });

  await logIn(page, EMAILS.secrecy);
  await page.goto("/en/task-sets");
  await page.getByRole("button", { name: /Open task set #1\b/ }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Start", exact: true })
    .click();
  // Negative lookahead: /quiz/new matches a bare /quiz/<segment> too, so without
  // it this resolves instantly and captures the SETUP url as the attempt url.
  await page.waitForURL(/\/quiz\/(?!new)[^/]+$/);
  await expect(page.getByText(/Question 1 of \d+/)).toBeVisible();

  // Answer one question. A task set grades at submit, so unlike practice, NOTHING may reveal
  // correctness — not even a server action response.
  await page.getByRole("radio").first().click();
  await page.waitForTimeout(500);

  const leaks = seen.filter(
    (entry) =>
      !entry.url.includes("/_next/static/") &&
      /correctOptionKey/.test(entry.body),
  );
  expect(leaks.map((entry) => `${entry.method} ${entry.url}`)).toEqual([]);
});
