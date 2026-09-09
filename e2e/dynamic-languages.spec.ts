import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import { expect, test } from "@playwright/test";

/**
 * The claim this spec exists to prove: a language added to a RUNNING deployment becomes routable,
 * with the right `lang` and `dir`, without a redeploy or a restart (spec-15).
 *
 * The server under test was built and started before this file ran, so the language genuinely did
 * not exist at build time — which is the only way to test this honestly.
 */
const db = new PrismaClient();
// playwright.config.ts loads .env, so REDIS_URL is the same instance the app uses.
const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  lazyConnect: true,
  maxRetriesPerRequest: 2,
});
const RUN = randomBytes(3).toString("hex");
// A real BCP-47 tag nobody else in the suite uses, so a parallel test cannot collide with it.
const CODE = `qa-${RUN}`.slice(0, 8);

test.afterAll(async () => {
  await db.language.deleteMany({ where: { code: CODE } });
  await redis.del("tp:i18n:registry").catch(() => undefined);
  await db.$disconnect();
  await redis.quit().catch(() => undefined);
});

test("a language added at runtime routes, with no redeploy", async ({
  page,
}) => {
  // The registry is memoised in the server process, so allow for the TTL to lapse.
  test.setTimeout(90_000);

  await page.goto(`/${CODE}`);
  // Before it exists, an unknown prefix is treated as a path under the default locale → 404.
  await expect(page.locator("body")).toContainText(/Page not found/i);

  await db.language.create({
    data: {
      code: CODE,
      englishName: "QA Test Language",
      nativeName: "QA اختبار",
      shortLabel: "QA",
      urlPrefix: `/${CODE}`,
      direction: "RTL",
      isBuiltIn: false,
      requiresApproval: true,
      studentVisible: false,
      sortOrder: 99,
    },
  });
  // Stands in for what the admin action does after writing the row: `invalidateRegistry()` clears
  // the process memo AND this key. From another process only the Redis half is reachable, so the
  // server picks the change up when its own memo lapses rather than instantly.
  await redis.del("tp:i18n:registry");

  await expect(async () => {
    const response = await page.goto(`/${CODE}`, {
      waitUntil: "domcontentloaded",
    });
    expect(response?.status()).toBe(200);
    await expect(page.locator("html")).toHaveAttribute("lang", CODE);
    // Direction comes from the language row — this is what makes Arabic possible at all.
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  }).toPass({ timeout: 75_000, intervals: [2_000] });

  // Nothing is translated, so every string reads English. That is the designed fallback, not a bug:
  // English is merged underneath every catalogue so a missing key can never reach a student as a
  // raw dotted path.
  await expect(page.locator("body")).toContainText(
    "Ready for your theory test",
  );
  await expect(page.locator("body")).not.toContainText(/\bhome\.title\b/);
});

test("a language that is not student-visible stays out of the switcher", async ({
  page,
}) => {
  await page.goto("/en");
  // Asserted against the header, not against one control's markup: the switcher is a segmented
  // control at two languages and a menu beyond that, and which one renders depends on how many the
  // school has published. The claim under test holds either way.
  const header = page.locator("header");
  await expect(header).toBeVisible();
  const menuTrigger = header.locator("button[aria-haspopup='menu']");
  if (await menuTrigger.count()) await menuTrigger.click();
  // es and ar exist in the database but are not finished, so students are not offered them.
  await expect(header).not.toContainText("Español");
  await expect(header).not.toContainText("العربية");
});
