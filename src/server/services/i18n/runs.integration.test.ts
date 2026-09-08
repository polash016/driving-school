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
  for (let i = 0; i < 7; i++) {
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
});

async function planTopics() {
  return planRun(db, CODE, {
    kind: "SINGLE_ENTITY",
    only: ["TOPIC"],
    startedById: actor.id,
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
    const first = await executeRun(db, plan.runId, { leaseOwner: "t-pause" });
    expect(first.status).toBe("PAUSED");
    expect(first.stopReason).toBe("paused");
    // The flag, not the status, is what holds a pause: PAUSED alone already means "a slice ended".
    const again = await executeRun(db, plan.runId, { leaseOwner: "t-other" });
    expect(again.stopReason).toBe("notClaimed");
    await db.translationRun.update({
      where: { id: plan.runId },
      data: { pauseRequested: false },
    });
    const resumed = await executeRun(db, plan.runId, {
      leaseOwner: "t-resume",
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
    });
    expect(blocked.stopReason).toBe("localeBusy");
    await db.translationRun.update({
      where: { id: other.runId },
      data: { status: "CANCELLED", leaseOwner: null, leaseExpiresAt: null },
    });
    const done = await executeRun(db, plan.runId, { leaseOwner: "t-rate" });
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
