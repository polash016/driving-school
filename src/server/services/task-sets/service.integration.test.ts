import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTaskSetService, type TaskSetService } from "./service";

/**
 * Task set build/publish against a real Postgres (teoripro_test).
 * Run: docker compose -f docker-compose.dev.yml up -d && TEST_DATABASE_URL set in .env.
 */
const url = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!url);

const db = url ? new PrismaClient({ datasourceUrl: url }) : (null as never);
let service: TaskSetService;

const content = (id: string) => ({
  en: {
    stem: `Question ${id}: what applies?`,
    options: [
      { key: "a", text: `Yield ${id}` },
      { key: "b", text: `Continue ${id}` },
      { key: "c", text: `Stop ${id}` },
    ],
  },
  nb: {
    stem: `Spørsmål ${id}: hva gjelder?`,
    options: [
      { key: "a", text: `Vik ${id}` },
      { key: "b", text: `Fortsett ${id}` },
      { key: "c", text: `Stopp ${id}` },
    ],
  },
});

/** 150 approved items over 3 root topics — enough for several slices at paperSize 45. */
async function seedBank(): Promise<void> {
  await db.$executeRawUnsafe(`
    TRUNCATE "TaskSetProgress","TaskSetMember","TaskSet","TaskSetBuild",
      "ExamAttemptQuestion","ExamAttempt","ItemVariant","MasterItemCitation",
      "MasterItem","ExamBlueprint","LicenseClass","Topic","Profile","User" CASCADE
  `);

  await db.user.create({
    data: { id: "user-1", email: "user-1@test.local", role: "STUDENT" },
  });

  await db.licenseClass.create({
    data: {
      code: "TS",
      name: { en: "Task set class", nb: "Oppgavesettklasse" },
      questionCount: 45,
      timeLimitMin: 90,
      passMark: 38,
    },
  });

  const topics = [];
  for (const slug of ["signs", "yield", "vehicle"]) {
    topics.push(
      await db.topic.create({
        data: { slug, name: { en: slug, nb: slug } },
      }),
    );
  }

  for (let i = 0; i < 150; i++) {
    const id = `ts-m${String(i).padStart(3, "0")}`;
    await db.masterItem.create({
      data: {
        id,
        type: i % 7 === 0 ? "IMAGE" : i % 5 === 0 ? "SIGN" : "TEXT",
        status: "APPROVED",
        topicId: topics[i % topics.length].id,
        difficulty: (i % 5) + 1,
        content: content(id),
        correctOptionKey: "a",
        legalCitations: [],
        createdBy: "HUMAN",
      },
    });
    await db.itemVariant.create({
      data: {
        id: `${id}-v0`,
        masterItemId: id,
        masterVersion: 1,
        contentHash: `hash-${id}`,
        content: content(id),
        correctOptionKey: "a",
        explanation: { en: "Because.", nb: "Fordi.", citations: [] },
        source: "TEMPLATE",
      },
    });
  }
}

beforeAll(async () => {
  if (!url) return;
  await seedBank();
  service = createTaskSetService(db);
});

afterAll(async () => {
  if (url) await db.$disconnect();
});

