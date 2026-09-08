import type {
  PrismaClient,
  TranslatableEntity,
  TranslationRunKind,
} from "@prisma/client";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { AUDIT, auditLog } from "@/server/audit";
import type { SessionUser } from "@/server/authz";
import {
  ESTIMATED_USD_PER_1K_TOKENS,
  etaSeconds,
  heartbeatStale,
} from "./run-math";
import { planRepairRun } from "./repair";
import { planRun, type RunPlan } from "./runs";

/**
 * Spec-19: what an admin can do to a background run, and what the progress panel reads.
 * The worker never calls the mutations here; it reads the flags they set.
 */

const LIVE: TranslationRunKind[] = ["FULL", "SYNC", "SINGLE_ENTITY", "REPAIR"];

export async function startBackgroundRun(
  db: PrismaClient,
  actor: SessionUser,
  input: {
    locale: string;
    only?: TranslatableEntity[];
    kind?: TranslationRunKind;
  },
): Promise<RunPlan> {
  // Index: TranslationRun[locale, status, createdAt].
  const live = await db.translationRun.findFirst({
    where: {
      locale: input.locale,
      enqueuedAt: { not: null },
      status: { in: ["PENDING", "RUNNING", "PAUSED"] },
      kind: { in: LIVE },
    },
    select: { id: true },
  });
  if (live)
    throw new ConflictError(
      { locale: input.locale, runId: live.id },
      "admin.languages.errors.runActive",
    );

  // A repair is planned from the flagged rows, not from what is missing or stale, so it needs its
  // own planner. `planRepairRun` enqueues itself — there is no `enqueue` flag to pass.
  const plan =
    input.kind === "REPAIR"
      ? await planRepairRun(db, input.locale, { startedById: actor.id })
      : await planRun(db, input.locale, {
          kind: input.kind ?? (input.only ? "SINGLE_ENTITY" : "SYNC"),
          ...(input.only ? { only: input.only } : {}),
          startedById: actor.id,
          enqueue: true,
        });
  await auditLog({
    actorId: actor.id,
    action: AUDIT.translationRunEnqueued,
    entityType: "TranslationRun",
    entityId: plan.runId,
    meta: { locale: input.locale, planned: plan.plannedUnits },
  });
  return plan;
}

export async function requestPause(
  db: PrismaClient,
  actor: SessionUser,
  runId: string,
): Promise<void> {
  const changed = await db.translationRun.updateMany({
    where: { id: runId, status: "RUNNING" },
    data: { pauseRequested: true },
  });
  if (changed.count === 0)
    throw new ConflictError({ runId }, "admin.languages.errors.runNotRunning");
  await auditLog({
    actorId: actor.id,
    action: AUDIT.translationRunPaused,
    entityType: "TranslationRun",
    entityId: runId,
  });
}

/**
 * The only thing that clears `pauseRequested`.
 *
 * `executeRun` deliberately leaves the flag set when it honours a pause — an admin's pause has to
 * outlive the runner that obeyed it, or the worker re-claims the run on its very next tick. So a
 * paused run stays invisible to the claim query until this runs.
 */
export async function resumeRun(
  db: PrismaClient,
  actor: SessionUser,
  runId: string,
): Promise<void> {
  const run = await db.translationRun.findUnique({
    where: { id: runId },
    select: { status: true, enqueuedAt: true, pauseRequested: true },
  });
  if (!run) throw new NotFoundError({ runId });
  // A run that is still RUNNING with the flag set has been asked to pause but has not reached a
  // batch boundary yet: taking the request back is a resume too.
  if (
    run.status !== "PAUSED" &&
    !(run.status === "RUNNING" && run.pauseRequested)
  )
    throw new ConflictError({ runId }, "admin.languages.errors.runNotPaused");
  await db.translationRun.update({
    where: { id: runId },
    // A run paused before it was ever enqueued (an admin slice) joins the queue on resume.
    data: { pauseRequested: false, enqueuedAt: run.enqueuedAt ?? new Date() },
    select: { id: true },
  });
  await auditLog({
    actorId: actor.id,
    action: AUDIT.translationRunResumed,
    entityType: "TranslationRun",
    entityId: runId,
  });
}

export async function requestCancel(
  db: PrismaClient,
  actor: SessionUser,
  runId: string,
): Promise<void> {
  const run = await db.translationRun.findUnique({
    where: { id: runId },
    select: { status: true, leaseExpiresAt: true },
  });
  if (!run) throw new NotFoundError({ runId });
  if (!["PENDING", "RUNNING", "PAUSED"].includes(run.status))
    throw new ConflictError({ runId }, "admin.languages.errors.runFinished");
  const runnerAlive =
    run.status === "RUNNING" &&
    run.leaseExpiresAt !== null &&
    run.leaseExpiresAt > new Date();
  if (runnerAlive) {
    // The runner finalises at its next batch boundary (executeRun's cancelled branch). Writing
    // CANCELLED from here would race it: it still holds the lease and would keep translating.
    await db.translationRun.update({
      where: { id: runId },
      data: { cancelRequested: true },
      select: { id: true },
    });
  } else {
    // Nobody is executing this run, so nobody will ever honour the flag. Finalise it here.
    // Index: TranslationJob[runId, state, entity].
    await db.translationJob.updateMany({
      where: { runId, state: { in: ["QUEUED", "RUNNING"] } },
      data: { state: "SKIPPED", error: "cancelled", finishedAt: new Date() },
    });
    await db.translationRun.update({
      where: { id: runId },
      data: {
        status: "CANCELLED",
        finishedAt: new Date(),
        leaseOwner: null,
        leaseExpiresAt: null,
        pauseRequested: false,
        cancelRequested: false,
      },
      select: { id: true },
    });
  }
  await auditLog({
    actorId: actor.id,
    action: AUDIT.translationRunCancelled,
    entityType: "TranslationRun",
    entityId: runId,
    meta: { immediate: !runnerAlive },
  });
}

