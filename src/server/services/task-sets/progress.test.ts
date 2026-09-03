import { describe, expect, it } from "vitest";
import { nextProgress } from "./progress";

const passedRun = {
  correctCount: 41,
  outOf: 45,
  passed: true,
  attemptId: "a1",
  at: new Date("2026-09-01T10:00:00Z"),
};
const failedRun = {
  correctCount: 29,
  outOf: 45,
  passed: false,
  attemptId: "a2",
  at: new Date("2026-09-02T10:00:00Z"),
};
const betterRun = {
  correctCount: 44,
  outOf: 45,
  passed: true,
  attemptId: "a3",
  at: new Date("2026-09-03T10:00:00Z"),
};

describe("nextProgress", () => {
  it("records a first attempt", () => {
    const next = nextProgress(null, passedRun);
    expect(next).toMatchObject({
      attempts: 1,
      bestCorrect: 41,
      bestOutOf: 45,
      lastAttemptId: "a1",
      lastAttemptAt: passedRun.at,
    });
    expect(next.passedAt).toEqual(passedRun.at);
  });

  it("keeps passedAt when a later attempt fails", () => {
    const first = nextProgress(null, passedRun);
    const second = nextProgress(first, failedRun);
    // The whole point: a retry is practice. Failing one must not take the green tile away.
    expect(second.passedAt).toEqual(passedRun.at);
    expect(second.attempts).toBe(2);
    expect(second.lastAttemptId).toBe("a2");
  });

  it("keeps the BEST score, not the latest", () => {
    const second = nextProgress(nextProgress(null, passedRun), failedRun);
    expect(second.bestCorrect).toBe(41);
    expect(second.bestOutOf).toBe(45);
  });

  it("raises the best score when a later attempt beats it", () => {
    const third = nextProgress(nextProgress(null, passedRun), betterRun);
    expect(third.bestCorrect).toBe(44);
    // passedAt stays the FIRST pass — it records when the set was cleared, not the best run.
    expect(third.passedAt).toEqual(passedRun.at);
  });

  it("sets passedAt on the attempt that first passes, not the first attempt", () => {
    const first = nextProgress(null, failedRun);
    expect(first.passedAt).toBeNull();
    const second = nextProgress(first, passedRun);
    expect(second.passedAt).toEqual(passedRun.at);
  });

  it("does not set passedAt on a failed first attempt", () => {
    expect(nextProgress(null, failedRun).passedAt).toBeNull();
  });

  it("counts every attempt, passing or not", () => {
    let state = nextProgress(null, failedRun);
    state = nextProgress(state, failedRun);
    state = nextProgress(state, passedRun);
    expect(state.attempts).toBe(3);
  });

  it("treats a zero score as a real score rather than 'no score yet'", () => {
    const zeroRun = { ...failedRun, correctCount: 0, attemptId: "a0" };
    const state = nextProgress(null, zeroRun);
    expect(state.bestCorrect).toBe(0);
    expect(state.bestOutOf).toBe(45);
  });
});
