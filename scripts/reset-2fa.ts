/**
 * Clear a user's two-factor secret (spec-03 recovery path, DECISIONS 2026-08-24).
 *
 *   pnpm auth:reset-2fa <email>
 *
 * Requires server access by design: an admin who lost their authenticator asks the person who
 * operates the deployment. All of that user's sessions are revoked, and an ADMIN is forced
 * through enrolment again at the next login.
 */
import { PrismaClient } from "@prisma/client";

(process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile?.(
  ".env",
);

const db = new PrismaClient();

async function main(): Promise<void> {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email) throw new Error("Usage: pnpm auth:reset-2fa <email>");

  const user = await db.user.findUnique({
    where: { email },
    select: { id: true, role: true, totpSecret: true },
  });
  if (!user) throw new Error(`No user with email ${email}`);

  await db.user.update({
    where: { id: user.id },
    data: { totpSecret: null },
    select: { id: true },
  });
  const revoked = await db.userSession.updateMany({
    where: { userId: user.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  await db.auditLog.create({
    data: {
      action: "auth.2fa_reset",
      entityType: "User",
      entityId: user.id,
      meta: { email, via: "cli", sessionsRevoked: revoked.count },
    },
  });

  console.log(
    `Cleared two-factor for ${email} (${revoked.count} session(s) revoked).`,
  );
  console.log(
    user.role === "ADMIN"
      ? "Enrolment is forced at the next login."
      : "The user can enable two-factor again from Account → Security.",
  );
  console.log("Note: cached session flags in Redis expire within 5 minutes.");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