export interface EntityProgress {
  entity: TranslatableEntity;
  queued: number;
  running: number;
  done: number;
  failed: number;
  skipped: number;
}

/** Everything the progress panel shows. Dates are ISO strings: it crosses the RSC boundary every 3 s. */
export interface RunDetail {
  runId: string;
  locale: string;
  kind: TranslationRunKind;
  status: string;
  planned: number;
  completed: number;
  failed: number;
  flagged: number;
  memoryHits: number;
  remaining: number;
  done: boolean;
  promptTokens: number;
  completionTokens: number;
  estimatedUsd: number;
  /** At the estimate's rate — the run has no real price data. */
  spentUsd: number;
  rateUnitsPerMin: number | null;
  modelBatches: number;
  etaSeconds: number | null;
  heartbeatAt: string | null;
  stale: boolean;
  enqueuedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  pauseRequested: boolean;
  cancelRequested: boolean;
  error: string | null;
  byEntity: EntityProgress[];
}

export async function runDetail(
  db: PrismaClient,
  runId: string,
): Promise<RunDetail> {
  const run = await db.translationRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      locale: true,
      kind: true,
      status: true,
      plannedUnits: true,
      translatedUnits: true,
      failedUnits: true,
      flaggedUnits: true,
      memoryHits: true,
      promptTokens: true,
      completionTokens: true,
      estimatedUsd: true,
      rateUnitsPerMin: true,
      modelBatches: true,
      heartbeatAt: true,
      enqueuedAt: true,
      startedAt: true,
      finishedAt: true,
      pauseRequested: true,
      cancelRequested: true,
      error: true,
    },
  });
  if (!run) throw new NotFoundError({ runId });

  // Index: TranslationJob[runId, state, entity].
  const grouped = await db.translationJob.groupBy({
    by: ["entity", "state"],
    where: { runId },
    _count: { _all: true },
  });
  const byEntity = new Map<TranslatableEntity, EntityProgress>();
  for (const row of grouped) {
    const bucket = byEntity.get(row.entity) ?? {
      entity: row.entity,
      queued: 0,
      running: 0,
      done: 0,
      failed: 0,
      skipped: 0,
    };
    const key = row.state.toLowerCase() as
      "queued" | "running" | "done" | "failed" | "skipped";
    bucket[key] += row._count._all;
    byEntity.set(row.entity, bucket);
  }
  const entities = [...byEntity.values()].sort((a, b) =>
    a.entity.localeCompare(b.entity),
  );
  const remaining = entities.reduce(
    (sum, entry) => sum + entry.queued + entry.running,
    0,
  );
  const iso = (value: Date | null) => (value ? value.toISOString() : null);
  const now = new Date();

  return {
    runId: run.id,
    locale: run.locale,
    kind: run.kind,
    status: run.status,
    planned: run.plannedUnits,
    completed: run.translatedUnits,
    failed: run.failedUnits,
    flagged: run.flaggedUnits,
    memoryHits: run.memoryHits,
    remaining,
    done: remaining === 0,
    promptTokens: run.promptTokens,
    completionTokens: run.completionTokens,
    estimatedUsd: run.estimatedUsd,
    spentUsd:
      ((run.promptTokens + run.completionTokens) / 1000) *
      ESTIMATED_USD_PER_1K_TOKENS,
    rateUnitsPerMin: run.rateUnitsPerMin,
    modelBatches: run.modelBatches,
    etaSeconds: etaSeconds(remaining, run.rateUnitsPerMin, run.modelBatches),
    heartbeatAt: iso(run.heartbeatAt),
    stale: run.status === "RUNNING" && heartbeatStale(run.heartbeatAt, now),
    enqueuedAt: iso(run.enqueuedAt),
    startedAt: iso(run.startedAt),
    finishedAt: iso(run.finishedAt),
    pauseRequested: run.pauseRequested,
    cancelRequested: run.cancelRequested,
    error: run.error,
    byEntity: entities,
  };
}

/** The run the language card should show: the newest background run that is not a sample. */
export async function latestRunFor(
  db: PrismaClient,
  locale: string,
): Promise<RunDetail | null> {
  // Index: TranslationRun[locale, status, createdAt] — the leading column; rows per locale are few.
  const run = await db.translationRun.findFirst({
    where: { locale, enqueuedAt: { not: null }, kind: { not: "SAMPLE" } },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  return run ? runDetail(db, run.id) : null;
}
