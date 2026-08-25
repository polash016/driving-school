import { randomUUID } from "node:crypto";
import type { PrismaClient, Role } from "@prisma/client";
import {
  AuthError,
  TotpRequiredError,
  TotpSetupRequiredError,
} from "@/lib/errors";
import { AUDIT, auditLog } from "@/server/audit";
import { loginInputSchema, sessionUserSchema } from "@/server/contracts/auth";
import { keys, redis } from "@/server/redis";
import { rateLimit, resetRateLimit } from "@/server/rate-limit";
import { decryptSecret, emailRateKey, encryptSecret, normalizeEmail } from "./crypto";
import { verifyPassword } from "./password";
import { getSecurityPolicy } from "./security-policy";
import { createSession, type SessionContext } from "./sessions";
import { generateTotpSecret, verifyTotpCode } from "./totp";

/**
 * Login (spec-03). Auth.js is only cookie/JWT plumbing: this service performs every check and
 * hands back a ONE-TIME ticket that the credentials provider exchanges for a session
 * (DECISIONS 2026-08-24). That keeps error handling typed and bilingual, and hashes once.
 *
 * Every failure path returns the same generic message — "wrong password" and "no such account"
 * are indistinguishable to the caller (no user enumeration).
 */

const TICKET_TTL_SEC = 60;
const SETUP_TICKET_TTL_SEC = 600;
/** A used TOTP code cannot be replayed inside its validity window (±1 step + period). */
const TOTP_REPLAY_TTL_SEC = 90;

/**
 * Argon2id hash of a fixed string, verified when no account matches, so a wrong email costs
 * the same time as a wrong password (timing oracle).
 */
const TIMING_EQUALIZER_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$e2XHlWZcH5iz/NkmfOd4QQ$9EuaOK6X7TwkQ4/W74BF2SjgTtfmTa2JVlrWXhi64ZM";

interface Ticket {
  userId: string;
  purpose: "login" | "totp-setup";
  ip?: string | null;
  userAgent?: string | null;
}

async function issueTicket(ticket: Ticket, ttlSec: number): Promise<string> {
  const ticketId = randomUUID();
  await redis.set(keys.authTicket(ticketId), JSON.stringify(ticket), "EX", ttlSec);
  return ticketId;
}

/** GETDEL: a ticket is valid exactly once, even under concurrent use. */
async function claimTicket(
  ticketId: string,
  purpose: Ticket["purpose"],
): Promise<Ticket> {
  const raw = await redis.getdel(keys.authTicket(ticketId));
  if (!raw) throw new AuthError({ reason: "ticket" }, "auth.errors.sessionExpired");
  const ticket = JSON.parse(raw) as Ticket;
  if (ticket.purpose !== purpose) {
    throw new AuthError({ reason: "ticket purpose" }, "auth.errors.sessionExpired");
  }
  return ticket;
}

export interface LoginTicket {
  ticketId: string;
}

