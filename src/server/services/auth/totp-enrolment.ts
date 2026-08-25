import type { PrismaClient } from "@prisma/client";
import QRCode from "qrcode";
import { AuthError, ForbiddenError, ValidationError } from "@/lib/errors";
import { AUDIT, auditLog } from "@/server/audit";
import { totpSetupSchema, type TotpSetup } from "@/server/contracts/auth";
import type { SessionUser } from "@/server/authz";
import { keys, redis } from "@/server/redis";
import { rateLimit } from "@/server/rate-limit";
import { decryptSecret, encryptSecret } from "./crypto";
import { verifyPassword } from "./password";
import { revokeAllSessions, type SessionContext } from "./sessions";
import { getSecurityPolicy } from "./security-policy";
import { generateTotpSecret, totpUri, verifyTotpCode } from "./totp";

/**
 * Self-service 2FA enrolment from the account security page (spec-03).
 * Required for ADMIN (enforced at login), optional for INSTRUCTOR, available to anyone.
 *
 * The candidate secret lives in Redis until a valid code proves the authenticator works —
 * an abandoned enrolment can never lock someone out.
 */

const SETUP_TTL_SEC = 600;

/** Renders an enrolment payload (URI + QR) for a secret that is already pending. */
export async function totpSetupPayload(
  secret: string,
  accountLabel: string,
): Promise<TotpSetup> {
  const otpauthUri = totpUri(secret, accountLabel);
  return totpSetupSchema.parse({
    secret,
    otpauthUri,
    qrDataUrl: await QRCode.toDataURL(otpauthUri, { margin: 1, width: 240 }),
  });
}

export async function startTotpEnrolment(
  db: PrismaClient,
  user: SessionUser,
): Promise<TotpSetup> {
  const secret = generateTotpSecret();
  // Invalidated by: confirmTotpEnrolment, or expiry after 10 minutes.
  await redis.set(keys.totpSetup(user.id), encryptSecret(secret), "EX", SETUP_TTL_SEC);
  return totpSetupPayload(secret, user.email);
}

export async function confirmTotpEnrolment(
  db: PrismaClient,
  user: SessionUser,
  code: string,
  ctx: SessionContext = {},
  now: Date = new Date(),
): Promise<void> {
  await rateLimit("totpUser", user.id);
  const encrypted = await redis.get(keys.totpSetup(user.id));
  if (!encrypted) {
    throw new ValidationError({ userId: user.id }, "auth.errors.sessionExpired");
  }
  if (!verifyTotpCode(decryptSecret(encrypted), code, now)) {
    throw new ValidationError({ userId: user.id }, "auth.errors.totpInvalid");
  }

  await db.user.update({
    where: { id: user.id },
    data: { totpSecret: encrypted },
    select: { id: true },
  });
  await redis.del(keys.totpSetup(user.id));
  await auditLog({
    actorId: user.id,
    action: AUDIT.twoFactorEnabled,
    entityType: "User",
    entityId: user.id,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });
}

/**
 * Turning 2FA off requires the password. ADMIN cannot: 2FA is mandatory for that role, and the
 * recovery path for a lost authenticator is `pnpm auth:reset-2fa` on the server.
 */
export async function disableTotp(
  db: PrismaClient,
  user: SessionUser,
  password: string,
  ctx: SessionContext & { currentSessionId?: string } = {},
): Promise<void> {
  if (user.role === "ADMIN" && (await getSecurityPolicy(db)).adminTwoFactorRequired) {
    throw new ForbiddenError({ userId: user.id }, "auth.errors.totpRequiredForAdmin");
  }
  const row = await db.user.findUniqueOrThrow({
    where: { id: user.id },
    select: { passwordHash: true },
  });
  if (!row.passwordHash || !(await verifyPassword(row.passwordHash, password))) {
    throw new AuthError({ userId: user.id }, "auth.errors.invalidCredentials");
  }

  await db.user.update({
    where: { id: user.id },
    data: { totpSecret: null },
    select: { id: true },
  });
  await revokeAllSessions(db, user.id, {
    exceptSessionId: ctx.currentSessionId,
    actorId: user.id,
  });
  await auditLog({
    actorId: user.id,
    action: AUDIT.twoFactorReset,
    entityType: "User",
    entityId: user.id,
    meta: { disabledBy: "self" },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });
}
