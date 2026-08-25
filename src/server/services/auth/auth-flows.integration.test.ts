import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  AuthError,
  ConflictError,
  TotpSetupRequiredError,
  ValidationError,
} from "@/lib/errors";
import { db } from "@/server/db";
import { keys, redis } from "@/server/redis";
import { capturedMail, clearCapturedMail } from "@/server/email/mailer";
import type { SessionUser } from "@/server/authz";
import {
  completeTotpSetup,
  consumeLoginTicket,
  pendingTotpSetup,
  verifyCredentials,
} from "./credentials";
import { hashPassword } from "./password";
import { encryptSecret } from "./crypto";
import { importStudentsCsv } from "./csv-import";
import { resendVerification, verifyEmail } from "./email-verification";
import {
  consumeInvite,
  createInvite,
  previewInvite,
  revokeInvite,
} from "./invites";
import {
  changePassword,
  requestPasswordReset,
  resetPassword,
} from "./password-reset";
import { registerViaInvite } from "./registration";
import { isSessionValid, listSessions, revokeSession } from "./sessions";
import { currentTotpCode, generateTotpSecret } from "./totp";

/**
 * End-to-end auth flows against a real Postgres + Redis (spec-03).
 * Run: docker compose -f docker-compose.dev.yml up -d, TEST_DATABASE_URL set in .env.
 *
 * These are the tests that matter for the acceptance checklist: invite→register→verify→login,
 * concurrency on single-use invites, 2FA enforcement, revocation and reset.
 */
const enabled = Boolean(process.env.TEST_DATABASE_URL);
const d = describe.skipIf(!enabled);

/** Unique per run so parallel runs (and leftovers) can never collide. */
const RUN = randomUUID().slice(0, 8);
const email = (name: string) => `${name}-${RUN}@example.no`;
const PASSWORD = "bratsberg-sving-42";

/**
 * Each login in these tests comes from its own address: the 5/min/IP limiter is real, and
 * sharing one IP across the suite would (correctly) start blocking logins halfway through.
 */
const from = (userAgent = "Mozilla/5.0 (Linux; Android 13; Pixel 7)") => ({
  ip: `198.51.100.${Math.floor(Math.random() * 250) + 1}-${randomUUID()}`,
  userAgent,
});

let adminId: string;

async function makeAdmin(): Promise<string> {
  const user = await db.user.create({
    data: {
      email: email("owner"),
      role: "ADMIN",
      passwordHash: await hashPassword(PASSWORD),
      emailVerifiedAt: new Date(),
      profile: { create: { firstName: "Owner", lastName: "Admin" } },
    },
    select: { id: true },
  });
  return user.id;
}

async function tokenFor(
  userId: string,
  type: "EMAIL_VERIFY" | "PASSWORD_RESET",
) {
  return db.authToken.findFirst({
    where: { userId, type, consumedAt: null },
    orderBy: { createdAt: "desc" },
    select: { id: true, tokenHash: true },
  });
}

beforeEach(() => {
  clearCapturedMail();
});

