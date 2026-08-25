import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import { hashSync } from "@node-rs/argon2";

/**
 * Spec-04 acceptance: "Keyboard-only review of 10 items possible without touching mouse", plus
 * the set view and accuracy dashboard the amendment added.
 *
 * The reviewer is an INSTRUCTOR: content review is that role's job, and it avoids the admin 2FA
 * gate that spec-03 (correctly) puts in front of every ADMIN login.
 */
const db = new PrismaClient();
const RUN = randomBytes(4).toString("hex");
const PASSWORD = "bratsberg-sving-42";
const instructorEmail = `reviewer-${RUN}@example.no`;
const secondReviewerEmail = `reviewer2-${RUN}@example.no`;
const REVIEW_COUNT = 10;

let topicId = "";
let batchId = "";

function content(index: number) {
  const options = [
    { key: "a", text: `Yield to the right ${index}` },
    { key: "b", text: `Continue ${index}` },
    { key: "c", text: `Stop ${index}` },
  ];
  return {
    en: {
      stem: `[${RUN}] Review question ${index}: who has right of way?`,
      options,
      explanation: "The right-hand rule applies.",
    },
    nb: {
      stem: `[${RUN}] Vurderingsspørsmål ${index}: hvem har forkjørsrett?`,
      options: options.map((option) => ({ ...option, text: `${option.text} (nb)` })),
      explanation: "Høyreregelen gjelder.",
    },
  };
}

test.beforeAll(async () => {
  for (const email of [instructorEmail, secondReviewerEmail]) {
    await db.user.create({
      data: {
        email,
        role: "INSTRUCTOR",
        passwordHash: hashSync(PASSWORD, { memoryCost: 19456, timeCost: 2, parallelism: 1 }),
        emailVerifiedAt: new Date(),
        profile: { create: { firstName: "Rev", lastName: RUN } },
      },
      select: { id: true },
    });
  }

  const topic = await db.topic.findFirstOrThrow({
    where: { parentId: null, deletedAt: null },
    select: { id: true },
  });
  topicId = topic.id;

  const batch = await db.generationBatch.create({
    data: {
      kind: "THEORY",
      status: "READY",
      topicId,
      requestedCount: REVIEW_COUNT,
      modelVersion: `e2e-model-${RUN}`,
      promptVersion: "generation.theory@1.0.0",
      notes: `e2e ${RUN}`,
    },
    select: { id: true },
  });
  batchId = batch.id;

  for (let index = 0; index < REVIEW_COUNT; index++) {
    await db.masterItem.create({
      data: {
        type: "TEXT",
        status: "IN_REVIEW",
        topicId,
        difficulty: 3,
        content: content(index),
        correctOptionKey: "a",
        legalCitations: [{ sourceCode: "trafikkreglene", ref: "§ 7" }],
        createdBy: "AI",
        modelVersion: `e2e-model-${RUN}`,
        promptVersion: "generation.theory@1.0.0",
        batchId,
      },
      select: { id: true },
    });
  }
});

test.afterAll(async () => {
  const items = await db.masterItem.findMany({
    where: { content: { path: ["en", "stem"], string_contains: RUN } },
    select: { id: true },
  });
  const ids = items.map((item) => item.id);
  await db.itemVariant.deleteMany({ where: { masterItemId: { in: ids } } });
  await db.masterItem.deleteMany({ where: { id: { in: ids } } });
  await db.generationBatch.deleteMany({ where: { id: batchId } });
  const users = await db.user.findMany({
    where: { email: { contains: RUN } },
    select: { id: true },
  });
  await db.auditLog.deleteMany({ where: { actorId: { in: users.map((u) => u.id) } } });
  await db.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
  await db.$disconnect();
});

async function login(
  page: import("@playwright/test").Page,
  email: string = instructorEmail,
) {
  await page.goto("/en/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/en$/);
}

test.describe.configure({ mode: "serial" });

test("two reviewers sign off ten AI questions with the keyboard alone", async ({ page }) => {
  // First reviewer: ten keystrokes, ten approvals recorded — nothing goes live yet, because an
  // AI-written question needs a second pair of eyes (spec-04b).
  await login(page);
  await page.goto(`/en/admin/review?batch=${batchId}`);
  await expect(page.getByRole("heading", { name: "Review queue" })).toBeVisible();
  await expect(page.getByText(`${REVIEW_COUNT} waiting`)).toBeVisible();

  for (let remaining = REVIEW_COUNT; remaining > 0; remaining--) {
    await expect(page.getByText(`${remaining} waiting`)).toBeVisible();
    await page.keyboard.press("a");
  }
  await expect(page.getByText("Nothing waiting for review.")).toBeVisible();

  expect(await db.masterItem.count({ where: { batchId, status: "APPROVED" } })).toBe(0);
  expect(await db.itemApproval.count({ where: { masterItem: { batchId } } })).toBe(REVIEW_COUNT);

  // Second reviewer: the same ten are waiting for them, and now they go live.
  await page.context().clearCookies();
  await login(page, secondReviewerEmail);
  await page.goto(`/en/admin/review?batch=${batchId}`);
  await expect(page.getByText(`${REVIEW_COUNT} waiting`)).toBeVisible();

  for (let remaining = REVIEW_COUNT; remaining > 0; remaining--) {
    // The counter is the synchronisation point: each keystroke is a server round trip, and
    // firing ten at once would race them.
    await expect(page.getByText(`${remaining} waiting`)).toBeVisible();
    await page.keyboard.press("a");
  }
  await expect(page.getByText("Nothing waiting for review.")).toBeVisible();

  // Approval published them: the engine can now serve every one (spec-04 D1).
  const approved = await db.masterItem.findMany({
    where: { batchId, status: "APPROVED" },
    select: { id: true, variants: { where: { isActive: true }, select: { id: true } } },
  });
  expect(approved).toHaveLength(REVIEW_COUNT);
  expect(approved.every((item) => item.variants.length === 1)).toBe(true);
});

test("shows the set with its acceptance rate", async ({ page }) => {
  await login(page);
  await page.goto("/en/admin/sets");
  await expect(page.getByRole("heading", { name: "Question sets" })).toBeVisible();

  await page.getByRole("link", { name: `e2e ${RUN}` }).click();
  await expect(page.getByRole("heading", { name: `Set · e2e ${RUN}` })).toBeVisible();
  await expect(page.getByText("100% accepted")).toBeVisible();
  await expect(page.getByText(`e2e-model-${RUN}`)).toBeVisible();

  // The AI controls are visible but inert until the pipeline lands (spec-06).
  await expect(page.getByRole("button", { name: "Revise with AI" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Generate more" })).toBeDisabled();
});

test("reports AI accuracy per model", async ({ page }) => {
  await login(page);
  await page.goto("/en/admin/questions/accuracy?groupBy=model&sinceDays=7");
  await expect(page.getByRole("heading", { name: "AI accuracy" })).toBeVisible();

  const row = page.getByRole("row", { name: new RegExp(`e2e-model-${RUN}`) });
  await expect(row).toContainText("100%");
  await expect(row).toContainText(String(REVIEW_COUNT));
});

test("browses and searches the question bank in both locales", async ({ page }) => {
  await login(page);
  await page.goto(`/en/admin/questions?search=${RUN}`);
  await expect(page.getByRole("heading", { name: "Question bank" })).toBeVisible();
  await expect(page.getByRole("link", { name: new RegExp("Review question 0") })).toBeVisible();

  await page.goto("/no/admin/questions");
  await expect(page.getByRole("heading", { name: "Spørsmålsbank" })).toBeVisible();
});
