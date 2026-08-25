import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { logger } from "@/lib/logger";
import { AUDIT, auditLog } from "@/server/audit";
import type { SessionUser } from "@/server/authz";
import { cacheDel, keys } from "@/server/redis";

/**
 * Runtime security policy (spec-03 amendment, requested 2026-08-25).
 *
 * Two-factor authentication for ADMIN accounts was mandatory and unconditional. It is now a
 * deployment policy that an admin can turn off — but deliberately, from one place, with an audit
 * trail, and defaulting to ON.
 *
 * Worth being clear about what turning it off costs: an admin account approves the questions that
 * decide whether a student may sit the official test, and can read every student's record. With
 * 2FA off, a leaked or guessed password is all that stands in front of that.
 */

const SETTING_KEY = "security.adminTwoFactorRequired";

/**
 * Deliberately NOT cached.
 *
 * A read-through cache races with the write: a request that read the old value can populate the
 * cache *after* the update cleared it, and the stale value then survives for the whole TTL. That
 * was observed — the database said two-factor was off while Redis said on, and logins followed
 * Redis. For a security switch a stale answer is wrong in both directions (silently not requiring
 * 2FA is the dangerous one), and this is a single primary-key row read on a table with one row.
 * Correctness is worth more than the microsecond.
 */

export const securityPolicySchema = z
  .object({
    /** ADMIN accounts must enrol in 2FA and cannot disable it. */
    adminTwoFactorRequired: z.boolean(),
    /**
     * How many distinct reviewers must sign off an AI-drafted question before students see it.
     * Two is the safe default; a one-instructor school may need one, and that is their call to
     * make deliberately rather than a number buried in the code.
     */
    aiApprovalsRequired: z.int().min(1).max(3).default(2),
  })
  .strict();
export type SecurityPolicy = z.infer<typeof securityPolicySchema>;

export const DEFAULT_SECURITY_POLICY: SecurityPolicy = {
  adminTwoFactorRequired: true,
  aiApprovalsRequired: 2,
};

export async function getSecurityPolicy(
  db: PrismaClient,
): Promise<SecurityPolicy> {
  const row = await db.setting.findUnique({
    where: { key: SETTING_KEY },
    select: { value: true },
  });

  let policy = DEFAULT_SECURITY_POLICY;
  if (row) {
    const parsed = securityPolicySchema.safeParse(row.value);
    // A corrupt setting must not silently weaken security — fall back to the strict default.
    if (parsed.success) policy = parsed.data;
    else
      logger.error(
        { value: row.value },
        "security policy unreadable — using strict default",
      );
  }

  return policy;
}

export async function setSecurityPolicy(
  db: PrismaClient,
  actor: SessionUser,
  rawInput: unknown,
): Promise<SecurityPolicy> {
  const policy = securityPolicySchema.parse(rawInput);
  const previous = await getSecurityPolicy(db);

  await db.setting.upsert({
    where: { key: SETTING_KEY },
    create: { key: SETTING_KEY, value: policy, updatedById: actor.id },
    update: { value: policy, updatedById: actor.id },
    select: { key: true },
  });
  // Clear the key a previous version of this code may have left behind.
  await cacheDel(keys.securityPolicy());

  await auditLog({
    actorId: actor.id,
    action: AUDIT.securityPolicyChanged,
    entityType: "Setting",
    entityId: SETTING_KEY,
    meta: { from: previous, to: policy },
  });
  if (previous.adminTwoFactorRequired && !policy.adminTwoFactorRequired) {
    logger.warn(
      { actorId: actor.id },
      "admin two-factor requirement turned OFF",
    );
  }
  return policy;
}
