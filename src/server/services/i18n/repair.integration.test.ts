import { randomBytes } from "node:crypto";
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
 * Auto-repair, against a real Postgres (spec-19).
 *
 * Every rule worth testing here is a rule about rows: which flagged rows a repair run may plan,
 * which of them may be written back, and which of them get charged an attempt. None of that can be
 * checked against a mock database, so this suite talks to the test one.
 *
 * The gateway is stubbed. Two prompts reach the stub — `translation.repair` sends
 * `{ id, en, previous, problems, … }` and the QA back-translation sends `{ id, value }` — and it
 * answers whichever arrived, so the QA pass stays honest instead of collapsing into QA_UNAVAILABLE.
 */
const aiJson = vi.fn();
const aiEmbed = vi.fn();
vi.mock("@/server/ai/client", () => ({
  aiJson: (...args: unknown[]) => aiJson(...args),
  aiEmbed: (...args: unknown[]) => aiEmbed(...args),
}));

const { executeRun } = await import("./runs");
const { planRepairRun, repairCandidates } = await import("./repair");
const { extractAll } = await import("./extract");
const { createLanguage } = await import("./languages");

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const d = describe.skipIf(!enabled);
const RUN = randomBytes(3).toString("hex");
const CODE = `zx-${RUN}`.slice(0, 8);
const actor: SessionUser = {
  id: "",
  role: "ADMIN",
  email: `repair-${RUN}@example.no`,
};
const topicIds: string[] = [];

interface StubUnit {
  id: string;
  en?: Record<string, unknown>;
  value?: Record<string, unknown>;
}

/** Whatever came in, with the name marked as repaired — numbers and keys untouched. */
function answer(unitsJson: string) {
  const items = JSON.parse(unitsJson) as StubUnit[];
  return items.map((unit) => {
    const source = unit.en ?? unit.value ?? {};
    const name = typeof source.name === "string" ? source.name : "";
    return { id: unit.id, value: { ...source, name: `fixed ${name}` } };
  });
}

function modelAnswers() {
  aiJson.mockImplementation(async (opts: { vars: { unitsJson: string } }) => ({
    data: { units: answer(opts.vars.unitsJson) },
    modelVersion: "stub",
    promptVersion: "translation.repair@1.0.0",
    usage: { promptTokens: 40, completionTokens: 20 },
    providerLabel: "stub",
  }));
  aiEmbed.mockImplementation(async (texts: string[]) =>
    texts.map(() => [1, 0, 0]),
  );
}

/** The extractor's own hash for a topic — a repair candidate must match it exactly. */
async function sourceHashFor(topicId: string): Promise<string> {
  const language = await db.language.findUniqueOrThrow({
    where: { code: CODE },
    select: { glossaryVersion: true },
  });
  const units = await extractAll(db, {
    glossaryVersion: language.glossaryVersion,
    only: ["TOPIC"],
  });
  return units.find((unit) => unit.entityId === topicId)!.sourceHash;
}

/** One flagged topic translation, exactly as a failed QA pass would have left it. */
async function seedFlagged(
  topicId: string,
  overrides: {
    qaFlags?: string[];
    qaReport?: object;
    repairAttempts?: number;
    sourceHash?: string;
    value?: object;
  } = {},
) {
  const sourceHash = overrides.sourceHash ?? (await sourceHashFor(topicId));
  return db.translation.create({
    data: {
      locale: CODE,
      entity: "TOPIC",
      entityId: topicId,
      value: overrides.value ?? { name: "Tema 50" },
      status: "NEEDS_REVIEW",
      sourceHash,
      qaFlags: overrides.qaFlags ?? ["NUMBER_DRIFT"],
      qaReport: overrides.qaReport ?? {
        source: "model",
        issues: [{ code: "NUMBER_DRIFT", blocking: true, detail: "80 to 50" }],
      },
      repairAttempts: overrides.repairAttempts ?? 0,
    },
    select: { id: true },
  });
}

