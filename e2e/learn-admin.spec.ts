import { randomBytes } from "node:crypto";
import { hashSync } from "@node-rs/argon2";
import { PrismaClient } from "@prisma/client";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/**
 * Learn authoring (spec-23 C5, C7), end to end: an instructor writes a book and a chapter,
 * previews the markdown, reorders with the keyboard-only controls, publishes, and every step
 * leaves an audit row.
 */
const db = new PrismaClient();
const RUN = randomBytes(4).toString("hex");
const instructorEmail = `learn-i-${RUN}@example.no`;
const PASSWORD = "bratsberg-sving-42";
let instructorId = "";


/** Seeding and cleanup bypass the service, so the public Learn cache must be told the world changed. */
async function bumpLearnVersion(): Promise<void> {
  const url = process.env.REDIS_URL;
  if (!url) return;
  const { default: Redis } = await import("ioredis");
  const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await redis.incr("tp:learn:version");
  } finally {
    await redis.quit().catch(() => undefined);
  }
}

test.beforeAll(async () => {
  await bumpLearnVersion();
  const user = await db.user.create({
    data: {
      email: instructorEmail,
      role: "INSTRUCTOR",
      passwordHash: hashSync(PASSWORD, { memoryCost: 19456, timeCost: 2, parallelism: 1 }),
      emailVerifiedAt: new Date(),
      profile: { create: { firstName: "Lær", lastName: RUN } },
    },
    select: { id: true },
  });
  instructorId = user.id;
});

test.afterAll(async () => {
  const books = await db.learnBook.findMany({ where: { slug: { contains: RUN } }, select: { id: true } });
  await db.learnDocument.deleteMany({ where: { OR: [{ slug: { contains: RUN } }, { bookId: { in: books.map((b) => b.id) } }] } });
  await db.learnBook.deleteMany({ where: { id: { in: books.map((b) => b.id) } } });
  await db.auditLog.deleteMany({ where: { actorId: instructorId } });
  await db.user.deleteMany({ where: { id: instructorId } });
  await bumpLearnVersion();
  await db.$disconnect();
});

test.describe.configure({ mode: "serial" });

test("an instructor writes a book with two chapters, reorders them and publishes", async ({ page }) => {
  await page.goto("/en/login");
  await page.getByLabel("Email").fill(instructorEmail);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/en$/);

  // The book.
  await page.goto("/en/admin/learn/books/new");
  await page.getByLabel("Title · EN").fill(`Theory book ${RUN}`);
  await page.getByLabel("Title · NO").fill(`Teoribok ${RUN}`);
  await expect(page.getByLabel("Slug")).toHaveValue(`theory-book-${RUN}`);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(/\/admin\/learn\/books\/[a-z0-9]+$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(`Theory book ${RUN}`);
  const bookId = page.url().split("/").pop()!;

  // Two chapters, the second with a heading and a list, previewed before saving.
  for (const [n, title] of [["1", "Right of way"], ["2", "Speed"]] as const) {
    await page.goto(`/en/admin/learn/articles/new?bookId=${bookId}&kind=CHAPTER`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Add chapter");
    await page.getByLabel("Title · EN").fill(`${title} ${RUN}`);
    await page.getByLabel("Title · NO").fill(`Kapittel ${n} ${RUN}`);
    await page.getByLabel("Text · EN").fill(`## ${title}\n\n- yield to the right\n- look twice\n`);
    await expect(page.locator(".learn-prose h2").first()).toHaveText(title);
    await page.getByRole("tab", { name: "Norwegian" }).click();
    await page.getByLabel("Text · NB").fill(`## Kapittel ${n}\n\nTekst.\n`);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page).toHaveURL(/\/admin\/learn\/articles\/[a-z0-9]+$/);
  }

  // Reorder with the keyboard-only controls, then save the order.
  await page.goto(`/en/admin/learn/books/${bookId}`);
  const list = page.getByRole("list").filter({ hasText: `Right of way ${RUN}` });
  await expect(list.getByRole("listitem").first()).toContainText("Right of way");
  await page.getByRole("button", { name: `Move Speed ${RUN} up` }).click();
  await expect(list.getByRole("listitem").first()).toContainText("Speed");
  await page.getByRole("button", { name: "Save order" }).click();
  await expect(page.getByText("Order saved")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("list").filter({ hasText: RUN }).getByRole("listitem").first()).toContainText("Speed");

  // Publish the book from its page, and a chapter from the list.
  await page.getByRole("button", { name: "Publish" }).first().click();
  await expect(page.getByText("Published").first()).toBeVisible();
  await page.goto(`/en/admin/learn?tab=CHAPTERS&search=${RUN}`);
  await expect(page.getByRole("row").filter({ hasText: `Speed ${RUN}` })).toBeVisible();
  await page.getByRole("row").filter({ hasText: `Speed ${RUN}` }).getByRole("button", { name: "Publish" }).click();
  await expect(page.getByRole("row").filter({ hasText: `Speed ${RUN}` }).getByText("Published")).toBeVisible();

  // Audit rows for every mutation.
  const actions = await db.auditLog.findMany({ where: { actorId: instructorId }, select: { action: true } });
  const set = new Set(actions.map((a) => a.action));
  expect(set).toContain("learn.book_upserted");
  expect(set).toContain("learn.document_upserted");
  expect(set).toContain("learn.chapters_reordered");
  expect(set).toContain("learn.book_transitioned");
  expect(set).toContain("learn.document_transitioned");

  const rows = await db.learnDocument.findMany({ where: { bookId }, select: { chapterOrder: true, status: true, slug: true }, orderBy: { chapterOrder: "asc" } });
  expect(rows.map((r) => r.chapterOrder)).toEqual([1, 2]);
  expect(rows[0]!.slug).toBe(`speed-${RUN}`);
});

test("the Norwegian admin list renders in Norwegian", async ({ page }) => {
  await page.goto("/en/login");
  await page.getByLabel("Email").fill(instructorEmail);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/en$/);
  await page.goto("/no/admin/learn?tab=BOOKS");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Lær");
  await expect(page.getByRole("tab", { name: "Bøker" })).toBeVisible();
});

test("axe: no serious/critical violations on the admin list and the editor", async ({ page }) => {
  await page.goto("/en/login");
  await page.getByLabel("Email").fill(instructorEmail);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/en$/);
  for (const path of ["/en/admin/learn", "/en/admin/learn/articles/new"]) {
    await page.goto(path);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    const blocking = results.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? ""));
    expect(blocking, `${path}: ${blocking.map((v) => v.id).join(", ")}`).toEqual([]);
  }
});
