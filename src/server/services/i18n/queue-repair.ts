import type { PrismaClient } from "@prisma/client";
import { AUDIT, auditLog } from "@/server/audit";
import { planRepairRun } from "./repair";

/**
 * Hand a language's held rows to the repair run, unless a run is already live (spec-21).
 *
 * The same guard `startBackgroundRun` applies, kept here rather than imported: `run-control`
 * reaches `review.ts` through `sample.ts`, and `review.ts` is one of this helper's callers, so
 * importing it would close a runtime cycle. `repair.ts` imports neither.
 *
 * Returns the run id, or null when nothing was queued — a live run already holds the language,
 * or there was nothing under the repair ceiling to plan.
 */
export async function queueRepairIfIdle(
  db: PrismaClient,
  startedById: string | null,
  locale: string,
): Promise<string | null> {
  // Index: TranslationRun[locale, status, createdAt].
  const live = await db.translationRun.findFirst({
    where: {
      locale,
      enqueuedAt: { not: null },
      status: { in: ["PENDING", "RUNNING", "PAUSED"] },
      kind: { in: ["FULL", "SYNC", "SINGLE_ENTITY", "REPAIR"] },
    },
    select: { id: true },
  });
  if (live) return null;

  const plan = await planRepairRun(db, locale, { startedById });
  if (plan.plannedUnits === 0) {
    // An empty run would be claimed, "finished" and reported about nothing.
    await db.translationRun.update({
      where: { id: plan.runId },
      data: {
        status: "CANCELLED",
        error: "nothing to repair",
        enqueuedAt: null,
        finishedAt: new Date(),
      },
      select: { id: true },
    });
    return null;
  }
  await auditLog({
    actorId: startedById,
    action: AUDIT.translationRunEnqueued,
    entityType: "TranslationRun",
    entityId: plan.runId,
    meta: { locale, planned: plan.plannedUnits, kind: "REPAIR" },
  });
  return plan.runId;
}
