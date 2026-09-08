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
import { AUDIT } from "@/server/audit";
import type { SessionUser } from "@/server/authz";
import { db } from "@/server/db";
import { redis } from "@/server/redis";

/**
 * The sample-first dry run (spec-19).
 *
 * Two rules, and both are about rows, so both are checked against a real Postgres.
 *
 * 1. A sample must be SPREAD. Taking the first five pending units would take five UI strings —
 *    the extractor emits every message key before it emits anything else — and five UI strings say
 *    nothing about whether the glossary renders road terminology correctly.
 * 2. A sample is NOT a sync. It translates a handful of units out of thousands, so anything that
 *    would let the rest of the language look current afterwards is a bug: `lastSyncedAt` stays
 *    null, and the finish is not written into the audit log as a completed run.
 *
 * The gateway is stubbed. What is under test is which units get planned and how they are read back
 * out, and neither should depend on a model being up or on what it says.
 */
const aiJson = vi.fn();
const aiEmbed = vi.fn();
vi.mock("@/server/ai/client", () => ({
  aiJson: (...args: unknown[]) => aiJson(...args),
  aiEmbed: (...args: unknown[]) => aiEmbed(...args),
}));

const { planSampleRun, sampleResults } = await import("./sample");
const { executeRun } = await import("./runs");
const { createLanguage } = await import("./languages");

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const d = describe.skipIf(!enabled);
const RUN = randomBytes(3).toString("hex");
const CODE = `zs-${RUN}`.slice(0, 8);
const actor: SessionUser = {
  id: "",
  role: "ADMIN",
  email: `sample-${RUN}@example.no`,
};
const topicIds: string[] = [];
const signIds: string[] = [];

interface StubUnit {
  id: string;
  en?: Record<string, unknown>;
  value?: Record<string, unknown>;
}

/**
 * A structure-preserving echo: every string gains a marker, everything else keeps its shape.
 *
 * Shape matters more here than in the other suites — a sample deliberately mixes entity kinds, so
 * the stub has to answer for a question's options as convincingly as for a message's single
 * string, or the units under test would come back flagged for reasons the stub invented.
 */
function marked(source: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string") out[key] = `zs ${value}`;
    else if (key === "options" && Array.isArray(value))
      out[key] = (value as Array<{ key: string; text: string }>).map(
        (option) => ({ key: option.key, text: `zs ${option.text}` }),
      );
    else out[key] = value;
  }
  return out;
}

function modelAnswers() {
  aiJson.mockImplementation(async (opts: { vars: { unitsJson: string } }) => ({
    data: {
      units: (JSON.parse(opts.vars.unitsJson) as StubUnit[]).map((unit) => ({
        id: unit.id,
        value: marked(unit.en ?? unit.value ?? {}),
      })),
    },
    modelVersion: "stub",
    promptVersion: "translation.units@1.0.0",
    usage: { promptTokens: 200, completionTokens: 100 },
    providerLabel: "stub",
  }));
  aiEmbed.mockImplementation(async (texts: string[]) =>
    texts.map(() => [1, 0, 0]),
  );
}

beforeAll(async () => {
  if (!enabled) return;
  const user = await db.user.create({
    data: {
      email: actor.email,
      role: "ADMIN",
      emailVerifiedAt: new Date(),
      profile: { create: { firstName: "Sample", lastName: RUN } },
    },
    select: { id: true },
  });
  actor.id = user.id;
  await createLanguage(db, actor, {
    code: CODE,
    englishName: "Sampleic",
    nativeName: "Sampleic",
    shortLabel: "ZS",
    direction: "LTR",
    requiresApproval: false,
  });
  // Two extra entity kinds beyond the UI messages every install has, so "spread across kinds" is
  // something this fixture can actually demonstrate rather than assume.
  for (let i = 0; i < 3; i++) {
    const topic = await db.topic.create({
      data: {
        slug: `zs-${RUN}-${i}`,
        name: { en: `Topic ${i}`, nb: `Emne ${i}` },
        sortOrder: 900 + i,
      },
      select: { id: true },
    });
    topicIds.push(topic.id);
    const sign = await db.sign.create({
      data: {
        code: `ZS-${RUN}-${i}`,
        signClass: "FARE",
        svgPath: `/signs/zs-${RUN}-${i}.svg`,
        name: { en: `Sign ${i}`, nb: `Skilt ${i}` },
        meaning: { en: `Means ${i}`, nb: `Betyr ${i}` },
      },
      select: { id: true },
    });
    signIds.push(sign.id);
  }
});

