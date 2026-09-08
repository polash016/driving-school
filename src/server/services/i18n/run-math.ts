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

/**
 * Throughput across overlapping batches (spec-19a).
 *
 * Deliberately NOT a per-batch rate folded into an EWMA: with several batches in flight, each one
 * observes only its own slot's speed, so the run's ETA would come out N times too pessimistic.
 * The window spans the earliest start to the latest finish among recent batches, so concurrent
 * work is counted once against the wall time it actually took.
 *
 * Warm-up: right after construction (or after a resume) the window holds fewer than `slots`
 * batches, so the aggregate is short by exactly that ratio — one slot's worth of work standing in
 * for all of them. Rather than disable smoothing during warm-up (which would throw away a resumed
 * run's stored rate the moment concurrent batches start finishing), the observed reading is scaled
 * up by `slots / window.length` before it is folded through the ordinary EWMA line, so a resumed
 * run's rate erodes gracefully toward the true throughput instead of being reset to ~1/slots of it.
 *
 * `observe` is synchronous on purpose: JavaScript's single thread makes it atomic between slots,
 * which is what lets the runner drop the two-query read-modify-write it used to do per batch.
 */
export class RunRateMeter {
  private readonly window: Array<{
    units: number;
    startedAtMs: number;
    finishedAtMs: number;
  }> = [];
  private ewma: number | null;

  constructor(
    previous: number | null,
    private readonly slots: number,
  ) {
    this.ewma = previous;
  }

  /** Current window length; exposed for tests asserting the cap holds. */
  get windowSize(): number {
    return this.window.length;
  }

  /** Records one finished batch and returns the run's smoothed units-per-minute. */
  observe(
    modelUnits: number,
    startedAtMs: number,
    finishedAtMs: number,
  ): number {
    // A batch served entirely from memory says nothing about model speed.
    if (modelUnits <= 0) return this.ewma ?? 0;

    this.window.push({ units: modelUnits, startedAtMs, finishedAtMs });
    // Two rounds of every slot: enough to smooth a slow batch, short enough to track a real change.
    const keep = Math.max(2, this.slots * 2);
    while (this.window.length > keep) this.window.shift();

    const earliest = Math.min(...this.window.map((entry) => entry.startedAtMs));
    const latest = Math.max(...this.window.map((entry) => entry.finishedAtMs));
    const span = Math.max(latest - earliest, 1000);
    let observed =
      this.window.reduce((sum, entry) => sum + entry.units, 0) /
      (span / 60_000);
    // Warm-up: the window holds only `window.length` of `slots` batches in flight, so the
    // aggregate is short by that ratio. Scale it up rather than dropping the smoothing —
    // discarding `this.ewma` here would throw away a resumed run's stored rate.
    if (this.window.length < this.slots)
      observed *= this.slots / this.window.length;

    this.ewma = ewmaRate(this.ewma, observed);
    return this.ewma;
  }
}
