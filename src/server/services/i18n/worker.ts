import type { PrismaClient, TranslationRunKind } from "@prisma/client";
// Runtime import, and safe: repair.ts reaches back to runs.ts with `import type` only, and nothing
// in either module's runtime graph imports the worker. No cycle.
import { MAX_REPAIR_ATTEMPTS, planRepairRun, repairCandidates } from "./repair";
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
    // Guarded like the failure path's: `afterRun` sends mail and plans the repair chain, and a
    // mail transport that throws must not make a run that finished cleanly be logged as failed
    // and re-reported. The run is already terminal here; nothing downstream can repair it.
    await deps
      .afterRun(run)
      .catch((afterError: unknown) =>
        deps.log.error(
          { error: afterError, runId: candidate.id },
          "afterRun failed",
        ),
      );
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

export type RepairDecision =
  | { action: "none" }
  | { action: "planned"; runId: string; planned: number }
  | { action: "exhausted"; remaining: number }
  | { action: "stalled" };

/** The database work `maybePlanRepair` needs, injected so the decision itself stays pure. */
export interface RepairPorts {
  candidates: () => Promise<number>;
  exhausted: () => Promise<number>;
  plan: () => Promise<{ runId: string; plannedUnits: number }>;
}

/**
 * After a run completes: repair what QA flagged, but never hot-loop. A repair that fixed nothing
 * (provider down, or nothing fixable) stops the chain; the admin re-enqueues once it is.
 *
 * That guard is the whole point. When the provider is down every repair batch fails, its jobs
 * exhaust their attempts and go SKIPPED, and the run still reaches COMPLETED — with
 * `translatedUnits: 0` and the same NEEDS_REVIEW rows still candidates, because `storeRepairs`
 * never ran and so never charged a `repairAttempts`. Nothing about the world changed, so planning
 * again would plan the identical run, and again, spamming audit rows and mail and burning the
 * recovery window in a tight loop. `translatedUnits - flaggedUnits <= 0` — no unit came back
 * clean — is exactly "this attempt moved nothing", and it ends the chain.
 */
export async function maybePlanRepair(
  run: FinishedRun,
  ports: RepairPorts,
): Promise<RepairDecision> {
  if (run.status !== "COMPLETED") return { action: "none" };
  if (!["SYNC", "FULL", "SINGLE_ENTITY", "REPAIR"].includes(run.kind))
    return { action: "none" };
  if (run.kind === "REPAIR" && run.translatedUnits - run.flaggedUnits <= 0)
    return { action: "stalled" };
  const candidates = await ports.candidates();
  if (candidates === 0) {
    const remaining = await ports.exhausted();
    return run.kind === "REPAIR" && remaining > 0
      ? { action: "exhausted", remaining }
      : { action: "none" };
  }
  const plan = await ports.plan();
  return { action: "planned", runId: plan.runId, planned: plan.plannedUnits };
}

export function repairPortsFor(
  db: PrismaClient,
  run: FinishedRun,
): RepairPorts {
  return {
    candidates: async () => (await repairCandidates(db, run.locale)).length,
    // Index: Translation[locale, status, createdAt] — locale + status lead; the rest filters a
    // handful of rows. What is left for a human once the machine has spent its three attempts.
    exhausted: () =>
      db.translation.count({
        where: {
          locale: run.locale,
          status: "NEEDS_REVIEW",
          entity: { not: "ITEM_VARIANT" },
          repairAttempts: { gte: MAX_REPAIR_ATTEMPTS },
        },
      }),
    plan: () => planRepairRun(db, run.locale, { startedById: run.startedById }),
  };
}

/**
 * What happens when a run reaches a terminal or paused state: chain the repair, then report.
 *
 * The mails themselves are still Task 21 — the seam stays here so the worker never grows a direct
 * dependency on either; it hands the finished row over and stops caring what is done with it.
 */
export function defaultAfterRun(deps: {
  db: PrismaClient;
  log: WorkerLog;
}): (run: FinishedRun) => Promise<void> {
  return async (run) => {
    const decision = await maybePlanRepair(run, repairPortsFor(deps.db, run));
    deps.log.info(
      {
        runId: run.id,
        locale: run.locale,
        kind: run.kind,
        status: run.status,
        decision,
      },
      "run finished",
    );
    // Task 21 adds: await notifyRunEvent(deps.db, run, decision);
  };
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
