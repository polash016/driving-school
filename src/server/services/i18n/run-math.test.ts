import { describe, expect, it } from "vitest";
import { batchRate, etaSeconds, ewmaRate, heartbeatStale } from "./run-math";

/**
 * The arithmetic behind the run board's rate and ETA (spec-19).
 *
 * Pure on purpose: a runner that has to be alive for its numbers to be checked never gets its
 * numbers checked, and "the ETA was nonsense" is exactly the kind of bug nobody files.
 */
describe("run maths", () => {
  it("first observation seeds the rate, later ones smooth it", () => {
    expect(ewmaRate(null, 10)).toBe(10);
    expect(ewmaRate(10, 20)).toBeCloseTo(13);
    expect(ewmaRate(10, 0)).toBe(10); // a memory-only batch changes nothing
  });

  it("batch rate is units per minute of wall time, never divides by zero", () => {
    expect(batchRate(5, 0, 30_000)).toBe(10);
    expect(batchRate(5, 0, 0)).toBe(300); // floored at one second
  });

  it("eta needs two model batches and a positive rate", () => {
    expect(etaSeconds(100, null, 5)).toBeNull();
    expect(etaSeconds(100, 10, 1)).toBeNull();
    expect(etaSeconds(100, 10, 2)).toBe(600);
    expect(etaSeconds(0, 10, 2)).toBe(0);
  });

  it("a heartbeat older than three minutes is stale; a missing one is stale", () => {
    const now = new Date("2026-09-09T10:00:00Z");
    expect(heartbeatStale(new Date("2026-09-09T09:58:00Z"), now)).toBe(false);
    expect(heartbeatStale(new Date("2026-09-09T09:56:59Z"), now)).toBe(true);
    expect(heartbeatStale(null, now)).toBe(true);
  });
});