export async function verifyCredentials(
  db: PrismaClient,
  rawInput: unknown,
  ctx: SessionContext = {},
  now: Date = new Date(),
): Promise<LoginTicket> {
  const input = loginInputSchema.parse(rawInput);
  const email = normalizeEmail(input.email);

  await rateLimit("loginIp", ctx.ip ?? "unknown");
  await rateLimit("loginEmail", emailRateKey(email));

  const user = await db.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      role: true,
      passwordHash: true,
      isActive: true,
      deletedAt: true,
      emailVerifiedAt: true,
      totpSecret: true,
    },
  });

  const passwordOk = await verifyPassword(
    user?.passwordHash ?? TIMING_EQUALIZER_HASH,
    input.password,
  );
  if (!user || !user.passwordHash || !passwordOk) {
    await auditLog({
      actorId: user?.id ?? null,
      action: AUDIT.authLoginFailed,
      entityType: "User",
      entityId: user?.id,
      meta: { reason: user ? "password" : "unknown-email" },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    throw new AuthError({ reason: "credentials" }, "auth.errors.invalidCredentials");
  }

  if (!user.isActive || user.deletedAt) {
    throw new AuthError({ userId: user.id }, "auth.errors.accountDisabled");
  }
  if (!user.emailVerifiedAt) {
    throw new AuthError({ userId: user.id }, "auth.errors.emailNotVerified");
  }

  if (user.totpSecret) {
    await assertTotpCode(db, user.id, user.totpSecret, input.totpCode, ctx, now);
  } else if (user.role === "ADMIN" && (await getSecurityPolicy(db)).adminTwoFactorRequired) {
    // Mandatory 2FA for admins — unless the school has deliberately turned that policy off.
    throw new TotpSetupRequiredError(
      await beginTotpSetup(user.id, ctx),
      { userId: user.id },
    );
  }

  await resetRateLimit("loginIp", ctx.ip ?? "unknown");
  await resetRateLimit("loginEmail", emailRateKey(email));

  return {
    ticketId: await issueTicket(
      { userId: user.id, purpose: "login", ip: ctx.ip, userAgent: ctx.userAgent },
      TICKET_TTL_SEC,
    ),
  };
}

async function assertTotpCode(
  db: PrismaClient,
  userId: string,
  encryptedSecret: string,
  code: string | undefined,
  ctx: SessionContext,
  now: Date,
): Promise<void> {
  if (!code) throw new TotpRequiredError({ userId });
  await rateLimit("totpUser", userId);

  const valid = verifyTotpCode(decryptSecret(encryptedSecret), code, now);
  // A correct code is single-use: replaying it inside its window is rejected.
  const fresh = valid
    ? await redis.set(keys.totpUsed(userId, code), "1", "EX", TOTP_REPLAY_TTL_SEC, "NX")
    : null;

  if (!valid || fresh !== "OK") {
    await auditLog({
      actorId: userId,
      action: AUDIT.authLoginFailed,
      entityType: "User",
      entityId: userId,
      meta: { reason: valid ? "totp-replay" : "totp" },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    throw new AuthError({ userId }, "auth.errors.totpInvalid");
  }
}

/** Stores a pending (unconfirmed) secret and returns the ticket that completes enrolment. */
async function beginTotpSetup(
  userId: string,
  ctx: SessionContext,
): Promise<string> {
  const secret = generateTotpSecret();
  await redis.set(
    keys.totpSetup(userId),
    encryptSecret(secret),
    "EX",
    SETUP_TICKET_TTL_SEC,
  );
  return issueTicket(
    { userId, purpose: "totp-setup", ip: ctx.ip, userAgent: ctx.userAgent },
    SETUP_TICKET_TTL_SEC,
  );
}

/**
 * The pending secret behind a setup ticket, for rendering the QR code. Peeks at the ticket
 * (no GETDEL) — it is consumed only when the code is confirmed.
 */
export async function pendingTotpSetup(
  db: PrismaClient,
  ticketId: string,
): Promise<{ userId: string; email: string; secret: string } | null> {
  const raw = await redis.get(keys.authTicket(ticketId));
  if (!raw) return null;
  const ticket = JSON.parse(raw) as Ticket;
  if (ticket.purpose !== "totp-setup") return null;

  const encrypted = await redis.get(keys.totpSetup(ticket.userId));
  if (!encrypted) return null;
  const user = await db.user.findUnique({
    where: { id: ticket.userId },
    select: { email: true },
  });
  if (!user) return null;

  return { userId: ticket.userId, email: user.email, secret: decryptSecret(encrypted) };
}

/**
 * Finishes forced admin enrolment: confirms the code, persists the encrypted secret and
 * returns a login ticket, so the admin lands signed in.
 */
export async function completeTotpSetup(
  db: PrismaClient,
  ticketId: string,
  code: string,
  ctx: SessionContext = {},
  now: Date = new Date(),
): Promise<LoginTicket> {
  const ticket = await claimTicket(ticketId, "totp-setup");
  await rateLimit("totpUser", ticket.userId);

  const encrypted = await redis.get(keys.totpSetup(ticket.userId));
  if (!encrypted) {
    throw new AuthError({ reason: "setup expired" }, "auth.errors.sessionExpired");
  }
  const secret = decryptSecret(encrypted);
  if (!verifyTotpCode(secret, code, now)) {
    // Re-issue the ticket so a mistyped code does not restart the whole enrolment.
    throw new AuthError(
      { ticketId: await issueTicket(ticket, SETUP_TICKET_TTL_SEC) },
      "auth.errors.totpInvalid",
    );
  }

  await db.user.update({
    where: { id: ticket.userId },
    data: { totpSecret: encrypted },
    select: { id: true },
  });
  await redis.del(keys.totpSetup(ticket.userId));
  await auditLog({
    actorId: ticket.userId,
    action: AUDIT.twoFactorEnabled,
    entityType: "User",
    entityId: ticket.userId,
    meta: { forced: true },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  return {
    ticketId: await issueTicket(
      { userId: ticket.userId, purpose: "login", ip: ctx.ip, userAgent: ctx.userAgent },
      TICKET_TTL_SEC,
    ),
  };
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: Role;
  sessionId: string;
}

/**
 * Exchanges a login ticket for a persisted session. Called ONLY by the Auth.js credentials
 * provider — the session row is created here so an abandoned ticket never leaves one behind.
 */
export async function consumeLoginTicket(
  db: PrismaClient,
  ticketId: string,
  now: Date = new Date(),
): Promise<AuthenticatedUser> {
  const ticket = await claimTicket(ticketId, "login");
  const user = await db.user.findUnique({
    where: { id: ticket.userId },
    select: { id: true, email: true, role: true, isActive: true, deletedAt: true },
  });
  if (!user || !user.isActive || user.deletedAt) {
    throw new AuthError({ userId: ticket.userId }, "auth.errors.accountDisabled");
  }

  const sessionId = await createSession(
    db,
    user.id,
    { ip: ticket.ip, userAgent: ticket.userAgent },
    now,
  );
  await auditLog({
    actorId: user.id,
    action: AUDIT.authLogin,
    entityType: "UserSession",
    entityId: sessionId,
    ip: ticket.ip,
    userAgent: ticket.userAgent,
  });

  const parsed = sessionUserSchema.parse({
    id: user.id,
    email: user.email,
    role: user.role,
  });
  return { ...parsed, sessionId };
}
