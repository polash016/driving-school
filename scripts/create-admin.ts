/**
 * Bootstrap an ADMIN account (spec-03).
 *
 *   pnpm auth:create-admin <email> [password]
 *
 * Without a password one is generated and printed once. The account is created verified, and
 * two-factor enrolment is forced at the first login (admins cannot log in without it).
 * Re-running for an existing address resets that account's password and role — it is the
 * "I locked myself out" path as well.
 */
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/server/services/auth/password";

(process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile?.(
  ".env",
);

const db = new PrismaClient();

async function main(): Promise<void> {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    throw new Error("Usage: pnpm auth:create-admin <email> [password]");
  }

  const generated = !process.argv[3];
  const password = process.argv[3] ?? randomBytes(12).toString("base64url");
  const passwordHash = await hashPassword(password);
  const now = new Date();

  const existing = await db.user.findUnique({
    where: { email },
    select: { id: true },
  });

  const user = await db.user.upsert({
    where: { email },
    create: {
      email,
      passwordHash,
      role: "ADMIN",
      emailVerifiedAt: now,
      isActive: true,
      profile: {
        create: { firstName: "Admin", lastName: email.split("@")[0] },
      },
    },
    update: {
      passwordHash,
      role: "ADMIN",
      emailVerifiedAt: now,
      isActive: true,
      deletedAt: null,
    },
    select: { id: true },
  });

  await db.auditLog.create({
    data: {
      action: "admin.created",
      entityType: "User",
      entityId: user.id,
      meta: { email, existed: Boolean(existing), via: "cli" },
    },
  });

  console.log(`${existing ? "Updated" : "Created"} ADMIN ${email}`);
  if (generated) console.log(`Password: ${password}`);
  console.log("Two-factor setup is required at the first login.");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
