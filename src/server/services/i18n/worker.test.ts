import { describe, expect, it, vi } from "vitest";
import type { RunProgress } from "./runs";
import {
  backoffMs,
  maybePlanRepair,
  runWorker,
  startHeartbeat,
  workerTick,
  type WorkerDeps,
} from "./worker";

/**
 * The worker loop, with no process, no database and no clock (spec-19).
 *
 * Everything the loop touches is injected, so what is under test here is the only thing worth
 * testing about a background daemon: that it survives. A run that throws must not take the
 * language behind it down with it (layer 3), and a tick that throws — Postgres restarting, say —
 * must not end the loop (layer 4). Both of those are impossible to provoke reliably against a
 * real database, which is exactly why `db` is a parameter.
 */

interface RunStub {
  findFirst: ReturnType<typeof vi.fn>;
  findUniqueOrThrow: ReturnType<typeof vi.fn>;
  updateMany: ReturnType<typeof vi.fn>;
}
interface Stub {
  translationRun: RunStub;
}

const COMPLETED: RunProgress = {
  runId: "r1",
  status: "COMPLETED",
  stopReason: "finished",
  planned: 1,
  completed: 1,
  failed: 0,
  flagged: 0,
  memoryHits: 0,
  done: true,
};

function deps(
  overrides: Omit<Partial<WorkerDeps>, "db"> & { db: Stub },
): WorkerDeps {
  return {
    leaseOwner: "worker-test",
    pollMs: 10,
    signal: new AbortController().signal,
    heartbeat: vi.fn(async () => undefined),
    reap: vi.fn(async () => []),
    execute: vi.fn(async () => COMPLETED),
    afterRun: vi.fn(async () => undefined),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
    db: overrides.db as unknown as WorkerDeps["db"],
  };
}

describe("backoff", () => {
  it("doubles per consecutive failure and caps at five minutes", () => {
    expect(backoffMs(5000, 0)).toBe(5000);
    expect(backoffMs(5000, 1)).toBe(10_000);
    expect(backoffMs(5000, 3)).toBe(40_000);
    expect(backoffMs(5000, 20)).toBe(300_000);
  });
});

describe("workerTick", () => {
  it("is idle when nothing is enqueued, and still heartbeats", async () => {
    const db: Stub = {
      translationRun: {
        findFirst: vi.fn(async () => null),
        findUniqueOrThrow: vi.fn(),
        updateMany: vi.fn(),
      },
    };
    const d = deps({ db });
    expect(await workerTick(d)).toBe("idle");
    expect(d.heartbeat).toHaveBeenCalledTimes(1);
    expect(d.execute).not.toHaveBeenCalled();
  });

  it("executes a claimable run then hands it to afterRun with the DB status", async () => {
    const db: Stub = {
      translationRun: {
        findFirst: vi.fn(async () => ({
          id: "r1",
          locale: "es",
          kind: "SYNC",
        })),
        findUniqueOrThrow: vi.fn(async () => ({
          id: "r1",
          locale: "es",
          kind: "SYNC",
          status: "COMPLETED",
          startedById: "u1",
          translatedUnits: 3,
          flaggedUnits: 1,
          failedUnits: 0,
          error: null,
        })),
        updateMany: vi.fn(),
      },
    };
    const d = deps({ db });
    expect(await workerTick(d)).toBe("worked");
    expect(d.execute).toHaveBeenCalledWith(
      "r1",
      expect.objectContaining({ leaseOwner: "worker-test" }),
    );
    // The row, not the in-memory progress: the runner's own view can be stale by the time it
    // returns, and the notification quotes the status a human will see on the board.
    expect(d.afterRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: "r1", status: "COMPLETED" }),
    );
  });

  it("does not finish a run it never owned", async () => {
    const db: Stub = {
      translationRun: {
        findFirst: vi.fn(async () => ({
          id: "r1",
          locale: "es",
          kind: "SYNC",
        })),
        findUniqueOrThrow: vi.fn(),
        updateMany: vi.fn(),
      },
    };
    // An admin paused it between the claim query and the claim itself.
    const d = deps({
      db,
      execute: vi.fn(async () => ({
        ...COMPLETED,
        status: "PAUSED",
        stopReason: "notClaimed" as const,
      })),
    });
    expect(await workerTick(d)).toBe("idle");
    expect(d.afterRun).not.toHaveBeenCalled();
    expect(db.translationRun.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it("layer 3: a run that throws is marked FAILED and the tick reports it instead of throwing", async () => {
    const db: Stub = {
      translationRun: {
        findFirst: vi.fn(async () => ({
          id: "r1",
          locale: "es",
          kind: "SYNC",
        })),
        findUniqueOrThrow: vi.fn(async () => ({
          id: "r1",
          locale: "es",
          kind: "SYNC",
          status: "FAILED",
          startedById: null,
          translatedUnits: 0,
          flaggedUnits: 0,
          failedUnits: 0,
          error: "boom",
        })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    };
    const d = deps({
      db,
      execute: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    expect(await workerTick(d)).toBe("failed");
    expect(db.translationRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "r1", leaseOwner: "worker-test" },
        data: expect.objectContaining({ status: "FAILED", error: "boom" }),
      }),
    );
    expect(d.afterRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: "FAILED" }),
    );
  });
});

