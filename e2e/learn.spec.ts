import { randomBytes } from "node:crypto";
import { hashSync } from "@node-rs/argon2";
import { PrismaClient } from "@prisma/client";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * Learn, from the student's side (spec-23 C1, C4, C11): tile → hub → book → chapter → mark read
 * → next chapter → back to the book shows 1/2 → home shows the continue card; the same path from
 * the keyboard alone; the Norwegian strings; and a draft chapter answers 404.
 */
const db = new PrismaClient();
const RUN = randomBytes(4).toString("hex");
const EMAILS = { flow: `learn-f-${RUN}@example.no`, keyboard: `learn-k-${RUN}@example.no` } as const;
const PASSWORD = "bratsberg-sving-42";
let bookId = "";

const body = (n: number) => ({
  en: `## Section ${n}\n\n${"The rule, explained in plain words. ".repeat(12)}\n\n- one\n- two\n\n## Second heading\n\n${"More words about the same rule. ".repeat(12)}\n`,
  nb: `## Del ${n}\n\n${"Regelen, forklart med enkle ord. ".repeat(12)}\n\n- en\n- to\n\n## Andre overskrift\n\n${"Flere ord om samme regel. ".repeat(12)}\n`,
});

test.beforeAll(async () => {
  for (const email of Object.values(EMAILS)) {
    await db.user.create({
      data: {
        email,
        role: "STUDENT",
        emailVerifiedAt: new Date(),
        passwordHash: hashSync(PASSWORD, { memoryCost: 19456, timeCost: 2, parallelism: 1 }),
        profile: { create: { firstName: "Kari", lastName: RUN } },
      },
    });
  }
  const topic = await db.topic.findFirstOrThrow({ where: { parentId: null, deletedAt: null }, select: { id: true } });
  const book = await db.learnBook.create({
    data: { slug: `e2e-book-${RUN}`, title: { en: `Road book ${RUN}`, nb: `Vegbok ${RUN}` }, status: "PUBLISHED", publishedAt: new Date() },
  });
  bookId = book.id;
  const mk = (n: number, status: "PUBLISHED" | "DRAFT") =>
    db.learnDocument.create({
      data: {
        slug: `e2e-ch-${n}-${RUN}`,
        kind: "CHAPTER",
        bookId,
        chapterOrder: n,
        topicId: topic.id,
        title: { en: `Chapter ${n} ${RUN}`, nb: `Kapittel ${n} ${RUN}` },
        body: body(n),
        wordCount: { en: 120, nb: 120 },
        citations: [],
        status,
        publishedAt: status === "PUBLISHED" ? new Date() : null,
      },
    });
  await mk(1, "PUBLISHED");
  await mk(2, "PUBLISHED");
  await mk(3, "DRAFT");
  await db.learnDocument.create({
    data: {
      slug: `e2e-art-${RUN}`,
      kind: "ARTICLE",
      topicId: topic.id,
      title: { en: `Article ${RUN}`, nb: `Artikkel ${RUN}` },
      summary: { en: "A short one.", nb: "En kort en." },
      body: body(9),
      wordCount: { en: 120, nb: 120 },
      citations: [],
      status: "PUBLISHED",
      publishedAt: new Date(),
    },
  });
});

test.afterAll(async () => {
  const users = await db.user.findMany({ where: { email: { in: Object.values(EMAILS) } }, select: { id: true } });
  await db.learnReadingProgress.deleteMany({ where: { userId: { in: users.map((u) => u.id) } } });
  await db.learnDocument.deleteMany({ where: { OR: [{ bookId }, { slug: `e2e-art-${RUN}` }] } });
  await db.learnBook.delete({ where: { id: bookId } });
  await db.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
  await db.$disconnect();
});

