import { db } from "@/server/db";
import { createAttemptService } from "@/server/services/quiz/attempt-service";
import { PrismaVariantSource } from "@/server/services/quiz/prisma-variant-source";
import { RedisSeenStore } from "@/server/services/quiz/redis-adapters";

/**
 * Composition root for the quiz engine (07-integration). One place builds the service with its
 * real adapters, so routes and pages never wire ports together themselves.
 */
export const attemptService = createAttemptService({
  db,
  variantSource: new PrismaVariantSource(db),
  seenStore: new RedisSeenStore(),
});
