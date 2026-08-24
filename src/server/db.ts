import { PrismaClient } from "@prisma/client";

/**
 * Prisma client singleton (survives Next.js dev hot-reload).
 * Services receive this via import; tests construct their own client/mocks.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["warn", "error"]
        : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