afterAll(async () => {
  if (!enabled) return;
  // Delete in FK order; sessions, tokens and memberships cascade with the user.
  const userIds = (
    await db.user.findMany({
      where: { email: { contains: RUN } },
      select: { id: true },
    })
  ).map((user) => user.id);

  await db.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
  await db.inviteLink.deleteMany({ where: { createdById: { in: userIds } } });
  await db.studentGroup.deleteMany({ where: { createdById: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.$disconnect();
  await redis.quit().catch(() => undefined);
});

d("invites", () => {
  it("creates a single-use invite when maxUses is omitted", async () => {
    adminId ??= await makeAdmin();
    const invite = await createInvite(db, adminId, { role: "STUDENT" });

    expect(invite.maxUses).toBe(1);
    expect(invite.usedCount).toBe(0);
    expect(invite.url).toContain(`/en/register?invite=${invite.token}`);
    expect(invite.expiresAt).not.toBeNull();
  });

  it("previews a bound invite without leaking counts or ids", async () => {
    adminId ??= await makeAdmin();
    const bound = email("bound");
    const invite = await createInvite(
      db,
      adminId,
      { role: "STUDENT" },
      { email: bound },
    );

    expect(await previewInvite(db, invite.token)).toEqual({
      valid: true,
      email: bound,
      role: "STUDENT",
    });
    expect(await previewInvite(db, "no-such-token")).toEqual({
      valid: false,
      email: null,
      role: "STUDENT",
    });
  });

  it("lets exactly one of two concurrent registrations claim a single-use invite", async () => {
    adminId ??= await makeAdmin();
    const invite = await createInvite(db, adminId, {
      role: "STUDENT",
      maxUses: 1,
    });

    const results = await Promise.allSettled([
      registerViaInvite(db, {
        inviteToken: invite.token,
        email: email("race-a"),
        password: PASSWORD,
        firstName: "Race",
        lastName: "A",
        preferredLocale: "en",
      }),
      registerViaInvite(db, {
        inviteToken: invite.token,
        email: email("race-b"),
        password: PASSWORD,
        firstName: "Race",
        lastName: "B",
        preferredLocale: "nb",
      }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(
      ConflictError,
    );

    const row = await db.inviteLink.findUniqueOrThrow({
      where: { token: invite.token },
      select: { usedCount: true },
    });
    expect(row.usedCount).toBe(1);
  });

  it("rejects revoked, expired and mis-addressed invites with distinct messages", async () => {
    adminId ??= await makeAdmin();

    const revoked = await createInvite(db, adminId, { role: "STUDENT" });
    await revokeInvite(db, adminId, revoked.id);
    const expired = await createInvite(db, adminId, {
      role: "STUDENT",
      expiresInDays: 1,
    });
    const bound = await createInvite(
      db,
      adminId,
      { role: "STUDENT" },
      { email: email("someone-else") },
    );
    const future = new Date(Date.now() + 3 * 86_400_000);

    await expect(
      db.$transaction((tx) =>
        consumeInvite(tx, db.inviteLink.fields, revoked.token, email("x")),
      ),
    ).rejects.toMatchObject({ messageKey: "auth.errors.inviteInvalid" });

    await expect(
      db.$transaction((tx) =>
        consumeInvite(
          tx,
          db.inviteLink.fields,
          expired.token,
          email("x"),
          future,
        ),
      ),
    ).rejects.toMatchObject({ messageKey: "auth.errors.inviteExpired" });

    await expect(
      db.$transaction((tx) =>
        consumeInvite(tx, db.inviteLink.fields, bound.token, email("intruder")),
      ),
    ).rejects.toMatchObject({ messageKey: "auth.errors.inviteEmailMismatch" });
  });
});

d("registration and verification", () => {
  it("creates the account, joins the group, mails a link and blocks login until verified", async () => {
    adminId ??= await makeAdmin();
    const group = await db.studentGroup.create({
      data: { name: `Class ${RUN}`, createdById: adminId },
      select: { id: true },
    });
    const invite = await createInvite(db, adminId, {
      role: "STUDENT",
      groupId: group.id,
    });
    const studentEmail = email("student");

    const registered = await registerViaInvite(db, {
      inviteToken: invite.token,
      email: studentEmail.toUpperCase(),
      password: PASSWORD,
      firstName: "Kari",
      lastName: "Nordmann",
      preferredLocale: "nb",
    });

    const user = await db.user.findUniqueOrThrow({
      where: { id: registered.userId },
      select: {
        email: true,
        role: true,
        emailVerifiedAt: true,
        passwordHash: true,
        profile: { select: { firstName: true, preferredLocale: true } },
        memberships: { select: { groupId: true } },
      },
    });

    expect(user.email).toBe(studentEmail); // normalised to lowercase
    expect(user.role).toBe("STUDENT");
    expect(user.emailVerifiedAt).toBeNull();
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    expect(user.profile?.preferredLocale).toBe("nb");
    expect(user.memberships.map((m) => m.groupId)).toEqual([group.id]);

    // The Norwegian template, addressed to the student, carrying the verification link.
    const [mail] = capturedMail();
    expect(mail.to).toBe(studentEmail);
    expect(mail.subject).toBe("Bekreft e-postadressen din");
    expect(mail.text).toContain(
      `/no/verify-email?token=${registered.verificationToken}`,
    );

    await expect(
      verifyCredentials(
        db,
        { email: studentEmail, password: PASSWORD },
        from(),
      ),
    ).rejects.toMatchObject({ messageKey: "auth.errors.emailNotVerified" });

    await verifyEmail(db, registered.verificationToken);
    const verified = await db.user.findUniqueOrThrow({
      where: { id: registered.userId },
      select: { emailVerifiedAt: true },
    });
    expect(verified.emailVerifiedAt).not.toBeNull();

    // Single use: the same link cannot be replayed.
    await expect(
      verifyEmail(db, registered.verificationToken),
    ).rejects.toBeInstanceOf(ValidationError);

    const audits = await db.auditLog.findMany({
      where: { actorId: registered.userId },
      select: { action: true },
    });
    expect(audits.map((a) => a.action).sort()).toEqual([
      "auth.email_verified",
      "auth.register",
      "invite.used",
    ]);
  });

  it("refuses a second account for the same address", async () => {
    adminId ??= await makeAdmin();
    const invite = await createInvite(db, adminId, {
      role: "STUDENT",
      maxUses: 5,
    });
    const dupe = email("dupe");
    const input = {
      inviteToken: invite.token,
      email: dupe,
      password: PASSWORD,
      firstName: "First",
      lastName: "Again",
      preferredLocale: "en" as const,
    };

    await registerViaInvite(db, input);
    await expect(registerViaInvite(db, input)).rejects.toMatchObject({
      messageKey: "auth.errors.emailAlreadyRegistered",
    });
  });

  it("re-sends verification silently for unknown or already-verified addresses", async () => {
    await resendVerification(db, email("ghost"));
    expect(capturedMail()).toHaveLength(0);
  });
});

d("login", () => {
  async function verifiedStudent(name: string) {
    const user = await db.user.create({
      data: {
        email: email(name),
        role: "STUDENT",
        passwordHash: await hashPassword(PASSWORD),
        emailVerifiedAt: new Date(),
        profile: { create: { firstName: "Test", lastName: "Student" } },
      },
      select: { id: true, email: true },
    });
    return user;
  }

  it("issues a one-time ticket that becomes exactly one session", async () => {
    const user = await verifiedStudent("login-ok");
    const { ticketId } = await verifyCredentials(
      db,
      { email: user.email, password: PASSWORD },
      { ...from(), ip: "203.0.113.10" },
    );

    const authenticated = await consumeLoginTicket(db, ticketId);
    expect(authenticated).toMatchObject({
      id: user.id,
      email: user.email,
      role: "STUDENT",
    });

    const session = await db.userSession.findUniqueOrThrow({
      where: { id: authenticated.sessionId },
      select: { userId: true, ip: true, userAgent: true, revokedAt: true },
    });
    expect(session).toMatchObject({
      userId: user.id,
      ip: "203.0.113.10",
      revokedAt: null,
    });
    expect(await isSessionValid(db, authenticated.sessionId)).toBe(true);

    // The ticket is spent: a replay cannot mint a second session.
    await expect(consumeLoginTicket(db, ticketId)).rejects.toBeInstanceOf(
      AuthError,
    );
  });

  it("gives the same generic error for a wrong password and an unknown address", async () => {
    const user = await verifiedStudent("login-wrong");

    await expect(
      verifyCredentials(
        db,
        { email: user.email, password: "totally-wrong-1" },
        from(),
      ),
    ).rejects.toMatchObject({ messageKey: "auth.errors.invalidCredentials" });
    await expect(
      verifyCredentials(
        db,
        { email: email("nobody"), password: PASSWORD },
        from(),
      ),
    ).rejects.toMatchObject({ messageKey: "auth.errors.invalidCredentials" });

    const failures = await db.auditLog.findMany({
      where: { action: "auth.login_failed", actorId: user.id },
      select: { meta: true },
    });
    expect(failures).toHaveLength(1);
    expect(failures[0].meta).toMatchObject({ reason: "password" });
  });

  it("refuses a deactivated account", async () => {
    const user = await verifiedStudent("login-disabled");
    await db.user.update({ where: { id: user.id }, data: { isActive: false } });

    await expect(
      verifyCredentials(db, { email: user.email, password: PASSWORD }, from()),
    ).rejects.toMatchObject({ messageKey: "auth.errors.accountDisabled" });
  });

  it("requires a fresh TOTP code when 2FA is on and rejects a replay", async () => {
    const secret = generateTotpSecret();
    const user = await db.user.create({
      data: {
        email: email("2fa"),
        role: "INSTRUCTOR",
        passwordHash: await hashPassword(PASSWORD),
        emailVerifiedAt: new Date(),
        totpSecret: encryptSecret(secret),
        profile: { create: { firstName: "Two", lastName: "Factor" } },
      },
      select: { id: true, email: true },
    });

    await expect(
      verifyCredentials(db, { email: user.email, password: PASSWORD }, from()),
    ).rejects.toMatchObject({ code: "TOTP_REQUIRED" });

    await expect(
      verifyCredentials(
        db,
        { email: user.email, password: PASSWORD, totpCode: "000000" },
        from(),
      ),
    ).rejects.toMatchObject({ messageKey: "auth.errors.totpInvalid" });

    const code = currentTotpCode(secret);
    const ok = await verifyCredentials(
      db,
      { email: user.email, password: PASSWORD, totpCode: code },
      from(),
    );
    expect(ok.ticketId).toBeTruthy();

    // Same code again inside its window → rejected as a replay.
    await expect(
      verifyCredentials(
        db,
        { email: user.email, password: PASSWORD, totpCode: code },
        from(),
      ),
    ).rejects.toMatchObject({ messageKey: "auth.errors.totpInvalid" });
    await redis.del(keys.totpUsed(user.id, code));
  });

  it("forces an admin without 2FA through enrolment before any session exists", async () => {
    const admin = await db.user.create({
      data: {
        email: email("admin-2fa"),
        role: "ADMIN",
        passwordHash: await hashPassword(PASSWORD),
        emailVerifiedAt: new Date(),
        profile: { create: { firstName: "New", lastName: "Admin" } },
      },
      select: { id: true, email: true },
    });

    const thrown = await verifyCredentials(
      db,
      { email: admin.email, password: PASSWORD },
      from(),
    ).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(TotpSetupRequiredError);
    const setupTicket = (thrown as TotpSetupRequiredError).ticketId;
    expect(await db.userSession.count({ where: { userId: admin.id } })).toBe(0);

    const pending = await pendingTotpSetup(db, setupTicket);
    expect(pending).toMatchObject({ userId: admin.id, email: admin.email });

    // A wrong code re-issues the setup ticket instead of restarting enrolment.
    const rejected = (await completeTotpSetup(db, setupTicket, "000000").catch(
      (error: unknown) => error,
    )) as AuthError;
    expect(rejected.messageKey).toBe("auth.errors.totpInvalid");
    expect(await pendingTotpSetup(db, setupTicket)).toBeNull();

    const retryTicket = String(
      (rejected.meta as { ticketId: string }).ticketId,
    );
    const login = await completeTotpSetup(
      db,
      retryTicket,
      currentTotpCode(pending!.secret),
    );

    const stored = await db.user.findUniqueOrThrow({
      where: { id: admin.id },
      select: { totpSecret: true },
    });
    expect(stored.totpSecret).toBeTruthy();
    expect(stored.totpSecret).not.toContain(pending!.secret);

    const authenticated = await consumeLoginTicket(db, login.ticketId);
    expect(authenticated.id).toBe(admin.id);
  });
});

d("sessions", () => {
  it("lists sessions, marks the current one and kills a revoked one immediately", async () => {
    const user = await db.user.create({
      data: {
        email: email("sessions"),
        role: "STUDENT",
        passwordHash: await hashPassword(PASSWORD),
        emailVerifiedAt: new Date(),
        profile: { create: { firstName: "Multi", lastName: "Device" } },
      },
      select: { id: true, email: true },
    });
    const session = async (agent: string) =>
      consumeLoginTicket(
        db,
        (
          await verifyCredentials(
            db,
            { email: user.email, password: PASSWORD },
            from(agent),
          )
        ).ticketId,
      );

    const phone = await session("Mozilla/5.0 (Linux; Android 13; Pixel 7)");
    const laptop = await session(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)",
    );

    const listed = await listSessions(db, user.id, phone.sessionId);
    expect(listed).toHaveLength(2);
    expect(listed.filter((s) => s.current)).toHaveLength(1);
    expect(listed.find((s) => s.current)?.id).toBe(phone.sessionId);

    const sessionUser: SessionUser = {
      id: user.id,
      role: "STUDENT",
      email: user.email,
    };
    await revokeSession(db, sessionUser, laptop.sessionId);

    expect(await isSessionValid(db, laptop.sessionId)).toBe(false);
    expect(await isSessionValid(db, phone.sessionId)).toBe(true);
    expect(await listSessions(db, user.id, phone.sessionId)).toHaveLength(1);
  });

  it("refuses to revoke someone else's session", async () => {
    const [owner, intruder] = await Promise.all([
      db.user.create({
        data: {
          email: email("owner-sess"),
          passwordHash: await hashPassword(PASSWORD),
          emailVerifiedAt: new Date(),
          profile: { create: { firstName: "A", lastName: "B" } },
        },
        select: { id: true, email: true },
      }),
      db.user.create({
        data: {
          email: email("intruder-sess"),
          passwordHash: await hashPassword(PASSWORD),
          emailVerifiedAt: new Date(),
          profile: { create: { firstName: "C", lastName: "D" } },
        },
        select: { id: true, email: true },
      }),
    ]);

    const victim = await consumeLoginTicket(
      db,
      (
        await verifyCredentials(
          db,
          { email: owner.email, password: PASSWORD },
          from(),
        )
      ).ticketId,
    );

    await expect(
      revokeSession(
        db,
        { id: intruder.id, role: "STUDENT", email: intruder.email },
        victim.sessionId,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await isSessionValid(db, victim.sessionId)).toBe(true);
  });
});

d("password reset", () => {
  it("mails a link, sets the new password, and signs every device out", async () => {
    const user = await db.user.create({
      data: {
        email: email("reset"),
        passwordHash: await hashPassword(PASSWORD),
        emailVerifiedAt: new Date(),
        profile: {
          create: { firstName: "Reset", lastName: "Me", preferredLocale: "en" },
        },
      },
      select: { id: true, email: true },
    });
    const session = await consumeLoginTicket(
      db,
      (
        await verifyCredentials(
          db,
          { email: user.email, password: PASSWORD },
          from(),
        )
      ).ticketId,
    );

    await requestPasswordReset(db, { email: user.email });
    const [mail] = capturedMail();
    expect(mail.subject).toBe("Reset your password");

    const token = mail.text.match(/token=([\w-]+)/)?.[1];
    expect(token).toBeTruthy();

    await resetPassword(db, { token: token!, password: "nytt-passord-2026" });

    await expect(
      verifyCredentials(db, { email: user.email, password: PASSWORD }, from()),
    ).rejects.toMatchObject({ messageKey: "auth.errors.invalidCredentials" });
    await expect(
      verifyCredentials(
        db,
        { email: user.email, password: "nytt-passord-2026" },
        from(),
      ),
    ).resolves.toMatchObject({ ticketId: expect.any(String) });
    expect(await isSessionValid(db, session.sessionId)).toBe(false);

    // Single use.
    await expect(
      resetPassword(db, { token: token!, password: "enda-et-passord-1" }),
    ).rejects.toMatchObject({ messageKey: "auth.errors.tokenInvalid" });
  });

  it("says nothing about unknown addresses", async () => {
    await requestPasswordReset(db, { email: email("nobody-here") });
    expect(capturedMail()).toHaveLength(0);
  });

  it("requires the current password to change it", async () => {
    const user = await db.user.create({
      data: {
        email: email("change-pw"),
        passwordHash: await hashPassword(PASSWORD),
        emailVerifiedAt: new Date(),
        profile: { create: { firstName: "Change", lastName: "Pw" } },
      },
      select: { id: true },
    });

    await expect(
      changePassword(db, user.id, "wrong-password-1", "nytt-passord-2026"),
    ).rejects.toBeInstanceOf(AuthError);
    await expect(
      changePassword(db, user.id, PASSWORD, "nytt-passord-2026"),
    ).resolves.toBeUndefined();
  });

  it("rejects an expired reset token", async () => {
    const user = await db.user.create({
      data: {
        email: email("expired-token"),
        passwordHash: await hashPassword(PASSWORD),
        emailVerifiedAt: new Date(),
        profile: { create: { firstName: "Old", lastName: "Token" } },
      },
      select: { id: true, email: true },
    });
    await requestPasswordReset(db, { email: user.email });
    const token = capturedMail()[0].text.match(/token=([\w-]+)/)?.[1];

    const row = await tokenFor(user.id, "PASSWORD_RESET");
    await db.authToken.update({
      where: { id: row!.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await expect(
      resetPassword(db, { token: token!, password: "nytt-passord-2026" }),
    ).rejects.toMatchObject({ messageKey: "auth.errors.tokenExpired" });
  });
});

d("CSV import", () => {
  it("invites new students, skips known and malformed rows, and mails each one", async () => {
    adminId ??= await makeAdmin();
    const existingEmail = email("already");
    await db.user.create({
      data: {
        email: existingEmail,
        passwordHash: await hashPassword(PASSWORD),
        profile: { create: { firstName: "Already", lastName: "Here" } },
      },
      select: { id: true },
    });

    const fresh = email("csv-new");
    const csv = [
      "email;firstName;lastName",
      `${fresh};Kari;Nordmann`,
      `${existingEmail};Already;Here`,
      "not-an-email;Broken;Row",
      `${fresh};Duplicate;Row`,
    ].join("\r\n");

    const result = await importStudentsCsv(db, adminId, {
      csv,
      expiresInDays: 7,
    });

    expect(result.invited).toBe(1);
    expect(result.skipped).toBe(3);
    expect(result.rows.map((row) => row.status)).toEqual([
      "invited",
      "exists",
      "invalid",
      "exists",
    ]);

    const mails = capturedMail();
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe(fresh);
    expect(mails[0].subject).toContain("Your invitation");

    const invite = await db.inviteLink.findFirstOrThrow({
      where: { email: fresh },
      select: { maxUses: true, role: true, expiresAt: true },
    });
    expect(invite).toMatchObject({ maxUses: 1, role: "STUDENT" });
  });

  it("rejects a file with no email column", async () => {
    adminId ??= await makeAdmin();
    await expect(
      importStudentsCsv(db, adminId, {
        csv: "name;phone\nKari;123",
        expiresInDays: 14,
      }),
    ).rejects.toMatchObject({ messageKey: "admin.invites.errors.csvNoEmail" });
  });
});
