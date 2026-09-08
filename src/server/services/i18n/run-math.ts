/** Spec-19 progress arithmetic, kept pure so the ETA can be tested with fake clocks. */

/**
 * A mid-range rate; the point is order of magnitude, not precision. Lives here (no imports) so
 * runs.ts, run-control.ts, repair.ts and sample.ts can all share it without a cycle — runs.ts
 * must delete its own copy and import this one.
 */
export const ESTIMATED_USD_PER_1K_TOKENS = 0.0006;

const EWMA_WEIGHT = 0.3;

/** Exponentially weighted units-per-minute; null previous means "first observation wins". */
export function ewmaRate(previous: number | null, observed: number): number {
  if (!Number.isFinite(observed) || observed <= 0) return previous ?? 0;
  return previous === null
    ? observed
    : EWMA_WEIGHT * observed + (1 - EWMA_WEIGHT) * previous;
}

/** Throughput of one batch: model-translated units over wall time, floored at one second. */
export function batchRate(
  modelUnits: number,
  startedAtMs: number,
  finishedAtMs: number,
): number {
  const minutes = Math.max(finishedAtMs - startedAtMs, 1000) / 60_000;
  return modelUnits / minutes;
}

/** Seconds until done, or null while there is no trustworthy rate yet. */
export function etaSeconds(
  remaining: number,
  rateUnitsPerMin: number | null,
  modelBatches: number,
): number | null {
  if (remaining <= 0) return 0;
  if (rateUnitsPerMin === null || rateUnitsPerMin <= 0 || modelBatches < 2)
    return null;
  return Math.round((remaining / rateUnitsPerMin) * 60);
}

/** The lease is 2 min; a heartbeat older than this means the runner is gone, not slow. */
export const HEARTBEAT_STALE_MS = 3 * 60_000;

export function heartbeatStale(heartbeatAt: Date | null, now: Date): boolean {
  return (
    heartbeatAt === null ||
    now.getTime() - heartbeatAt.getTime() > HEARTBEAT_STALE_MS
  );
}
