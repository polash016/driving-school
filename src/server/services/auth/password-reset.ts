import type { PrismaClient } from "@prisma/client";
import { env } from "@/lib/env";
import { AuthError } from "@/lib/errors";
import { absoluteUrl } from "@/lib/locale-url";
import { AUDIT, auditLog } from "@/server/audit";
import {
  requestPasswordResetInputSchema,
  resetPasswordInputSchema,
} from "@/server/contracts/auth";
import { sendMail } from "@/server/email/mailer";
import { passwordResetEmail } from "@/server/email/templates";
import { normalizeEmail } from "./crypto";
import { assertPasswordPolicy, hashPassword, verifyPassword } from "./password";
import { revokeAllSessions, type SessionContext } from "./sessions";
import { consumeAuthToken, issueAuthToken } from "./tokens";

/**
 * Password reset and change (spec-03).
 *
 * `requestPasswordReset` is deliberately silent about whether the address exists — the caller
 * always shows "check your inbox" (no user enumeration).
 */

export async function requestPasswordReset(
  db: PrismaClient,
  rawInput: unknown,
  ctx: SessionContext = {},
  now: Date = new Date(),
): Promise<void> {
  const input = requestPasswordResetInputSchema.parse(rawInput);
  const email = normalizeEmail(input.email);

  const user = await db.user.findUnique({
    where: { email },
    select: {
      id: true,
      isActive: true,
      deletedAt: true,
      profile: { select: { firstName: true, preferredLocale: true } },
    },
  });

  await auditLog({
    actorId: user?.id ?? null,
    action: AUDIT.passwordResetRequested,
    entityType: "User",
    entityId: user?.id,
    meta: { known: Boolean(user) },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  if (!user || !user.isActive || user.deletedAt) return;

  const locale = user.profile?.preferredLocale ?? "en";
  const { token } = await issueAuthToken(db, user.id, "PASSWORD_RESET", now);
  const url = `${absoluteUrl(env().APP_BASE_URL, locale, "/reset-password")}?token=${token}`;
  await sendMail(
    await passwordResetEmail(locale, email, user.profile?.firstName ?? "", url),
  );
}

export async function resetPassword(
  db: PrismaClient,
  rawInput: unknown,
  ctx: SessionContext = {},
  now: Date = new Date(),
): Promise<{ userId: string }> {
  const input = resetPasswordInputSchema.parse(rawInput);

  const userId = await db.$transaction(async (tx) => {
    const id = await consumeAuthToken(tx, input.token, "PASSWORD_RESET", now);
    const user = await tx.user.findUniqueOrThrow({
      where: { id },
      select: { email: true },
    });
    assertPasswordPolicy(input.password, user.email);
    const passwordHash = await hashPassword(input.password);
    await tx.user.update({
      where: { id },
      // A reset also proves control of the inbox, so it verifies the address.
      data: { passwordHash, emailVerifiedAt: now },
      select: { id: true },
    });
    return id;
  });

  // Whoever held an old session may be the attacker — cut them all off.
  await revokeAllSessions(db, userId, { actorId: userId });
  await auditLog({
    actorId: userId,
    action: AUDIT.passwordReset,
    entityType: "User",
    entityId: userId,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });
  return { userId };
}

/** Signed-in password change: requires the current password and keeps the current session. */
export async function changePassword(
  db: PrismaClient,
  userId: string,
  currentPassword: string,
  newPassword: string,
  options: { currentSessionId?: string } & SessionContext = {},
): Promise<void> {
  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: { email: true, passwordHash: true },
  });
  if (!user.passwordHash || !(await verifyPassword(user.passwordHash, currentPassword))) {
    throw new AuthError({ userId }, "auth.errors.invalidCredentials");
  }
  assertPasswordPolicy(newPassword, user.email);

  await db.user.update({
    where: { id: userId },
    data: { passwordHash: await hashPassword(newPassword) },
    select: { id: true },
  });
  await revokeAllSessions(db, userId, {
    exceptSessionId: options.currentSessionId,
    actorId: userId,
  });
  await auditLog({
    actorId: userId,
    action: AUDIT.passwordChanged,
    entityType: "User",
    entityId: userId,
    ip: options.ip,
    userAgent: options.userAgent,
  });
}