afterAll(async () => {
  if (!enabled) return;
  await db.translation.deleteMany({ where: { locale: CODE } });
  await db.translationMemory.deleteMany({ where: { locale: CODE } });
  await db.translationJob.deleteMany({ where: { run: { locale: CODE } } });
  await db.translationRun.deleteMany({ where: { locale: CODE } });
  await db.language.deleteMany({ where: { code: CODE } });
  await db.sign.deleteMany({ where: { id: { in: signIds } } });
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
  // Every test starts from "nothing is translated yet" — a sample plans from what is pending, so
  // leftovers from the previous test would change what it picks.
  await db.translation.deleteMany({ where: { locale: CODE } });
  await db.translationMemory.deleteMany({ where: { locale: CODE } });
});

d("planSampleRun + sampleResults (spec-19)", () => {
  it("plans about five units spread across entity kinds, and reports them beside the source", async () => {
    const plan = await planSampleRun(db, CODE, {
      size: 5,
      startedById: actor.id,
    });

    expect(plan.plannedUnits).toBeGreaterThan(0);
    expect(plan.plannedUnits).toBeLessThanOrEqual(5);
    // The whole point of the round-robin: five units, not five of the same thing.
    expect(Object.keys(plan.byEntity).length).toBeGreaterThan(1);
    expect(Object.values(plan.byEntity).every((count) => count === 1)).toBe(
      true,
    );

    // Queued on creation — a sample has no cost-free preview step; it IS the preview.
    const row = await db.translationRun.findUniqueOrThrow({
      where: { id: plan.runId },
      select: { kind: true, enqueuedAt: true, startedById: true },
    });
    expect(row.kind).toBe("SAMPLE");
    expect(row.enqueuedAt).not.toBeNull();
    expect(row.startedById).toBe(actor.id);

    await executeRun(db, plan.runId, { leaseOwner: "t-sample" });

    const results = await sampleResults(db, plan.runId);
    expect(results.status).toBe("COMPLETED");
    expect(results.items.length).toBe(plan.plannedUnits);
    for (const item of results.items) {
      // Both sides present is the whole deliverable: a reviewer cannot judge a translation
      // without the English it came from.
      expect(item.source).not.toBeNull();
      expect(item.value).not.toBeNull();
    }
    expect(results.items[0]).toMatchObject({
      source: expect.any(Object),
      value: expect.any(Object),
    });

    // A sample is not a sync. Five units out of thousands must never let the rest of the language
    // look current — nor be written down as a run that finished the language.
    const language = await db.language.findUniqueOrThrow({
      where: { code: CODE },
      select: { lastSyncedAt: true },
    });
    expect(language.lastSyncedAt).toBeNull();
    expect(
      await db.auditLog.count({
        where: {
          action: AUDIT.translationRunFinished,
          entityType: "TranslationRun",
          entityId: plan.runId,
        },
      }),
    ).toBe(0);
  });

  it("reads the translation back through the run's jobs, so a later sync cannot detach it", async () => {
    const plan = await planSampleRun(db, CODE, {
      size: 3,
      startedById: actor.id,
    });
    await executeRun(db, plan.runId, { leaseOwner: "t-sample-2" });

    // `storeTranslations` stamps `runId` on every upsert, so a run that touches a sampled unit
    // afterwards takes ownership of the row. The sample screen must survive that.
    await db.translation.updateMany({
      where: { locale: CODE },
      data: { runId: null },
    });

    const results = await sampleResults(db, plan.runId);
    expect(results.items.length).toBe(plan.plannedUnits);
    expect(results.items.every((item) => item.value !== null)).toBe(true);
  });

  it("shows a unit the worker has not reached yet rather than hiding it", async () => {
    const plan = await planSampleRun(db, CODE, {
      size: 4,
      startedById: actor.id,
    });

    // Nothing has run: every job is planned, no translation row exists.
    const results = await sampleResults(db, plan.runId);
    expect(results.status).toBe("PENDING");
    expect(results.items.length).toBe(plan.plannedUnits);
    expect(results.items.every((item) => item.value === null)).toBe(true);
    expect(results.items.every((item) => item.source !== null)).toBe(true);
  });

  it("refuses a built-in language before it writes a run nobody can claim", async () => {
    await expect(
      planSampleRun(db, "nb", { size: 5, startedById: actor.id }),
    ).rejects.toThrow(/built-in/);
    expect(
      await db.translationRun.count({
        where: { locale: "nb", kind: "SAMPLE" },
      }),
    ).toBe(0);
  });
});