async function login(page: Page, email: string) {
  await page.goto("/en/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/en$/);
}

test("tile → hub → book → chapter → mark read → next → back shows 1/2 → home continue card", async ({ page }) => {
  await login(page, EMAILS.flow);
  await page.getByRole("link", { name: /Learn/ }).first().click();
  await expect(page).toHaveURL(/\/en\/learn$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Learn");
  await expect(page.getByRole("link", { name: `Article ${RUN}` })).toBeVisible();

  await page.getByRole("link", { name: new RegExp(`Road book ${RUN}`) }).click();
  await expect(page).toHaveURL(new RegExp(`/learn/books/e2e-book-${RUN}$`));
  await expect(page.getByRole("listitem")).toHaveCount(2); // the draft chapter is not listed
  await page.getByRole("link", { name: "Start reading" }).click();
  await expect(page).toHaveURL(new RegExp(`/learn/read/e2e-ch-1-${RUN}$`));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Chapter 1 ${RUN}`);
  await expect(page.locator(".learn-prose h2").first()).toHaveText("Section 1");

  await page.getByRole("button", { name: "Mark as read" }).click();
  await expect(page.getByRole("button", { name: "Read" })).toBeDisabled();
  await page.getByRole("link", { name: "Next" }).click();
  await expect(page).toHaveURL(new RegExp(`/learn/read/e2e-ch-2-${RUN}$`));
  // Scroll partway so the second chapter is "in progress" for the continue card.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.5));
  await page.waitForTimeout(400);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

  await page.getByRole("link", { name: "Back to the book" }).click();
  await expect(page.getByText("1/2 read")).toBeVisible();

  await page.goto("/en");
  await expect(page.getByText("Continue reading")).toBeVisible();
  await expect(page.getByText(`Chapter 2 ${RUN}`)).toBeVisible();

  // A draft chapter is not served. With a streaming loading boundary the status is 200 and the
  // not-found boundary is what renders — so the assertion is on what the student sees.
  await page.goto(`/en/learn/read/e2e-ch-3-${RUN}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText('Page not found');
  await expect(page.getByText(`Chapter 3 ${RUN}`)).toHaveCount(0);
});

test("the same path works from the keyboard alone", async ({ page }) => {
  await login(page, EMAILS.keyboard);
  await page.goto("/en/learn");
  // Tab until the book card has focus, then Enter — matched by href, the one thing a card link
  // has that no header control shares.
  const tabTo = async (hrefPart: string) => {
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press("Tab");
      const href = await page.evaluate(() => (document.activeElement as HTMLAnchorElement | null)?.getAttribute("href") ?? "");
      if (href.includes(hrefPart)) return;
    }
    throw new Error(`no focusable link containing ${hrefPart}`);
  };
  await tabTo(`/learn/books/e2e-book-${RUN}`);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/learn/books/e2e-book-${RUN}$`));
  await tabTo(`/learn/read/e2e-ch-1-${RUN}`);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/learn/read/e2e-ch-1-${RUN}$`));
  await page.getByRole("button", { name: /Chapter 1 of 2/ }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByRole("button", { name: /Chapter 1 of 2/ })).toBeFocused();
});

test("Norwegian strings on the hub and the reader; no horizontal scroll at 390px", async ({ page }) => {
  await login(page, EMAILS.keyboard);
  await page.goto("/no/learn");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Lær");
  await expect(page.getByText("Bøker")).toBeVisible();
  await page.goto(`/no/learn/read/e2e-ch-1-${RUN}`);
  await expect(page.getByRole("button", { name: "Merk som lest" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
});

test("axe: no serious/critical violations on hub, book and reader, in both themes", async ({ page }) => {
  await login(page, EMAILS.keyboard);
  for (const path of ["/en/learn", `/en/learn/books/e2e-book-${RUN}`, `/en/learn/read/e2e-ch-1-${RUN}`]) {
    for (const theme of ["light", "dark"]) {
      await page.goto(path);
      await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      const blocking = results.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? ""));
      expect(blocking, `${path} (${theme}): ${blocking.map((v) => v.id).join(", ")}`).toEqual([]);
    }
  }
});
