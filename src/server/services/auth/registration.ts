import type { PrismaClient } from "@prisma/client";
import { ConflictError } from "@/lib/errors";
import { env } from "@/lib/env";
import { absoluteUrl } from "@/lib/locale-url";
import { AUDIT, auditLog } from "@/server/audit";
import { registerViaInviteInputSchema } from "@/server/contracts/auth";
import { sendMail } from "@/server/email/mailer";
import { verificationEmail } from "@/server/email/templates";
import { consumeInvite } from "./invites";
import { normalizeEmail } from "./crypto";
import { assertPasswordPolicy, hashPassword } from "./password";
import { issueAuthToken } from "./tokens";
import type { SessionContext } from "./sessions";

/**
 * Invite-only registration (spec-03: there is no open signup).
 *
 * The invite claim, the user row and the verification token are one transaction: a student
 * can never end up consuming an invite without an account, or with an account and no way in.
 */

export interface RegistrationResult {
  userId: string;
  email: string;
  /** Present only so tests and dev tooling can follow the link without an inbox. */
  verificationToken: string;
}

export async function registerViaInvite(
  db: PrismaClient,
  rawInput: unknown,
  ctx: SessionContext = {},
  now: Date = new Date(),
): Promise<RegistrationResult> {
  const input = registerViaInviteInputSchema.parse(rawInput);
  const email = normalizeEmail(input.email);
  assertPasswordPolicy(input.password, email);

  const passwordHash = await hashPassword(input.password);

  const { userId, verificationToken, inviteId } = await db.$transaction(async (tx) => {
    const invite = await consumeInvite(tx, db.inviteLink.fields, input.inviteToken, email, now);

    const existing = await tx.user.findUnique({
      where: { email },
      select: { id: true },
    });
    // Invite tokens are secrets, so a precise message here does not enable enumeration —
    // and the student needs to know to log in instead of registering again.
    if (existing) {
      throw new ConflictError({ email }, "auth.errors.emailAlreadyRegistered");
    }

    const user = await tx.user.create({
      data: {
        email,
        passwordHash,
        role: invite.role,
        profile: {
          create: {
            firstName: input.firstName.trim(),
            lastName: input.lastName.trim(),
            preferredLocale: input.preferredLocale,
          },
        },
        ...(invite.groupId
          ? { memberships: { create: { groupId: invite.groupId } } }
          : {}),
      },
      select: { id: true },
    });

    const token = await issueAuthToken(tx, user.id, "EMAIL_VERIFY", now);
    return { userId: user.id, verificationToken: token.token, inviteId: invite.id };
  });

  await auditLog({
    actorId: userId,
    action: AUDIT.authRegister,
    entityType: "User",
    entityId: userId,
    meta: { inviteId },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });
  await auditLog({
    actorId: userId,
    action: AUDIT.inviteUsed,
    entityType: "InviteLink",
    entityId: inviteId,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  const url = `${absoluteUrl(env().APP_BASE_URL, input.preferredLocale, "/verify-email")}?token=${verificationToken}`;
  await sendMail(
    await verificationEmail(input.preferredLocale, email, input.firstName.trim(), url),
  );

  return { userId, email, verificationToken };
}
