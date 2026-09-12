import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/server/authz";
import { db } from "@/server/db";
import { redis } from "@/server/redis";
import type { TranslationUnit } from "./units";

/**
 * A language that keeps itself translated (spec-20).
 *
 * Adding a language used to create a row and nothing else, and approving a question afterwards
 * left it English in every added language until somebody remembered to start a sync. Now the add
 * enqueues a FULL run, every translatable-content write leaves a stamp, and the idle worker turns
 * a stamp into a SYNC — compared against the last sync run's PLAN time, so an approval that lands
 * while a run is executing is not lost.
 *
 * The extractor is stubbed to two units so planning is instant and the pending set is exact.
 */
const extractAll = vi.fn();
vi.mock("./extract", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./extract")>()),
  extractAll: (...args: unknown[]) => extractAll(...args),
}));

const { createLanguage } = await import("./languages");
const { planAutoSyncs, planSyncIfPending, requestTranslationSync } =
  await import("./sync");
const { publishItem } = await import("@/server/services/question-bank/publish");

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const d = describe.skipIf(!enabled);
const RUN = randomBytes(3).toString("hex");
const AUTO = `za-${RUN}`.slice(0, 8);
const MANUAL = `zm-${RUN}`.slice(0, 8);
const actor: SessionUser = {
  id: "",
  role: "ADMIN",
  email: `sync-${RUN}@example.no`,
};
const UNITS: TranslationUnit[] = [
  {
    entity: "TOPIC",
    entityId: `fake-topic-1-${RUN}`,
    en: { name: "One" },
    nb: { name: "En" },
    label: "One",
    sourceHash: "h1",
  },
  {
    entity: "TOPIC",
    entityId: `fake-topic-2-${RUN}`,
    en: { name: "Two" },
    nb: { name: "To" },
    label: "Two",
    sourceHash: "h2",
  },
];
let topicId = "";
const masterIds: string[] = [];

async function stampOf(code: string): Promise<Date | null> {
  const row = await db.language.findUniqueOrThrow({
    where: { code },
    select: { syncRequestedAt: true },
  });
  return row.syncRequestedAt;
}

async function translated(unit: TranslationUnit) {
  await db.translation.create({
    data: {
      locale: AUTO,
      entity: unit.entity,
      entityId: unit.entityId,
      sourceHash: unit.sourceHash,
      status: "MACHINE",
      value: { name: `[${AUTO}] ${(unit.en as { name: string }).name}` },
    },
  });
}

beforeAll(async () => {
  if (!enabled) return;
  extractAll.mockResolvedValue(UNITS);
  const user = await db.user.create({
    data: {
      email: actor.email,
      role: "ADMIN",
      emailVerifiedAt: new Date(),
      profile: { create: { firstName: "Sync", lastName: RUN } },
    },
    select: { id: true },
  });
  actor.id = user.id;
  topicId = (
    await db.topic.create({
      data: {
        slug: `zs-${RUN}`,
        name: { en: "Sync", nb: "Sync" },
        sortOrder: 950,
      },
      select: { id: true },
    })
  ).id;
});

afterAll(async () => {
  if (!enabled) return;
  for (const code of [AUTO, MANUAL]) {
    await db.translation.deleteMany({ where: { locale: code } });
    await db.translationMemory.deleteMany({ where: { locale: code } });
    await db.translationJob.deleteMany({ where: { run: { locale: code } } });
    await db.translationRun.deleteMany({ where: { locale: code } });
    await db.language.deleteMany({ where: { code } });
  }
  await db.itemVariant.deleteMany({
    where: { masterItemId: { in: masterIds } },
  });
  await db.masterItem.deleteMany({ where: { id: { in: masterIds } } });
  await db.topic.deleteMany({ where: { id: topicId } });
  await db.auditLog.deleteMany({ where: { actorId: actor.id } });
  await db.user.deleteMany({ where: { id: actor.id } });
  await db.$disconnect();
  await redis.quit().catch(() => undefined);
});

