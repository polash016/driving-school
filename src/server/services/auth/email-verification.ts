import type { PrismaClient } from "@prisma/client";
import { env } from "@/lib/env";
import { absoluteUrl } from "@/lib/locale-url";
import { AUDIT, auditLog } from "@/server/audit";
import { sendMail } from "@/server/email/mailer";
import { verificationEmail } from "@/server/email/templates";
import { normalizeEmail } from "./crypto";
import type { SessionContext } from "./sessions";
import { consumeAuthToken, issueAuthToken } from "./tokens";

/** Email verification (spec-03). A student cannot log in before verifying. */

export async function verifyEmail(
  db: PrismaClient,
  token: string,
  ctx: SessionContext = {},
  now: Date = new Date(),
): Promise<{ userId: string }> {
  const userId = await db.$transaction(async (tx) => {
    const id = await consumeAuthToken(tx, token, "EMAIL_VERIFY", now);
    await tx.user.update({
      where: { id },
      data: { emailVerifiedAt: now },
      select: { id: true },
    });
    return id;
  });

  await auditLog({
    actorId: userId,
    action: AUDIT.emailVerified,
    entityType: "User",
    entityId: userId,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });
  return { userId };
}

/**
 * Re-sends the verification link. Always reports success to the caller — an unverified
 * address must not be distinguishable from an unknown one.
 */
export async function resendVerification(
  db: PrismaClient,
  rawEmail: string,
  now: Date = new Date(),
): Promise<void> {
  const email = normalizeEmail(rawEmail);
  const user = await db.user.findUnique({
    where: { email },
    select: {
      id: true,
      emailVerifiedAt: true,
      isActive: true,
      deletedAt: true,
      profile: { select: { firstName: true, preferredLocale: true } },
    },
  });
  if (!user || user.emailVerifiedAt || !user.isActive || user.deletedAt) return;

  const locale = user.profile?.preferredLocale ?? "en";
  const { token } = await issueAuthToken(db, user.id, "EMAIL_VERIFY", now);
  const url = `${absoluteUrl(env().APP_BASE_URL, locale, "/verify-email")}?token=${token}`;
  await sendMail(
    await verificationEmail(locale, email, user.profile?.firstName ?? "", url),
  );
}
