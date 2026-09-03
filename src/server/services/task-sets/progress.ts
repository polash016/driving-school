import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * Per-user standing on one task set (spec-16).
 *
 * `nextProgress` is pure so the rule that actually matters is testable without a database: **a
 * pass is permanent**. A student who clears #7 and then fails a retry still sees a green tile —
 * the retry is practice, and taking the pass away would punish them for practising. Everything
 * else here is bookkeeping; that one line is the product decision.
 *
 * The state is denormalized rather than derived because the grid needs pass state, best score and
 * attempt count for ~32 sets in a single render. Derived, that is a groupBy plus a correlated
 * best-score lookup per set; denormalized, it is one read on `TaskSetProgress_userId_idx`. It is
 * written inside the grading transaction, so it cannot drift from the attempts it summarises.
 */

export interface GradedRun {
  correctCount: number;
  outOf: number;
  passed: boolean;
  attemptId: string;
  at: Date;
}

export interface ProgressState {
  attempts: number;
  bestCorrect: number | null;
  bestOutOf: number | null;
  passedAt: Date | null;
  lastAttemptId: string | null;
  lastAttemptAt: Date | null;
}

export function nextProgress(
  current: ProgressState | null,
  run: GradedRun,
): ProgressState {
  // -1, not 0: a genuine zero is a score, and treating it as "no score yet" would let a later
  // zero silently overwrite nothing while reporting an empty best.
  const previousBest = current?.bestCorrect ?? -1;
  const beatsBest = run.correctCount > previousBest;

  return {
    attempts: (current?.attempts ?? 0) + 1,
    bestCorrect: beatsBest ? run.correctCount : (current?.bestCorrect ?? null),
    bestOutOf: beatsBest ? run.outOf : (current?.bestOutOf ?? null),
    // Set once, never cleared, and it records WHEN the set was cleared — not the best run.
    passedAt: (current?.passedAt ?? null) ?? (run.passed ? run.at : null),
    lastAttemptId: run.attemptId,
    lastAttemptAt: run.at,
  };
}

/**
 * Applied inside the grading transaction so progress can never disagree with the attempt table.
 * Takes a transaction client rather than the singleton for exactly that reason.
 */
export async function recordTaskSetRun(
  tx: Prisma.TransactionClient | PrismaClient,
  params: { userId: string; taskSetId: string; run: GradedRun },
): Promise<void> {
  const current = await tx.taskSetProgress.findUnique({
    where: {
      userId_taskSetId: {
        userId: params.userId,
        taskSetId: params.taskSetId,
      },
    },
    select: {
      attempts: true,
      bestCorrect: true,
      bestOutOf: true,
      passedAt: true,
      lastAttemptId: true,
      lastAttemptAt: true,
    },
  });

  const next = nextProgress(current, params.run);

  await tx.taskSetProgress.upsert({
    where: {
      userId_taskSetId: {
        userId: params.userId,
        taskSetId: params.taskSetId,
      },
    },
    create: {
      userId: params.userId,
      taskSetId: params.taskSetId,
      ...next,
    },
    update: next,
  });
}
