import type { PrismaClient, TranslationRunKind } from "@prisma/client";
import type { RunProgress } from "./runs";

/**
 * The i18n worker (spec-19), as pure functions with everything injected so the loop can be tested
 * without a process, a database or a clock. `scripts/i18n-worker.ts` wires the real ones in.
 *
 * Containment layers (spec-19 §The worker): 3 = a run that throws is FAILED and the loop moves on;
 * 4 = a tick that throws backs off exponentially and the loop never exits on its own.
 */

export interface FinishedRun {
  id: string;
  locale: string;
  kind: TranslationRunKind;
  status: string;
  startedById: string | null;
  translatedUnits: number;
  flaggedUnits: number;
  failedUnits: number;
  error: string | null;
}

export interface WorkerLog {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
}

export interface WorkerDeps {
  db: PrismaClient;
  leaseOwner: string;
  pollMs: number;
  signal: AbortSignal;
  /** Announce liveness (Redis key with TTL). Failures are logged, never fatal. */
  heartbeat: () => Promise<void>;
  /** executeRun bound to db — injected so the loop is testable without Postgres. */
  execute: (
    runId: string,
    options: {
      leaseOwner: string;
      signal: AbortSignal;
      onProgress?: (progress: RunProgress) => void;
    },
  ) => Promise<RunProgress>;
  /** Repair chaining + notifications, once a run reaches a terminal or paused state. */
  afterRun: (run: FinishedRun) => Promise<void>;
  log: WorkerLog;
}

const MAX_BACKOFF_MS = 5 * 60_000;

export function backoffMs(pollMs: number, consecutiveFailures: number): number {
  return Math.min(pollMs * 2 ** consecutiveFailures, MAX_BACKOFF_MS);
}

/** The next run to work: enqueued, not paused or cancelled, lease free or lapsed, oldest first. */
export async function findClaimableRun(db: PrismaClient, now: Date) {
  // Index: TranslationRun[status, leaseExpiresAt]; rows with enqueuedAt set are few.
  return db.translationRun.findFirst({
    where: {
      enqueuedAt: { not: null },
      status: { in: ["PENDING", "PAUSED", "RUNNING"] },
      // The same filter `executeRun`'s claim uses. An admin's pause has to hide the run from the
      // worker too, or it would be re-claimed on the very next tick.
      pauseRequested: false,
      cancelRequested: false,
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
      language: { isBuiltIn: false },
    },
    orderBy: { enqueuedAt: "asc" },
    select: { id: true, locale: true, kind: true },
  });
}

const FINISHED_SELECT = {
  id: true,
  locale: true,
  kind: true,
  status: true,
  startedById: true,
  translatedUnits: true,
  flaggedUnits: true,
  failedUnits: true,
  error: true,
} as const;

export async function workerTick(
  deps: WorkerDeps,
): Promise<"idle" | "worked" | "failed"> {
  await deps
    .heartbeat()
    .catch((error: unknown) =>
      deps.log.warn({ error }, "worker heartbeat failed"),
    );
  const candidate = await findClaimableRun(deps.db, new Date());
  if (!candidate) return "idle";

  deps.log.info(
    { runId: candidate.id, locale: candidate.locale, kind: candidate.kind },
    "claiming run",
  );
  try {
    const progress = await deps.execute(candidate.id, {
      leaseOwner: deps.leaseOwner,
      signal: deps.signal,
      onProgress: (p) =>
        deps.log.info(
          {
            runId: p.runId,
            completed: p.completed,
            planned: p.planned,
            failed: p.failed,
            flagged: p.flagged,
          },
          "progress",
        ),
    });
    deps.log.info(
      {
        runId: candidate.id,
        stopReason: progress.stopReason,
        status: progress.status,
      },
      "run returned",
    );
    // Nothing happened to this run: another runner owns it, or an admin asked it to stop. Neither
    // is a finish, so `afterRun` must not fire — it is what sends the "your language is ready" mail.
    if (
      progress.stopReason === "notClaimed" ||
      progress.stopReason === "localeBusy" ||
      progress.stopReason === "lostLease"
    )
      return "idle";
    const run = await deps.db.translationRun.findUniqueOrThrow({
      where: { id: candidate.id },
      select: FINISHED_SELECT,
    });
    await deps.afterRun(run);
    return "worked";
  } catch (error) {
    // Layer 3: this run is broken; the next language must not pay for it.
    const message =
      error instanceof Error ? error.message.slice(0, 300) : String(error);
    deps.log.error({ error, runId: candidate.id }, "run failed");
    await deps.db.translationRun.updateMany({
      where: { id: candidate.id, leaseOwner: deps.leaseOwner },
      data: {
        status: "FAILED",
        error: message,
        finishedAt: new Date(),
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
    const run = await deps.db.translationRun.findUniqueOrThrow({
      where: { id: candidate.id },
      select: FINISHED_SELECT,
    });
    await deps
      .afterRun(run)
      .catch((afterError: unknown) =>
        deps.log.error(
          { error: afterError, runId: candidate.id },
          "afterRun failed",
        ),
      );
    return "failed";
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Layer 4: never exits on its own. Only the signal ends it. */
export async function runWorker(deps: WorkerDeps): Promise<void> {
  let failures = 0;
  while (!deps.signal.aborted) {
    let wait = deps.pollMs;
    try {
      const outcome = await workerTick(deps);
      failures = 0;
      // After work there may be more (a chained repair run): look again at once.
      if (outcome === "worked") wait = 0;
    } catch (error) {
      failures += 1;
      wait = backoffMs(deps.pollMs, failures);
      deps.log.error(
        { error, failures, retryInMs: wait },
        "worker tick failed",
      );
    }
    await sleep(wait, deps.signal);
  }
  deps.log.info({}, "worker stopped");
}