d("a language that keeps itself translated (spec-20)", () => {
  it("a new language publishes machine output by default and starts translating at once", async () => {
    const created = await createLanguage(db, actor, {
      code: AUTO,
      englishName: "Auto",
      nativeName: "Auto",
      shortLabel: "ZA",
    });
    expect(created.code).toBe(AUTO);
    const row = await db.language.findUniqueOrThrow({
      where: { code: AUTO },
      select: { requiresApproval: true, autoTranslate: true },
    });
    expect(row).toEqual({ requiresApproval: false, autoTranslate: true });

    const run = await db.translationRun.findFirst({
      where: { locale: AUTO },
      select: {
        kind: true,
        enqueuedAt: true,
        plannedUnits: true,
        startedById: true,
      },
    });
    expect(run).toMatchObject({
      kind: "FULL",
      plannedUnits: UNITS.length,
      startedById: actor.id,
    });
    expect(run?.enqueuedAt).not.toBeNull();
  });

  it("a language added with the switch off waits for an admin", async () => {
    await createLanguage(db, actor, {
      code: MANUAL,
      englishName: "Manual",
      nativeName: "Manual",
      shortLabel: "ZM",
      autoTranslate: false,
    });
    expect(await db.translationRun.count({ where: { locale: MANUAL } })).toBe(
      0,
    );
  });

  it("a content change stamps every language that keeps itself translated, and no other", async () => {
    await requestTranslationSync(db);
    expect(await stampOf(AUTO)).not.toBeNull();
    expect(await stampOf(MANUAL)).toBeNull();
    expect(
      await db.language.count({
        where: { isBuiltIn: true, syncRequestedAt: { not: null } },
      }),
    ).toBe(0);
  });

  it("publishing a question is such a change", async () => {
    await db.language.update({
      where: { code: AUTO },
      data: { syncRequestedAt: null },
    });
    const master = await db.masterItem.create({
      data: {
        type: "TEXT",
        status: "DRAFT",
        topicId,
        difficulty: 2,
        content: {
          en: {
            stem: `Sync ${RUN}?`,
            options: [
              { key: "a", text: "Yes" },
              { key: "b", text: "No" },
            ],
            explanation: "Because.",
          },
          nb: {
            stem: `Synk ${RUN}?`,
            options: [
              { key: "a", text: "Ja" },
              { key: "b", text: "Nei" },
            ],
            explanation: "Fordi.",
          },
        },
        correctOptionKey: "a",
        legalCitations: [],
        createdBy: "HUMAN",
      },
      select: { id: true },
    });
    masterIds.push(master.id);
    await publishItem(db, master.id);
    expect(await stampOf(AUTO)).not.toBeNull();
  });

  it("the idle worker plans nothing while the first run is still queued", async () => {
    expect(await planAutoSyncs(db)).toEqual([]);
  });

  it("plans a sync once the stamp is newer than the last sync run's plan, for what is missing only", async () => {
    // As if the worker had finished the FULL run with one unit landed and one not.
    const full = await db.translationRun.findFirstOrThrow({
      where: { locale: AUTO, kind: "FULL" },
      select: { id: true },
    });
    await db.translationRun.update({
      where: { id: full.id },
      data: { status: "COMPLETED", finishedAt: new Date() },
    });
    await translated(UNITS[0]);
    await db.language.update({
      where: { code: AUTO },
      data: { syncRequestedAt: new Date() },
    });

    const planned = await planAutoSyncs(db);
    expect(planned).toHaveLength(1);
    const run = await db.translationRun.findUniqueOrThrow({
      where: { id: planned[0] },
      select: {
        locale: true,
        kind: true,
        plannedUnits: true,
        enqueuedAt: true,
        startedById: true,
      },
    });
    expect(run).toMatchObject({
      locale: AUTO,
      kind: "SYNC",
      plannedUnits: 1,
      startedById: null,
    });
    expect(run.enqueuedAt).not.toBeNull();
  });

  it("does not plan again for a stamp older than the run it already planned", async () => {
    const sync = await db.translationRun.findFirstOrThrow({
      where: { locale: AUTO, kind: "SYNC" },
      orderBy: { createdAt: "desc" },
      select: { id: true, createdAt: true },
    });
    await db.translationRun.update({
      where: { id: sync.id },
      data: { status: "COMPLETED", finishedAt: new Date() },
    });
    await db.language.update({
      where: { code: AUTO },
      data: { syncRequestedAt: new Date(sync.createdAt.getTime() - 1000) },
    });
    expect(await planAutoSyncs(db)).toEqual([]);
  });

  it("clears the stamp when nothing is pending rather than planning an empty run", async () => {
    await translated(UNITS[1]);
    await db.language.update({
      where: { code: AUTO },
      data: { syncRequestedAt: new Date() },
    });
    const before = await db.translationRun.count({ where: { locale: AUTO } });
    expect(await planSyncIfPending(db, AUTO)).toBeNull();
    expect(await stampOf(AUTO)).toBeNull();
    expect(await db.translationRun.count({ where: { locale: AUTO } })).toBe(
      before,
    );
  });

  it("never plans for a language whose switch is off, however stale", async () => {
    await db.language.update({
      where: { code: MANUAL },
      data: { syncRequestedAt: new Date() },
    });
    expect(await planAutoSyncs(db)).toEqual([]);
  });
});