beforeAll(async () => {
  if (!enabled) return;
  const user = await db.user.create({
    data: {
      email: actor.email,
      role: "ADMIN",
      emailVerifiedAt: new Date(),
      profile: { create: { firstName: "Repair", lastName: RUN } },
    },
    select: { id: true },
  });
  actor.id = user.id;
  await createLanguage(db, actor, {
    code: CODE,
    englishName: "Repairic",
    nativeName: "Repairic",
    shortLabel: "ZX",
    direction: "LTR",
    requiresApproval: false,
  });
  // The language asks for NO semantic sampling at all. A repair run must QA every unit anyway —
  // scrutiny goes up on a second attempt, never down — and with the rate at 1 that would be
  // indistinguishable from the ordinary path.
  await db.language.update({
    where: { code: CODE },
    data: { qaSampleRate: 0 },
    select: { code: true },
  });
  for (let i = 0; i < 2; i++) {
    const topic = await db.topic.create({
      data: {
        slug: `zx-${RUN}-${i}`,
        name: { en: `Topic 80`, nb: `Emne 80` },
        sortOrder: 950 + i,
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
  await db.translation.deleteMany({ where: { locale: CODE } });
  await db.translationMemory.deleteMany({ where: { locale: CODE } });
});

d("repair (spec-19)", () => {
  it("re-translates a flagged unit with the finding in the prompt, re-QAs it, and promotes it", async () => {
    await seedFlagged(topicIds[0]);
    let repairVars: { unitsJson: string } | null = null;
    let repairTemperature: number | undefined;
    aiJson.mockImplementation(
      async (opts: {
        prompt: { id: string };
        temperature?: number;
        vars: { unitsJson: string };
      }) => {
        if (opts.prompt.id === "translation.repair") {
          repairVars = opts.vars;
          repairTemperature = opts.temperature;
        }
        return {
          data: { units: answer(opts.vars.unitsJson) },
          modelVersion: "stub",
          promptVersion: "p",
          usage: { promptTokens: 40, completionTokens: 20 },
          providerLabel: "stub",
        };
      },
    );

    const plan = await planRepairRun(db, CODE, { startedById: actor.id });
    expect(plan.plannedUnits).toBe(1);

    const progress = await executeRun(db, plan.runId, {
      leaseOwner: "t-repair",
    });
    expect(progress.done).toBe(true);

    // The finding, its detail, and the text that produced it all reach the model.
    const sent = (repairVars as unknown as { unitsJson: string }).unitsJson;
    expect(sent).toContain("NUMBER_DRIFT");
    expect(sent).toContain("80 to 50");
    expect(sent).toContain("Tema 50");
    expect(repairTemperature).toBe(0);
    // Every repaired unit is QA'd — the back-translation ran even though qaSampleRate is 0.
    expect(
      aiJson.mock.calls.some(
        (call) =>
          (call[0] as { prompt: { id: string } }).prompt.id ===
          "translation.back",
      ),
    ).toBe(true);

    const row = await db.translation.findFirstOrThrow({
      where: { locale: CODE, entity: "TOPIC", entityId: topicIds[0] },
    });
    expect(row.status).toBe("MACHINE");
    expect(row.repairAttempts).toBe(1);
    expect(row.qaFlags).toEqual([]);
    expect(row.value).toEqual({ name: "fixed Topic 80" });
  });

  it("does not touch a row a human approved while the batch ran", async () => {
    await seedFlagged(topicIds[0]);
    aiJson.mockImplementationOnce(
      async (opts: { vars: { unitsJson: string } }) => {
        // A reviewer reached this row while the repair call was in flight.
        await db.translation.updateMany({
          where: { locale: CODE, entity: "TOPIC", entityId: topicIds[0] },
          data: {
            status: "APPROVED",
            value: { name: "human" },
            reviewedById: actor.id,
            reviewedAt: new Date(),
          },
        });
        const items = JSON.parse(opts.vars.unitsJson) as StubUnit[];
        return {
          data: {
            units: items.map((unit) => ({
              id: unit.id,
              value: { name: "machine 80" },
            })),
          },
          modelVersion: "stub",
          promptVersion: "p",
          usage: { promptTokens: 1, completionTokens: 1 },
          providerLabel: "stub",
        };
      },
    );

    const plan = await planRepairRun(db, CODE, { startedById: actor.id });
    await executeRun(db, plan.runId, { leaseOwner: "t-superseded" });

    const row = await db.translation.findFirstOrThrow({
      where: { locale: CODE, entity: "TOPIC", entityId: topicIds[0] },
    });
    expect(row.status).toBe("APPROVED");
    expect(row.value).toEqual({ name: "human" });
    expect(row.reviewedById).toBe(actor.id);
    // Not written, not charged, and not remembered.
    expect(row.repairAttempts).toBe(0);
    expect(await db.translationMemory.count({ where: { locale: CODE } })).toBe(
      0,
    );
    expect(
      await db.translationJob.count({
        where: { runId: plan.runId, state: "SKIPPED", error: "superseded" },
      }),
    ).toBe(1);
  });

  it("stops planning a unit after three consumed attempts; infrastructure flags cost nothing", async () => {
    const seeded = await seedFlagged(topicIds[0], { repairAttempts: 3 });
    expect(
      (await repairCandidates(db, CODE)).map((u) => u.entityId),
    ).not.toContain(topicIds[0]);

    // The same row, flagged only because QA itself could not run: re-check it, charge nothing.
    await db.translation.update({
      where: { id: seeded.id },
      data: {
        qaFlags: ["QA_UNAVAILABLE", "LENGTH_OUTLIER"],
        qaReport: { source: "model", issues: [], backTranslation: "failed" },
        repairAttempts: 0,
        value: { name: "Tema 80" },
      },
    });

    const plan = await planRepairRun(db, CODE, { startedById: actor.id });
    expect(plan.plannedUnits).toBe(1);
    const progress = await executeRun(db, plan.runId, { leaseOwner: "t-reqa" });
    expect(progress.done).toBe(true);

    const row = await db.translation.findFirstOrThrow({
      where: { locale: CODE, entity: "TOPIC", entityId: topicIds[0] },
    });
    expect(row.repairAttempts).toBe(0);
    // Its text was never the problem, so it was never re-translated — only re-QA'd.
    expect(row.value).toEqual({ name: "Tema 80" });
    expect(row.status).toBe("MACHINE");
    expect(row.qaFlags).toEqual([]);
    expect(
      aiJson.mock.calls.filter(
        (call) =>
          (call[0] as { prompt: { id: string } }).prompt.id ===
          "translation.repair",
      ),
    ).toHaveLength(0);
  });

  it("leaves a stale row and a derived variant to the paths that own them", async () => {
    // Its source moved after it was flagged: that is a SYNC re-translation, not a repair attempt.
    await seedFlagged(topicIds[0], { sourceHash: "stale-hash" });
    // Variants are derived from their master, and the extractor never emits one.
    await db.translation.create({
      data: {
        locale: CODE,
        entity: "ITEM_VARIANT",
        entityId: `zx-variant-${RUN}`,
        value: { stem: "x", options: [] },
        status: "NEEDS_REVIEW",
        sourceHash: "whatever",
        qaFlags: ["NUMBER_DRIFT"],
      },
      select: { id: true },
    });
    // And one genuine candidate, so an empty result cannot pass this test by accident.
    await seedFlagged(topicIds[1]);

    const candidates = await repairCandidates(db, CODE);
    expect(candidates.map((unit) => unit.entityId)).toEqual([topicIds[1]]);
  });
});