describe("cancelled runs whose runner never came back", () => {
  it("reaps them before looking for work, and reports what it finalised", async () => {
    const db: Stub = {
      translationRun: {
        findFirst: vi.fn(async () => null),
        findUniqueOrThrow: vi.fn(),
        updateMany: vi.fn(),
      },
    };
    const d = deps({ db, reap: vi.fn(async () => ["wedged"]) });

    expect(await workerTick(d)).toBe("idle");
    expect(d.reap).toHaveBeenCalledTimes(1);
    expect(d.log.warn).toHaveBeenCalledWith(
      { runIds: ["wedged"] },
      "finalised cancelled runs with no runner",
    );
  });

  it("still works the queue when the reap itself fails", async () => {
    const db: Stub = {
      translationRun: {
        findFirst: vi.fn(async () => ({
          id: "r1",
          locale: "es",
          kind: "SYNC",
        })),
        findUniqueOrThrow: vi.fn(async () => ({
          id: "r1",
          locale: "es",
          kind: "SYNC",
          status: "COMPLETED",
          startedById: "u1",
          translatedUnits: 1,
          flaggedUnits: 0,
          failedUnits: 0,
          error: null,
        })),
        updateMany: vi.fn(),
      },
    };
    const d = deps({
      db,
      reap: vi.fn(async () => {
        throw new Error("db down");
      }),
    });

    expect(await workerTick(d)).toBe("worked");
    expect(d.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Error) }),
      "reaping cancelled runs failed",
    );
  });
});

describe("startHeartbeat", () => {
  // The bug this exists for: the beat used to be the tick's first statement, and the tick's next
  // statement awaits a run for as long as the run takes. The key's TTL is three polls, so the
  // board read "worker offline" for the entire duration of every real run.
  it("keeps beating while a run holds the tick for far longer than the TTL", async () => {
    vi.useFakeTimers();
    const heartbeat = vi.fn(async () => undefined);
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const stop = startHeartbeat({ heartbeat, pollMs: 5000, log });

    expect(heartbeat).toHaveBeenCalledTimes(1); // at once, not one poll late
    await vi.advanceTimersByTimeAsync(5000 * 10);
    expect(heartbeat).toHaveBeenCalledTimes(11);

    stop();
    await vi.advanceTimersByTimeAsync(5000 * 3);
    expect(heartbeat).toHaveBeenCalledTimes(11);
    vi.useRealTimers();
  });

  it("logs a Redis failure and beats again on the next interval", async () => {
    vi.useFakeTimers();
    const heartbeat = vi.fn(async () => {
      throw new Error("redis down");
    });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const stop = startHeartbeat({ heartbeat, pollMs: 1000, log });
    await vi.advanceTimersByTimeAsync(2000);

    expect(heartbeat).toHaveBeenCalledTimes(3);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Error) }),
      "worker heartbeat failed",
    );
    stop();
    vi.useRealTimers();
  });
});