d("taskSetService (integration)", () => {
  beforeEach(async () => {
    await db.taskSetProgress.deleteMany();
    await db.taskSetMember.deleteMany();
    await db.taskSet.deleteMany();
    await db.taskSetBuild.deleteMany();
  });

  it("places every servable approved item and reports zero orphans", async () => {
    const result = await service.build({ licenseClassCode: "TS" }, null);

    const approved = await db.masterItem.count({
      where: {
        status: "APPROVED",
        deletedAt: null,
        variants: { some: { isActive: true } },
      },
    });
    const placed = await db.taskSetMember.count();

    expect(result.orphaned).toEqual([]);
    expect(result.itemsPlaced).toBe(approved);
    // The coverage guarantee, checked the way spec-16's acceptance list checks it.
    expect(placed).toBe(approved);
  });

  it("makes every slice at least one pool deep, with the official paper and pass mark", async () => {
    const result = await service.build({ licenseClassCode: "TS" }, null);

    // 150 items at pool ceil(45 × 1.5) = 68 → 2 slices of 75, not 2 of 68 plus a 14-question stub.
    expect(result.sets).toHaveLength(2);
    for (const set of result.sets) {
      expect(set.poolSize).toBeGreaterThanOrEqual(68);
      // Values come from LicenseClass config, never hardcoded in the service.
      expect(set.paperSize).toBe(45);
      expect(set.passMark).toBe(38);
      expect(set.timeLimitSec).toBe(90 * 60);
    }
  });

  it("gives every slice a share of every topic", async () => {
    const result = await service.build({ licenseClassCode: "TS" }, null);
    for (const set of result.sets) {
      expect(Object.keys(set.composition.topicCounts)).toHaveLength(3);
      expect(set.composition.warnings).toEqual([]);
    }
  });

  it("keeps sets DRAFT until published, and only then serves them", async () => {
    const built = await service.build({ licenseClassCode: "TS" }, null);
    expect(built.sets.every((set) => set.status === "DRAFT")).toBe(true);

    const before = await service.studentBoard("user-1");
    expect(before.sets).toHaveLength(0);
    expect(before.totalCount).toBe(0);

    await service.publish({ buildId: built.buildId });

    const after = await service.studentBoard("user-1");
    expect(after.sets.length).toBeGreaterThan(0);
    expect(after.nextNumber).toBe(1);
    expect(after.passedCount).toBe(0);
  });

  it("archives the previous published sets rather than deleting them", async () => {
    const first = await service.build({ licenseClassCode: "TS" }, null);
    await service.publish({ buildId: first.buildId });

    const second = await service.build({ licenseClassCode: "TS" }, null);
    await service.publish({ buildId: second.buildId });

    const archived = await db.taskSet.count({ where: { status: "ARCHIVED" } });
    const published = await db.taskSet.count({ where: { status: "PUBLISHED" } });
    // Nothing is destroyed: a student's past attempt must stay explainable.
    expect(archived).toBe(first.sets.length);
    expect(published).toBe(second.sets.length);
  });

  it("keeps a slice's number across a rebuild when its membership is unchanged", async () => {
    const first = await service.build({ licenseClassCode: "TS" }, null);
    await service.publish({ buildId: first.buildId });
    const before = (await service.studentBoard("user-1")).sets.map(
      (set) => set.number,
    );

    const second = await service.build({ licenseClassCode: "TS" }, null);
    await service.publish({ buildId: second.buildId });
    const after = (await service.studentBoard("user-1")).sets.map(
      (set) => set.number,
    );

    expect(after).toEqual(before);
  });

  it("reports a student's standing without a query per set", async () => {
    const built = await service.build({ licenseClassCode: "TS" }, null);
    await service.publish({ buildId: built.buildId });
    const board = await service.studentBoard("user-1");

    await db.taskSetProgress.create({
      data: {
        userId: "user-1",
        taskSetId: board.sets[0].id,
        attempts: 3,
        bestCorrect: 41,
        bestOutOf: 45,
        passedAt: new Date("2026-09-01"),
      },
    });

    const updated = await service.studentBoard("user-1");
    expect(updated.sets[0]).toMatchObject({
      attempts: 3,
      bestCorrect: 41,
      passed: true,
    });
    expect(updated.passedCount).toBe(1);
    // The hero points at the lowest set NOT yet passed.
    expect(updated.nextNumber).toBe(2);
  });

  it("refuses to publish a build that has no draft sets", async () => {
    await expect(service.publish({ buildId: "nope" })).rejects.toThrow();
  });

  it("lists builds for the admin board with their warnings", async () => {
    const built = await service.build({ licenseClassCode: "TS" }, null);
    const builds = await service.listBuilds();
    expect(builds[0].id).toBe(built.buildId);
    expect(builds[0].published).toBe(false);
    expect(builds[0].sets).toHaveLength(built.sets.length);
  });
});
