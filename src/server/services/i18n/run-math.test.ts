import { describe, expect, it } from "vitest";
import {
  batchRate,
  etaSeconds,
  ewmaRate,
  heartbeatStale,
  RunRateMeter,
} from "./run-math";

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

describe("RunRateMeter", () => {
  it("a single slot with one observation equals batchRate", () => {
    const meter = new RunRateMeter(null, 1);
    expect(meter.observe(5, 0, 30_000)).toBeCloseTo(batchRate(5, 0, 30_000)); // 10/min
  });

  it("three overlapping batches report aggregate throughput, not one slot's", () => {
    const meter = new RunRateMeter(null, 3);
    // Three slots each translate 5 units over the same 10-second window.
    meter.observe(5, 0, 10_000);
    meter.observe(5, 500, 10_200);
    const rate = meter.observe(5, 1_000, 10_400);
    // Raw aggregate is 15 units over ~10.4 s ≈ 86/min; observe() returns that folded through the
    // EWMA (scaled up during warm-up), landing in the same neighborhood — not the ~30/min a
    // single slot sees.
    expect(rate).toBeGreaterThan(60);
    expect(rate).toBeLessThan(100);
  });

  it("a resumed run keeps its stored rate through warm-up", () => {
    const meter = new RunRateMeter(86, 3);
    // Three slots each translate 5 units over the same 10-second window, same as above, but this
    // run resumed with a stored rate of 86/min — warm-up must scale toward the truth, not reseed.
    for (const rate of [
      meter.observe(5, 0, 10_000),
      meter.observe(5, 500, 10_200),
      meter.observe(5, 1_000, 10_400),
    ]) {
      expect(rate).toBeGreaterThan(86 * 0.85);
      expect(rate).toBeLessThan(86 * 1.15);
    }
  });

  it("keeps at most 2x slots observations", () => {
    const meter = new RunRateMeter(null, 2);
    for (let i = 0; i < 10; i++) {
      meter.observe(1, i * 1_000, (i + 1) * 1_000);
    }
    expect(meter.windowSize).toBe(4);
  });

  it("a null previous seeds the EWMA with the first observation", () => {
    const meter = new RunRateMeter(null, 1);
    const first = meter.observe(5, 0, 60_000); // 5/min
    expect(first).toBeCloseTo(5);
  });

  it("a previous rate is smoothed, not replaced", () => {
    const meter = new RunRateMeter(10, 1);
    const next = meter.observe(20, 0, 60_000); // observed 20/min, previous 10 → 0.3*20 + 0.7*10 = 13
    expect(next).toBeCloseTo(13);
  });
});
