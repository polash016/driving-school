import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { hashSync } from "@node-rs/argon2";
import { TOTP, Secret } from "otpauth";

/**
 * The language board after spec-20: adding a language starts it translating, the card says where
 * the language stands in one line, and the switches read right in both admin languages at 390 px.
 *
 * The admin enrols two-factor on first login when the school's policy demands it (spec-03) —
 * the same flow auth.spec.ts proves — so this spec works under either setting.
 */
const db = new PrismaClient();
const RUN = randomBytes(3).toString("hex");
const PASSWORD = "bratsberg-sving-42";
const adminEmail = `board-admin-${RUN}@example.no`;
const CODE = `qc-${RUN}`.slice(0, 8);
const NAME = `Board ${RUN}`;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await db.user.create({
    data: {
      email: adminEmail,
      role: "ADMIN",
      passwordHash: hashSync(PASSWORD, {
        memoryCost: 19456,
        timeCost: 2,
        parallelism: 1,
      }),
      emailVerifiedAt: new Date(),
      profile: { create: { firstName: "Board", lastName: RUN } },
    },
    select: { id: true },
  });
});

test.afterAll(async () => {
  await db.translation.deleteMany({ where: { locale: CODE } });
  await db.translationMemory.deleteMany({ where: { locale: CODE } });
  await db.translationJob.deleteMany({ where: { run: { locale: CODE } } });
  await db.translationRun.deleteMany({ where: { locale: CODE } });
  await db.language.deleteMany({ where: { code: CODE } });
  const users = await db.user.findMany({
    where: { email: adminEmail },
    select: { id: true },
  });
  const ids = users.map((user) => user.id);
  await db.auditLog.deleteMany({ where: { actorId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  await db.$disconnect();
});

async function loginAsAdmin(page: Page) {
  await page.goto("/en/login");
  await page.getByLabel("Email").fill(adminEmail);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await page.waitForURL(/\/en(\/two-factor-setup)?$/);
  if (/two-factor-setup/.test(page.url())) {
    const secret = (await page.locator("p.font-mono").innerText()).trim();
    const code = new TOTP({
      secret: Secret.fromBase32(secret),
      digits: 6,
      period: 30,
    }).generate();
    await page.getByLabel("6-digit code").fill(code);
    await page.getByRole("button", { name: "Turn on two-factor" }).click();
  }
  await expect(page).toHaveURL(/\/en$/);
}

test("adding a language starts it translating, and the card says so in both languages", async ({
  page,
}) => {
  await loginAsAdmin(page);
  await page.goto("/en/admin/languages");
  await page.getByRole("button", { name: "Add a language" }).click();

  // No worker runs under e2e: the form says the first run will wait for one.
  await expect(page.getByText(/background worker is offline/i)).toBeVisible();
  // The two defaults the decision fixed: translate automatically, publish machine output.
  await expect(page.getByLabel("Keep translated automatically")).toBeChecked();
  await expect(page.getByLabel(/A person must approve/)).not.toBeChecked();

  await page.getByLabel("Language code").fill(CODE);
  await page.getByLabel("Switcher label").fill("QC");
  await page.getByLabel("Name in English").fill(NAME);
  await page.getByLabel("Name in the language itself").fill(NAME);
  await page.getByRole("button", { name: "Add", exact: true }).click();

  // The card: a FULL run is queued the moment the language exists, so the line reads "Translating…".
  const card = page.locator("li", { hasText: NAME });
  await expect(card).toBeVisible();
  await expect(card.getByText("Translating…")).toBeVisible();
  await expect(card.getByText("Publishes straight through")).toBeVisible();
  await expect(
    card.getByRole("button", { name: "Stop translating automatically" }),
  ).toBeVisible();

  const run = await db.translationRun.findFirst({
    where: { locale: CODE },
    select: { kind: true, enqueuedAt: true, plannedUnits: true },
  });
  expect(run?.kind).toBe("FULL");
  expect(run?.enqueuedAt).not.toBeNull();
  expect(run?.plannedUnits ?? 0).toBeGreaterThan(0);

  // The same card in Norwegian — nothing English leaks into the new line or the new switch.
  await page.goto("/no/admin/languages");
  const kort = page.locator("li", { hasText: NAME });
  await expect(kort.getByText("Oversetter …")).toBeVisible();
  await expect(
    kort.getByRole("button", { name: "Stopp automatisk oversetting" }),
  ).toBeVisible();

  // 390 px: the board must never scroll sideways.
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
});

test("the switches are reachable by keyboard and the submit keeps a visible focus ring", async ({
  page,
}) => {
  await loginAsAdmin(page);
  await page.goto("/en/admin/languages");
  await page.getByRole("button", { name: "Add a language" }).focus();
  await page.keyboard.press("Enter");

  const keep = page.getByLabel("Keep translated automatically");
  await keep.focus();
  await page.keyboard.press("Space");
  await expect(keep).not.toBeChecked();
  await page.keyboard.press("Space");
  await expect(keep).toBeChecked();

  // Tab from the checkbox lands on the style note, then the submit — and the ring is painted.
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  const add = page.getByRole("button", { name: "Add", exact: true });
  await expect(add).toBeFocused();
  const ring = await add.evaluate((element) => {
    const style = getComputedStyle(element);
    return style.boxShadow !== "none" || style.outlineStyle !== "none";
  });
  expect(ring).toBe(true);
});
