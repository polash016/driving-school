/**
 * Server-authoritative attempt timing (spec-07): the client renders a countdown,
 * the server decides. All time flows through an injectable Clock — no bare
 * Date.now() in engine code (tests pin time).
 */

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Grace period absorbs network latency on final-second submits. */
export const SUBMIT_GRACE_SECONDS = 30;

export function computeExpiresAt(
  startedAt: Date,
  timeLimitSec: number | null,
): Date | null {
  if (timeLimitSec === null) return null;
  return new Date(
    startedAt.getTime() + (timeLimitSec + SUBMIT_GRACE_SECONDS) * 1000,
  );
}

/** Remaining seconds SHOWN to the student (without grace), floored at 0. Null = untimed. */
export function remainingSeconds(
  clock: Clock,
  startedAt: Date,
  timeLimitSec: number | null,
): number | null {
  if (timeLimitSec === null) return null;
  const elapsed = (clock.now().getTime() - startedAt.getTime()) / 1000;
  return Math.max(0, Math.ceil(timeLimitSec - elapsed));
}

export function isExpired(clock: Clock, expiresAt: Date | null): boolean {
  return expiresAt !== null && clock.now().getTime() > expiresAt.getTime();
}
