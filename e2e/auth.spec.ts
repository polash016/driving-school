import { randomBytes, createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { hashSync } from "@node-rs/argon2";
import Redis from "ioredis";
import { TOTP, Secret } from "otpauth";

/**
 * Spec-03 acceptance: student invite → register → verify → login, and wrong-role access to
 * an admin route returning a bilingual 403.
 *
 * Requires the dev stack (docker compose -f docker-compose.dev.yml up -d): Postgres for
 * seeding, and mailpit — the verification link is read out of the actual email, because only
 * its sha256 hash is stored in the database.
 */
const db = new PrismaClient();
const MAILPIT = "http://localhost:8025";
const RUN = randomBytes(4).toString("hex");
const PASSWORD = "bratsberg-sving-42";

const emailFor = (name: string) => `${name}-${RUN}@example.no`;
const studentEmail = emailFor("student");
const instructorEmail = emailFor("instructor");
const adminEmail = emailFor("admin");

let inviteToken: string;

function hash(password: string): string {
  // Same parameters as src/server/services/auth/password.ts; verify() reads them back out.
  return hashSync(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
}

async function createUser(email: string, role: "INSTRUCTOR" | "ADMIN") {
  return db.user.create({
    data: {
      email,
      role,
      passwordHash: hash(PASSWORD),
      emailVerifiedAt: new Date(),
      profile: {
        create: {
          firstName: role === "ADMIN" ? "Admin" : "Instructor",
          lastName: RUN,
        },
      },
    },
    select: { id: true },
  });
}

/** Newest mail to `address`, as plain text. Polls: delivery is a fire-and-forget send. */
async function latestMailTo(
  request: APIRequestContext,
  address: string,
): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const list = await request.get(`${MAILPIT}/api/v1/messages?limit=50`);
    if (list.ok()) {
      const body = (await list.json()) as {
        messages: { ID: string; To: { Address: string }[] }[];
      };
      const match = body.messages.find((message) =>
        message.To.some(
          (to) => to.Address.toLowerCase() === address.toLowerCase(),
        ),
      );
      if (match) {
        const detail = await request.get(
          `${MAILPIT}/api/v1/message/${match.ID}`,
        );
        return ((await detail.json()) as { Text: string }).Text;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `No mail delivered to ${address} — is mailpit running on ${MAILPIT}?`,
  );
}

/**
 * Whether an admin is forced into 2FA is now a school policy (spec-03 amendment), so this spec
 * sets the policy it is testing instead of assuming the default. Redis caches it for 5 minutes,
 * so the key is cleared too.
 */
async function setAdminTwoFactorPolicy(required: boolean) {
  await db.setting.upsert({
    where: { key: "security.adminTwoFactorRequired" },
    create: {
      key: "security.adminTwoFactorRequired",
      value: { adminTwoFactorRequired: required },
    },
    update: { value: { adminTwoFactorRequired: required } },
    select: { key: true },
  });
  const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6399");
  await redis.del("tp:cfg:security");
  await redis.quit();
}

let previousPolicy: boolean | null = null;

test.beforeAll(async () => {
  const existing = await db.setting.findUnique({
    where: { key: "security.adminTwoFactorRequired" },
    select: { value: true },
  });
  previousPolicy =
    (existing?.value as { adminTwoFactorRequired?: boolean } | null)
      ?.adminTwoFactorRequired ?? null;
  await setAdminTwoFactorPolicy(true);

  const admin = await createUser(adminEmail, "ADMIN");
  await createUser(instructorEmail, "INSTRUCTOR");

  inviteToken = randomBytes(32).toString("base64url");
  await db.inviteLink.create({
    data: {
      token: inviteToken,
      role: "STUDENT",
      maxUses: 1,
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
      createdById: admin.id,
    },
  });
});

test.afterAll(async () => {
  // Leave the school's own policy exactly as it was.
  if (previousPolicy !== null) await setAdminTwoFactorPolicy(previousPolicy);
  else
    await db.setting.deleteMany({
      where: { key: "security.adminTwoFactorRequired" },
    });

  const users = await db.user.findMany({
    where: { email: { contains: RUN } },
    select: { id: true },
  });
  const userIds = users.map((user) => user.id);
  await db.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
  await db.inviteLink.deleteMany({ where: { createdById: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.$disconnect();
});

test.describe.configure({ mode: "serial" });

test("invite → register → verify email → log in", async ({ page, request }) => {
  await request.delete(`${MAILPIT}/api/v1/messages`);

  // 1. Registration is only reachable with the invite token.
  await page.goto("/en/register");
  await expect(
    page.getByRole("heading", { name: "Invitation required" }),
  ).toBeVisible();

  await page.goto(`/en/register?invite=${inviteToken}`);
  await expect(
    page.getByRole("heading", { name: "Create your account" }),
  ).toBeVisible();

  await page.getByLabel("First name").fill("Kari");
  await page.getByLabel("Last name").fill("Nordmann");
  await page.getByLabel("Email").fill(studentEmail);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("Check your email")).toBeVisible();

  // 2. The verification link arrives by email; only its hash is in the database.
  const mail = await latestMailTo(request, studentEmail);
  const link = mail.match(/https?:\/\/\S+\/verify-email\?token=[\w-]+/)?.[0];
  expect(link, "verification link in the email").toBeTruthy();
  const token = new URL(link!).searchParams.get("token")!;

  const stored = await db.authToken.findFirst({
    where: { tokenHash: createHash("sha256").update(token).digest("hex") },
    select: { type: true, consumedAt: true },
  });
  expect(stored).toMatchObject({ type: "EMAIL_VERIFY", consumedAt: null });

  // 3. Login is refused until the address is verified.
  await page.goto("/en/login");
  await page.getByLabel("Email").fill(studentEmail);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  // Scope to the form: Next's route announcer is also role="alert".
  await expect(page.locator("form").getByRole("alert")).toContainText(
    "Verify your email address first",
  );

  // 4. Confirm the address, then log in for real.
  await page.goto(`/en/verify-email?token=${token}`);
  await page.getByRole("button", { name: "Verifying your email" }).click();
  await expect(page.getByText("Email verified")).toBeVisible();

  await page.goto("/en/login");
  await page.getByLabel("Email").fill(studentEmail);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();

  await expect(page).toHaveURL(/\/en$/);
  // At the 390px design target the account links live behind the header menu (spec-16): four
  // inline text buttons overflowed the viewport on every signed-in page. Log out is still one
  // tap away, and this asserts the tap actually reaches it.
  await page.getByRole("button", { name: "Menu" }).click();
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
  await page.keyboard.press("Escape");

  // 5. The session is real: an authenticated-only page renders.
  await page.goto("/en/account/security");
  await expect(page.getByRole("heading", { name: "Security" })).toBeVisible();
  await expect(page.getByText("This device")).toBeVisible();
});

test("wrong role gets a bilingual 403 on admin routes", async ({ page }) => {
  await page.goto("/en/login");
  await page.getByLabel("Email").fill(instructorEmail);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/en$/);

  const english = await page.goto("/en/admin/invites");
  expect(english?.status()).toBe(403);
  await expect(
    page.getByRole("heading", { name: "You do not have access to this page" }),
  ).toBeVisible();

  const norwegian = await page.goto("/no/admin/invites");
  expect(norwegian?.status()).toBe(403);
  await expect(
    page.getByRole("heading", { name: "Du har ikke tilgang til denne siden" }),
  ).toBeVisible();
});

test("signed-out access to an account page returns 401 with a way in", async ({
  page,
}) => {
  const response = await page.goto("/en/account/security");
  expect(response?.status()).toBe(401);
  await expect(
    page.getByRole("heading", { name: "Please log in to continue" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to log in" })).toBeVisible();
});

test("admin must set up two-factor before a session exists, then can invite", async ({
  page,
}) => {
  await page.goto("/en/login");
  await page.getByLabel("Email").fill(adminEmail);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();

  await expect(page).toHaveURL(/\/en\/two-factor-setup$/);
  await expect(
    page.getByRole("heading", { name: "Set up two-factor authentication" }),
  ).toBeVisible();
  await expect(page.getByAltText(/QR code/i)).toBeVisible();

  // No session yet: enrolment must complete first.
  expect(await page.context().cookies()).not.toContainEqual(
    expect.objectContaining({ name: "authjs.session-token" }),
  );

  const secret = (await page.locator("p.font-mono").innerText()).trim();
  const code = new TOTP({
    secret: Secret.fromBase32(secret),
    digits: 6,
    period: 30,
  }).generate();

  await page.getByLabel("6-digit code").fill(code);
  await page.getByRole("button", { name: "Turn on two-factor" }).click();
  await expect(page).toHaveURL(/\/en$/);

  const stored = await db.user.findUniqueOrThrow({
    where: { email: adminEmail },
    select: { totpSecret: true },
  });
  expect(stored.totpSecret).toBeTruthy();
  expect(stored.totpSecret).not.toContain(secret); // encrypted at rest

  // The admin surface is reachable now, and can mint an invite link.
  const response = await page.goto("/en/admin/invites");
  expect(response?.status()).toBe(200);
  await page.getByRole("button", { name: "Create invitation" }).click();
  await expect(page.getByText("Invitation created.")).toBeVisible();
  await expect(page.getByText(/\/en\/register\?invite=/).first()).toBeVisible();
});