describe("runWorker", () => {
  it("layer 4: keeps looping through tick failures with backoff, and stops on the signal", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const db: Stub = {
      translationRun: {
        findFirst: vi.fn(async () => {
          throw new Error("db down");
        }),
        findUniqueOrThrow: vi.fn(),
        updateMany: vi.fn(),
      },
    };
    const d = deps({ db, pollMs: 100, signal: controller.signal });
    const loop = runWorker(d);
    await vi.advanceTimersByTimeAsync(100 + 200 + 400); // three failing ticks with growing waits
    expect(
      db.translationRun.findFirst.mock.calls.length,
    ).toBeGreaterThanOrEqual(3);
    expect(d.log.error).toHaveBeenCalled();
    controller.abort();
    await vi.advanceTimersByTimeAsync(1000);
    await loop;
    expect(d.log.info).toHaveBeenCalledWith({}, "worker stopped");
    vi.useRealTimers();
  });
});

describe("afterRun failures", () => {
  it("a throwing afterRun on a finished run is logged, not reported as a failed run", async () => {
    const db = {
      translationRun: {
        findFirst: vi.fn(async () => ({
          id: "r1",
          locale: "es",
          kind: "SYNC",
        })),
        findUniqueOrThrow: vi.fn(async () => ({
          id: "r1",
          locale: "es",
          kind: "SYNC",
          status: "COMPLETED",
          startedById: "u1",
          translatedUnits: 3,
          flaggedUnits: 0,
          failedUnits: 0,
          error: null,
        })),
        updateMany: vi.fn(),
      },
    };
    const d = deps({
      db,
      afterRun: vi.fn(async () => {
        throw new Error("smtp down");
      }),
    });

    // The run completed; only the notification failed. Reporting "failed" here would log a
    // healthy run as broken and try to write FAILED over a terminal row.
    expect(await workerTick(d)).toBe("worked");
    expect(db.translationRun.updateMany).not.toHaveBeenCalled();
    expect(d.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "r1" }),
      "afterRun failed",
    );
  });
});

describe("maybePlanRepair", () => {
  const base = {
    id: "r1",
    locale: "es",
    kind: "SYNC" as const,
    status: "COMPLETED",
    startedById: "u1",
    translatedUnits: 10,
    flaggedUnits: 2,
    failedUnits: 0,
    error: null,
  };

  it("chains a repair after a sync that left flagged units", async () => {
    const plan = vi.fn(async () => ({ runId: "r2", plannedUnits: 2 }));
    expect(
      await maybePlanRepair(base, {
        candidates: async () => 2,
        exhausted: async () => 0,
        plan,
      }),
    ).toEqual({ action: "planned", runId: "r2", planned: 2 });
  });

  // The anti-hot-loop rule. Provider down: every batch fails, the jobs go SKIPPED, the run still
  // reaches COMPLETED, and because storeRepairs never ran the same rows are still candidates with
  // their repairAttempts untouched. Planning again would plan the identical run, for ever.
  it("does not chain when a repair made no progress (provider down), and reports it", async () => {
    const plan = vi.fn();
    expect(
      await maybePlanRepair(
        { ...base, kind: "REPAIR", translatedUnits: 2, flaggedUnits: 2 },
        { candidates: async () => 2, exhausted: async () => 0, plan },
      ),
    ).toEqual({ action: "stalled" });
    expect(plan).not.toHaveBeenCalled();
  });

  it("reports exhaustion once nothing is under the ceiling but flagged rows remain", async () => {
    expect(
      await maybePlanRepair(
        { ...base, kind: "REPAIR", flaggedUnits: 1 },
        { candidates: async () => 0, exhausted: async () => 4, plan: vi.fn() },
      ),
    ).toEqual({ action: "exhausted", remaining: 4 });
  });

  it("is a no-op for samples and failed runs", async () => {
    expect(
      await maybePlanRepair(
        { ...base, kind: "SAMPLE" },
        { candidates: async () => 5, exhausted: async () => 0, plan: vi.fn() },
      ),
    ).toEqual({ action: "none" });
    expect(
      await maybePlanRepair(
        { ...base, status: "FAILED" },
        { candidates: async () => 5, exhausted: async () => 0, plan: vi.fn() },
      ),
    ).toEqual({ action: "none" });
  });
});
