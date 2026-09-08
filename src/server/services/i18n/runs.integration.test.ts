import { randomBytes, randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { SessionUser } from "@/server/authz";
import { db } from "@/server/db";
import { redis } from "@/server/redis";

/**
 * What the runner must do when nobody is watching (spec-19).
 *
 * The attended callers — an admin pressing "Translate 25", the CLI — hide four failures that an
 * unattended worker runs into within an hour: a lease that lapses mid-batch, a partial claim, jobs
 * a killed process left RUNNING, and no way to ask it to stop. Each of those has a test here, and
 * each is checked against a real Postgres because every one of them is a rule about rows.
 *
 * The gateway is stubbed: these tests are about claiming and releasing work, and none of it should
 * depend on a model being up or on what it says.
 */
const aiJson = vi.fn();
const aiEmbed = vi.fn();
vi.mock("@/server/ai/client", () => ({
  aiJson: (...args: unknown[]) => aiJson(...args),
  aiEmbed: (...args: unknown[]) => aiEmbed(...args),
}));

const { executeRun, planRun, progressOf } = await import("./runs");
const { createLanguage } = await import("./languages");

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const d = describe.skipIf(!enabled);
const RUN = randomBytes(3).toString("hex");
const CODE = `zr-${RUN}`.slice(0, 8);
const actor: SessionUser = {
  id: "",
  role: "ADMIN",
  email: `run-${RUN}@example.no`,
};
const topicIds: string[] = [];

/**
 * The model echoes each unit's English with a marker, so fresh output is distinguishable from a
 * memory hit. Two prompts reach this stub — the translation call sends `{ id, en }`, the QA
 * back-translation sends `{ id, value }` — and echoing whichever arrived keeps the QA pass honest
 * instead of collapsing every unit into QA_UNAVAILABLE.
 */
function modelAnswers() {
  aiJson.mockImplementation(async (opts: { vars: { unitsJson: string } }) => ({
    data: { units: echo(opts.vars.unitsJson) },
    modelVersion: "stub",
    promptVersion: "translation.units@1.0.0",
    usage: { promptTokens: 200, completionTokens: 100 },
    providerLabel: "stub",
  }));
  aiEmbed.mockImplementation(async (texts: string[]) =>
    texts.map(() => [1, 0, 0]),
  );
}

interface StubUnit {
  id: string;
  en?: Record<string, unknown>;
  value?: Record<string, unknown>;
}

function echo(unitsJson: string) {
  const items = JSON.parse(unitsJson) as StubUnit[];
  return items.map((unit) => {
    const source = unit.en ?? unit.value ?? {};
    const name = typeof source.name === "string" ? source.name : "";
    return { id: unit.id, value: { ...source, name: `[${CODE}] ${name}` } };
  });
}

beforeAll(async () => {
  if (!enabled) return;
  const user = await db.user.create({
    data: {
      email: actor.email,
      role: "ADMIN",
      emailVerifiedAt: new Date(),
      profile: { create: { firstName: "Run", lastName: RUN } },
    },
    select: { id: true },
  });
  actor.id = user.id;
  await createLanguage(db, actor, {
    code: CODE,
    englishName: "Runic",
    nativeName: "Runic",
    shortLabel: "ZR",
    direction: "LTR",
    requiresApproval: false,
  });
  for (let i = 0; i < 15; i++) {
    const topic = await db.topic.create({
      data: {
        slug: `zr-${RUN}-${i}`,
        name: { en: `Topic ${i}`, nb: `Emne ${i}` },
        sortOrder: 900 + i,
      },
      select: { id: true },
    });
    topicIds.push(topic.id);
  }
});

afterAll(async () => {
  if (!enabled) return;
  await db.translation.deleteMany({ where: { locale: CODE } });
  await db.translationMemory.deleteMany({ where: { locale: CODE } });
  await db.translationJob.deleteMany({ where: { run: { locale: CODE } } });
  await db.translationRun.deleteMany({ where: { locale: CODE } });
  await db.language.deleteMany({ where: { code: CODE } });
  await db.topic.deleteMany({ where: { id: { in: topicIds } } });
  await db.auditLog.deleteMany({ where: { actorId: actor.id } });
  await db.user.deleteMany({ where: { id: actor.id } });
  await db.$disconnect();
  await redis.quit().catch(() => undefined);
});

beforeEach(async () => {
  aiJson.mockReset();
  aiEmbed.mockReset();
  modelAnswers();
  if (!enabled) return;
  // Every test starts from "nothing is translated yet". The memory in particular: a second run
  // over the same topics would otherwise be a pure memory replay with no model call in it, and
  // half of these tests are about what the runner records when it DOES call the model.
  await db.translation.deleteMany({ where: { locale: CODE } });
  await db.translationMemory.deleteMany({ where: { locale: CODE } });
  // Some cases deliberately leave a run RUNNING under a live lease (the stolen-lease one hands it
  // to a "thief" for two minutes). One live run per locale is a rule the runner enforces, so the
  // next test would get `localeBusy` instead of doing any work. Retire them between tests.
  await db.translationRun.updateMany({
    where: { locale: CODE, status: "RUNNING" },
    data: { status: "CANCELLED", leaseOwner: null, leaseExpiresAt: null },
  });
});

async function planTopics() {
  return planRun(db, CODE, {
    kind: "SINGLE_ENTITY",
    only: ["TOPIC"],
    startedById: actor.id,
  });
}

/**
 * The shape these cases were written against: one batch of five at a time.
 *
 * Spec-19a made the batch size config-driven (20) and put three batches in flight at once, which
 * would collapse every "first batch, then the flag is read" case here into a single batch. Pinning
 * keeps them testing what they were written to test; the slot behaviour has its own cases below.
 */
const SERIAL = { batchSize: 5, parallelSlots: 1 } as const;

interface SentBatch {
  ids: string[];
  kinds: string[];
}

/**
 * What the model was actually asked to translate, per call.
 *
 * Only `translation.units` — the QA back-translation sends the same `unitsJson` variable with the
 * translated value instead of the source, and counting it would double every id.
 */
function sentBatches(): SentBatch[] {
  return aiJson.mock.calls
    .map(
      (call) =>
        call[0] as { prompt: { id: string }; vars: { unitsJson: string } },
    )
    .filter((opts) => opts.prompt.id === "translation.units")
    .map((opts) => {
      const items = JSON.parse(opts.vars.unitsJson) as Array<{
        id: string;
        kind: string;
      }>;
      return {
        ids: items.map((item) => item.id),
        kinds: [...new Set(items.map((item) => item.kind))],
      };
    });
}

async function jobStates(runId: string) {
  return db.translationJob.findMany({
    where: { runId },
    select: {
      entityId: true,
      state: true,
      attempts: true,
      claimedBy: true,
    },
  });
}

d("executeRun (spec-19)", () => {
  it("re-queues jobs a crashed runner left RUNNING, and completion waits for them", async () => {
    const plan = await planTopics();
    // Simulate a crash mid-batch: two jobs RUNNING, lease lapsed.
    const jobs = await db.translationJob.findMany({
      where: { runId: plan.runId },
      take: 2,
      select: { id: true },
    });
    await db.translationJob.updateMany({
      where: { id: { in: jobs.map((job) => job.id) } },
      data: { state: "RUNNING", claimedBy: "dead-runner" },
    });
    await db.translationRun.update({
      where: { id: plan.runId },
      data: {
        status: "RUNNING",
        leaseOwner: "dead-runner",
        leaseExpiresAt: new Date(Date.now() - 60_000),
      },
    });

    const progress = await executeRun(db, plan.runId, {
      leaseOwner: `t-${randomUUID().slice(0, 6)}`,
      ...SERIAL,
    });
    expect(progress.done).toBe(true);
    const states = await db.translationJob.groupBy({
      by: ["state"],
      where: { runId: plan.runId },
      _count: true,
    });
    expect(states.find((state) => state.state === "RUNNING")).toBeUndefined();
    expect(states.find((state) => state.state === "DONE")?._count).toBe(
      plan.plannedUnits,
    );
  });

  it("stops after the current batch when cancel is requested, and skips the rest", async () => {
    const plan = await planTopics();
    aiJson.mockImplementationOnce(
      async (opts: { vars: { unitsJson: string } }) => {
        await db.translationRun.update({
          where: { id: plan.runId },
          data: { cancelRequested: true },
        });
        return {
          data: { units: echo(opts.vars.unitsJson) },
          modelVersion: "stub",
          promptVersion: "p",
          usage: { promptTokens: 1, completionTokens: 1 },
          providerLabel: "stub",
        };
      },
    );
    const progress = await executeRun(db, plan.runId, {
      leaseOwner: "t-cancel",
      ...SERIAL,
    });
    expect(progress.status).toBe("CANCELLED");
    expect(progress.stopReason).toBe("cancelled");
    const run = await db.translationRun.findUniqueOrThrow({
      where: { id: plan.runId },
      select: { leaseOwner: true, finishedAt: true },
    });
    expect(run.leaseOwner).toBeNull();
    expect(run.finishedAt).not.toBeNull();
    expect(
      await db.translationJob.count({
        where: { runId: plan.runId, state: "QUEUED" },
      }),
    ).toBe(0);
    expect(
      await db.translationJob.count({
        where: { runId: plan.runId, state: "SKIPPED", error: "cancelled" },
      }),
    ).toBeGreaterThan(0);
  });

  it("pauses cooperatively and is not re-claimable while paused", async () => {
    const plan = await planTopics();
    aiJson.mockImplementationOnce(
      async (opts: { vars: { unitsJson: string } }) => {
        await db.translationRun.update({
          where: { id: plan.runId },
          data: { pauseRequested: true },
        });
        return {
          data: { units: echo(opts.vars.unitsJson) },
          modelVersion: "stub",
          promptVersion: "p",
          usage: { promptTokens: 1, completionTokens: 1 },
          providerLabel: "stub",
        };
      },
    );
    const first = await executeRun(db, plan.runId, {
      leaseOwner: "t-pause",
      ...SERIAL,
    });
    expect(first.status).toBe("PAUSED");
    expect(first.stopReason).toBe("paused");
    // The flag, not the status, is what holds a pause: PAUSED alone already means "a slice ended".
    const again = await executeRun(db, plan.runId, {
      leaseOwner: "t-other",
      ...SERIAL,
    });
    expect(again.stopReason).toBe("notClaimed");
    await db.translationRun.update({
      where: { id: plan.runId },
      data: { pauseRequested: false },
    });
    const resumed = await executeRun(db, plan.runId, {
      leaseOwner: "t-resume",
      ...SERIAL,
    });
    expect(resumed.done).toBe(true);
  });

  it("an aborted signal returns the batch to the queue without charging an attempt", async () => {
    const plan = await planTopics();
    const controller = new AbortController();
    aiJson.mockImplementationOnce(async () => {
      controller.abort();
      const { ProviderError } = await import("@/server/ai/providers");
      throw new ProviderError("request aborted", 499, true);
    });
    const progress = await executeRun(db, plan.runId, {
      leaseOwner: "t-abort",
      signal: controller.signal,
      ...SERIAL,
    });
    expect(progress.stopReason).toBe("aborted");
    expect(progress.status).toBe("PAUSED");
    const jobs = await db.translationJob.findMany({
      where: { runId: plan.runId },
      select: { state: true, attempts: true },
    });
    expect(
      jobs.every((job) => job.state === "QUEUED" && job.attempts === 0),
    ).toBe(true);
  });

  it("writes a heartbeat and a rate, and refuses a second run for the same locale", async () => {
    const plan = await planTopics();
    const other = await planTopics();
    await db.translationRun.update({
      where: { id: other.runId },
      data: {
        status: "RUNNING",
        leaseOwner: "busy",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const blocked = await executeRun(db, plan.runId, {
      leaseOwner: "t-second",
      ...SERIAL,
    });
    expect(blocked.stopReason).toBe("localeBusy");
    await db.translationRun.update({
      where: { id: other.runId },
      data: { status: "CANCELLED", leaseOwner: null, leaseExpiresAt: null },
    });
    const done = await executeRun(db, plan.runId, {
      leaseOwner: "t-rate",
      ...SERIAL,
    });
    expect(done.done).toBe(true);
    const run = await db.translationRun.findUniqueOrThrow({
      where: { id: plan.runId },
      select: {
        heartbeatAt: true,
        rateUnitsPerMin: true,
        modelBatches: true,
        startedAt: true,
      },
    });
    expect(run.startedAt).not.toBeNull();
    expect(run.heartbeatAt).not.toBeNull();
    expect(run.modelBatches).toBeGreaterThan(0);
    expect(run.rateUnitsPerMin).toBeGreaterThan(0);
    expect(await progressOf(db, plan.runId)).toMatchObject({ done: true });
  });

  /**
   * `failedUnits` used to be charged on every attempt: a 5-unit batch that failed all three times
   * reported "failed 15" against a plan of 5, and the outcome mail quoted the same number. A unit
   * is counted where it runs out of attempts and is given up on — once.
   */
  it("counts a unit that fails every attempt once, not once per attempt", async () => {
    const plan = await planTopics();
    aiJson.mockImplementation(async () => {
      throw new Error("provider down");
    });

    const progress = await executeRun(db, plan.runId, {
      leaseOwner: "t-fail",
      ...SERIAL,
    });
    expect(progress.done).toBe(true);
    expect(progress.failed).toBe(plan.plannedUnits);

    const run = await db.translationRun.findUniqueOrThrow({
      where: { id: plan.runId },
      select: { status: true, failedUnits: true, plannedUnits: true },
    });
    expect(run.status).toBe("COMPLETED");
    expect(run.failedUnits).toBe(run.plannedUnits);

    // Every job really did spend all three attempts — the count is small because it is charged
    // once, not because the runner gave up early.
    const jobs = await db.translationJob.findMany({
      where: { runId: plan.runId },
      select: { state: true, attempts: true },
    });
    expect(jobs).toHaveLength(plan.plannedUnits);
    expect(jobs.every((job) => job.state === "SKIPPED")).toBe(true);
    expect(jobs.every((job) => job.attempts === 3)).toBe(true);
  });

  it("stops when another runner has taken the lease, and writes nothing over its state", async () => {
    const plan = await planTopics();
    aiJson.mockImplementationOnce(
      async (opts: { vars: { unitsJson: string } }) => {
        // The lease lapsed while this batch was in the model, and a sweeper handed the run on.
        await db.translationRun.update({
          where: { id: plan.runId },
          data: {
            leaseOwner: "thief",
            leaseExpiresAt: new Date(Date.now() + 120_000),
          },
        });
        return {
          data: { units: echo(opts.vars.unitsJson) },
          modelVersion: "stub",
          promptVersion: "p",
          usage: { promptTokens: 1, completionTokens: 1 },
          providerLabel: "stub",
        };
      },
    );
    const progress = await executeRun(db, plan.runId, {
      leaseOwner: "t-loser",
      ...SERIAL,
    });
    expect(progress.stopReason).toBe("lostLease");
    const run = await db.translationRun.findUniqueOrThrow({
      where: { id: plan.runId },
      select: {
        leaseOwner: true,
        status: true,
        finishedAt: true,
        translatedUnits: true,
      },
    });
    // Every run-row write is owner-guarded, so the loser neither releases the lease, nor marks a
    // status, nor moves a counter the new owner is now responsible for.
    expect(run.leaseOwner).toBe("thief");
    expect(run.status).toBe("RUNNING");
    expect(run.finishedAt).toBeNull();
    expect(run.translatedUnits).toBe(0);
  });
});
/**
 * Parallel slots (spec-19a).
 *
 * The runner used to translate one batch at a time. Three batches in flight turn every "claim,
 * read back, mark done" rule into a rule about two runners inside one process, so each of those is
 * pinned here against a real Postgres: no unit may be translated twice, no budget may be
 * overspent, and every stop reason must still stop the whole run and not just the slot that saw it.
 */
d("executeRun slots (spec-19a)", () => {
  it("three slots translate 15 units with no unit translated twice", async () => {
    const plan = await planTopics();
    // The fixture is deliberately several batches deep, so three slots really do overlap.
    expect(plan.plannedUnits).toBeGreaterThanOrEqual(15);

    const progress = await executeRun(db, plan.runId, {
      leaseOwner: "t-slots",
      batchSize: 5,
      parallelSlots: 3,
    });

    const ids = sentBatches().flatMap((batch) => batch.ids);
    expect(ids).toHaveLength(plan.plannedUnits);
    expect(new Set(ids).size).toBe(plan.plannedUnits);

    expect(progress.status).toBe("COMPLETED");
    const jobs = await jobStates(plan.runId);
    expect(jobs.filter((job) => job.state === "DONE")).toHaveLength(
      plan.plannedUnits,
    );
    const run = await db.translationRun.findUniqueOrThrow({
      where: { id: plan.runId },
      select: { leaseOwner: true, leaseExpiresAt: true },
    });
    expect(run.leaseOwner).toBeNull();
    expect(run.leaseExpiresAt).toBeNull();
  });

  it("each slot's read-back returns only its own claim", async () => {
    const plan = await planTopics();
    await executeRun(db, plan.runId, {
      leaseOwner: "t-claim",
      batchSize: 5,
      parallelSlots: 3,
    });

    const batches = sentBatches();
    for (const batch of batches) {
      expect(batch.ids.length).toBeLessThanOrEqual(5);
      // One entity kind per batch, so a batch shares one prompt shape.
      expect(batch.kinds).toHaveLength(1);
    }
    const ids = batches.flatMap((batch) => batch.ids);
    expect(new Set(ids).size).toBe(ids.length);

    // The claim token is per slot, not per runner: that is what makes the read-back exact.
    const jobs = await jobStates(plan.runId);
    const owners = new Set(jobs.map((job) => job.claimedBy));
    expect(owners.size).toBe(3);
    for (const owner of owners) expect(owner).toMatch(/^t-claim#[0-2]$/);
  });

  it("cancel stops claiming but lets in-flight batches finish", async () => {
    const plan = await planTopics();
    aiJson.mockImplementationOnce(
      async (opts: { vars: { unitsJson: string } }) => {
        await db.translationRun.update({
          where: { id: plan.runId },
          data: { cancelRequested: true },
        });
        return {
          data: { units: echo(opts.vars.unitsJson) },
          modelVersion: "stub",
          promptVersion: "p",
          usage: { promptTokens: 1, completionTokens: 1 },
          providerLabel: "stub",
        };
      },
    );

    const progress = await executeRun(db, plan.runId, {
      leaseOwner: "t-slot-cancel",
      batchSize: 2,
      parallelSlots: 3,
    });
    expect(progress.status).toBe("CANCELLED");
    expect(progress.stopReason).toBe("cancelled");

    const run = await db.translationRun.findUniqueOrThrow({
      where: { id: plan.runId },
      select: { finishedAt: true, leaseOwner: true },
    });
    expect(run.finishedAt).not.toBeNull();
    expect(run.leaseOwner).toBeNull();

    const jobs = await jobStates(plan.runId);
    const byId = new Map(jobs.map((job) => [job.entityId, job.state]));
    // Nothing the model was already working on is thrown away.
    for (const id of sentBatches().flatMap((batch) => batch.ids)) {
      expect(byId.get(id)).toBe("DONE");
    }
    expect(jobs.filter((job) => job.state === "DONE").length).toBeGreaterThan(
      0,
    );
    expect(
      jobs.filter((job) => job.state === "SKIPPED").length,
    ).toBeGreaterThan(0);
    expect(jobs.filter((job) => job.state === "QUEUED")).toHaveLength(0);
    expect(
      await db.translationJob.count({
        where: { runId: plan.runId, state: "SKIPPED", error: "cancelled" },
      }),
    ).toBeGreaterThan(0);
  });

  it("abort re-queues every in-flight batch without charging an attempt", async () => {
    const plan = await planTopics();
    const controller = new AbortController();
    const { ProviderError } = await import("@/server/ai/providers");
    aiJson.mockImplementation(async () => {
      controller.abort();
      throw new ProviderError("request aborted", 499, true);
    });

    const progress = await executeRun(db, plan.runId, {
      leaseOwner: "t-slot-abort",
      signal: controller.signal,
      batchSize: 5,
      parallelSlots: 3,
    });
    expect(progress.stopReason).toBe("aborted");
    expect(progress.status).toBe("PAUSED");

    const jobs = await jobStates(plan.runId);
    expect(jobs).toHaveLength(plan.plannedUnits);
    expect(
      jobs.every((job) => job.state === "QUEUED" && job.attempts === 0),
    ).toBe(true);
  });

  it("budget is not overspent across slots", async () => {
    const plan = await planTopics();
    const progress = await executeRun(db, plan.runId, {
      leaseOwner: "t-slot-budget",
      maxUnits: 7,
      batchSize: 5,
      parallelSlots: 3,
    });
    expect(progress.stopReason).toBe("budget");

    const jobs = await jobStates(plan.runId);
    expect(jobs.filter((job) => job.state === "DONE")).toHaveLength(7);
    expect(sentBatches().flatMap((batch) => batch.ids)).toHaveLength(7);
  });

  it("a truncated batch is re-queued without charging an attempt, and the next batch is half the size", async () => {
    const plan = await planTopics();
    const { ProviderTruncatedError } = await import("@/server/ai/providers");
    aiJson.mockImplementationOnce(async () => {
      throw new ProviderTruncatedError(8192, 8192);
    });

    const progress = await executeRun(db, plan.runId, {
      leaseOwner: "t-truncate",
      batchSize: 5,
      parallelSlots: 1,
    });
    expect(progress.stopReason).toBe("finished");

    const sizes = sentBatches().map((batch) => batch.ids.length);
    expect(sizes[0]).toBe(5);
    expect(Math.min(...sizes.slice(1))).toBeLessThanOrEqual(2);
    expect(Math.max(...sizes.slice(1))).toBeLessThanOrEqual(2);

    const jobs = await jobStates(plan.runId);
    expect(jobs).toHaveLength(plan.plannedUnits);
    // A truncation is the runner's fault, not the unit's: nothing is charged an attempt for it.
    expect(jobs.every((job) => job.state === "DONE")).toBe(true);
    expect(jobs.every((job) => job.attempts === 1)).toBe(true);
  });

  it("a single unit that truncates is FAILED, not re-queued for ever", async () => {
    const plan = await planTopics();
    const { ProviderTruncatedError } = await import("@/server/ai/providers");
    aiJson.mockImplementation(async () => {
      throw new ProviderTruncatedError(8192, 8192);
    });

    const progress = await executeRun(db, plan.runId, {
      leaseOwner: "t-truncate-one",
      batchSize: 1,
      parallelSlots: 1,
    });
    expect(progress.status).toBe("COMPLETED");

    const jobs = await jobStates(plan.runId);
    expect(jobs).toHaveLength(plan.plannedUnits);
    expect(jobs.every((job) => job.state === "SKIPPED")).toBe(true);
    expect(jobs.every((job) => job.attempts === 3)).toBe(true);
  });

  it("counts one model batch per slot batch, and a rate, under three slots", async () => {
    const plan = await planTopics();
    await executeRun(db, plan.runId, {
      leaseOwner: "t-slot-rate",
      batchSize: 5,
      parallelSlots: 3,
    });

    const run = await db.translationRun.findUniqueOrThrow({
      where: { id: plan.runId },
      select: {
        modelBatches: true,
        rateUnitsPerMin: true,
        translatedUnits: true,
      },
    });
    expect(run.modelBatches).toBe(Math.ceil(plan.plannedUnits / 5));
    expect(run.rateUnitsPerMin).toBeGreaterThan(0);
    expect(run.translatedUnits).toBe(plan.plannedUnits);
  });
});
