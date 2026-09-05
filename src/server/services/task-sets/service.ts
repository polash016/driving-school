import type { Prisma, PrismaClient } from "@prisma/client";
import { InternalError, NotFoundError } from "@/lib/errors";
import {
  adminBuildSchema,
  buildResultSchema,
  buildTaskSetsInputSchema,
  publishTaskSetsInputSchema,
  studentTaskSetBoardSchema,
  taskSetAttemptSchema,
  type AdminBuild,
  type BuildResult,
  type StudentTaskSetBoard,
  type TaskSetAttempt,
} from "@/server/contracts/task-sets";
import { partitionBank, type PartitionItem } from "./partition";

/**
 * Task sets (spec-16): partition the approved bank into numbered slices, publish them, and serve
 * a student's standing across them.
 *
 * `poolSize = ceil(paperSize × POOL_RATIO)` is the whole leak-resistance argument: a paper is
 * `paperSize` drawn from a larger pool, so "set #7 is these 45 questions" is not a memorisable
 * fact even though #7 is a stable set.
 */
const POOL_RATIO = 1.5;

export function createTaskSetService(db: PrismaClient) {
  /**
   * Partition the approved bank into DRAFT sets.
   *
   * Nothing here reaches a student: publishing is a separate, deliberate act, so an admin always
   * sees a set's composition — and its warnings — before anyone sits it.
   */
  async function build(
    rawInput: unknown,
    requestedById: string | null,
  ): Promise<BuildResult> {
    const input = buildTaskSetsInputSchema.parse(rawInput);

    const licenseClass = await db.licenseClass.findFirst({
      where: { code: input.licenseClassCode, isEnabled: true },
      select: {
        id: true,
        questionCount: true,
        passMark: true,
        timeLimitMin: true,
      },
    });
    if (!licenseClass) {
      throw new NotFoundError({ licenseClassCode: input.licenseClassCode });
    }

    // Only what can actually be served: approved, undeleted, and holding a live variant. An item
    // with no active variant would be a hole in a slice — counted for coverage, undrawable in a
    // paper. Served by MasterItem_topicId_status_type_idx + ItemVariant_masterItemId_isActive_idx.
    const rows = await db.masterItem.findMany({
      where: {
        status: "APPROVED",
        deletedAt: null,
        variants: { some: { isActive: true } },
        OR: [{ licenseClassId: null }, { licenseClassId: licenseClass.id }],
      },
      select: { id: true, type: true, difficulty: true, topicId: true },
    });

    const rootSlug = await rootSlugByTopicId(db);
    const items: PartitionItem[] = rows.map((row) => ({
      masterItemId: row.id,
      topicSlug: rootSlug.get(row.topicId) ?? "unknown",
      type: row.type,
      difficulty: row.difficulty,
    }));

    const existing = await db.taskSet.findMany({
      where: { licenseClassId: licenseClass.id, status: "PUBLISHED" },
      select: { number: true, members: { select: { masterItemId: true } } },
    });

    const partition = partitionBank(items, {
      paperSize: licenseClass.questionCount,
      poolRatio: POOL_RATIO,
      existing: existing.map((set) => ({
        number: set.number,
        masterItemIds: set.members.map((member) => member.masterItemId),
      })),
    });

    // Publishing partial coverage would silently break the guarantee the whole model rests on:
    // "finish every set and you have met the bank". Fail loudly instead.
    if (partition.orphaned.length > 0) {
      throw new InternalError({
        reason: "partition orphaned items",
        count: partition.orphaned.length,
      });
    }

    const warnings = partition.slices.flatMap((slice) =>
      slice.composition.warnings.map(
        (warning) => `#${slice.number}: ${warning}`,
      ),
    );

    const buildRow = await db.taskSetBuild.create({
      data: {
        status: "READY",
        stats: {
          setsProposed: partition.slices.length,
          itemsPlaced: items.length,
          poolSize: Math.ceil(licenseClass.questionCount * POOL_RATIO),
        } as Prisma.InputJsonValue,
        warnings: warnings as unknown as Prisma.InputJsonValue,
        requestedById,
      },
      select: { id: true },
    });

    // A build is one unit: a half-written set list would leave numbers claimed by sets that do
    // not exist, and the next rebuild would then renumber everything.
    const created = await db.$transaction(async (tx) => {
      const out = [];
      for (const slice of partition.slices) {
        const paperSize = Math.min(
          licenseClass.questionCount,
          slice.masterItemIds.length,
        );
        const set = await tx.taskSet.create({
          data: {
            number: slice.number,
            licenseClassId: licenseClass.id,
            status: "DRAFT",
            poolSize: slice.masterItemIds.length,
            paperSize,
            // The official ratio, scaled when a short final slice cannot fill a full paper.
            passMark: Math.max(
              1,
              Math.ceil(
                (paperSize * licenseClass.passMark) /
                  licenseClass.questionCount,
              ),
            ),
            timeLimitSec: licenseClass.timeLimitMin * 60,
            composition: slice.composition as unknown as Prisma.InputJsonValue,
            buildId: buildRow.id,
          },
          select: {
            id: true,
            number: true,
            status: true,
            poolSize: true,
            paperSize: true,
            passMark: true,
            timeLimitSec: true,
            composition: true,
          },
        });
        // Membership is rewritten wholesale: masterItemId is the primary key, so an item moving
        // between slices is an update of one row, not a delete-and-insert race.
        for (const masterItemId of slice.masterItemIds) {
          await tx.taskSetMember.upsert({
            where: { masterItemId },
            create: { masterItemId, taskSetId: set.id },
            update: { taskSetId: set.id },
          });
        }
        out.push(set);
      }
      return out;
    });

    return buildResultSchema.parse({
      buildId: buildRow.id,
      sets: created,
      itemsPlaced: items.length,
      orphaned: partition.orphaned,
      warnings,
    });
  }

  /**
   * Swap a build's DRAFT sets in for the currently published ones, atomically.
   *
   * Superseded sets are ARCHIVED, never deleted: their progress rows and past attempts must still
   * explain a test a student actually sat.
   */
  async function publish(rawInput: unknown): Promise<void> {
    const input = publishTaskSetsInputSchema.parse(rawInput);

    const drafts = await db.taskSet.findMany({
      where: { buildId: input.buildId, status: "DRAFT" },
      select: { licenseClassId: true },
      take: 1,
    });
    if (drafts.length === 0)
      throw new NotFoundError({ buildId: input.buildId });
    const licenseClassId = drafts[0].licenseClassId;

    await db.$transaction(async (tx) => {
      // Archive first: the unique [licenseClassId, number] constraint means the old #7 must stop
      // being published before the new one can claim the number.
      await tx.taskSet.updateMany({
        where: {
          licenseClassId,
          status: "PUBLISHED",
          buildId: { not: input.buildId },
        },
        data: { status: "ARCHIVED" },
      });
      await tx.taskSet.updateMany({
        where: { buildId: input.buildId, status: "DRAFT" },
        data: { status: "PUBLISHED", publishedAt: new Date() },
      });
    });
  }

  /**
   * The student grid. Two indexed reads plus one open-attempt lookup — never a query per set.
   *
   * Served by TaskSet_licenseClassId_status_number_idx, TaskSetProgress_userId_idx and
   * ExamAttempt_userId_status_idx.
   */
  async function studentBoard(userId: string): Promise<StudentTaskSetBoard> {
    const [sets, progress, open] = await Promise.all([
      db.taskSet.findMany({
        where: { status: "PUBLISHED" },
        orderBy: { number: "asc" },
        select: {
          id: true,
          number: true,
          poolSize: true,
          paperSize: true,
          passMark: true,
          timeLimitSec: true,
        },
      }),
      db.taskSetProgress.findMany({
        where: { userId },
        select: {
          taskSetId: true,
          attempts: true,
          bestCorrect: true,
          bestOutOf: true,
          passedAt: true,
        },
      }),
      db.examAttempt.findMany({
        where: { userId, status: "IN_PROGRESS", taskSetId: { not: null } },
        select: { id: true, taskSetId: true },
      }),
    ]);

    const progressById = new Map(progress.map((row) => [row.taskSetId, row]));
    const openById = new Map(open.map((row) => [row.taskSetId!, row.id]));

    const mapped = sets.map((set) => {
      const row = progressById.get(set.id);
      return {
        ...set,
        attempts: row?.attempts ?? 0,
        bestCorrect: row?.bestCorrect ?? null,
        bestOutOf: row?.bestOutOf ?? null,
        passed: Boolean(row?.passedAt),
        inProgressAttemptId: openById.get(set.id) ?? null,
      };
    });

    return studentTaskSetBoardSchema.parse({
      sets: mapped,
      passedCount: mapped.filter((set) => set.passed).length,
      totalCount: mapped.length,
      nextNumber: mapped.find((set) => !set.passed)?.number ?? null,
    });
  }

  /** One set's attempt history for this student — the start sheet's list. */
  async function attemptsFor(
    userId: string,
    taskSetId: string,
  ): Promise<TaskSetAttempt[]> {
    // Served by ExamAttempt_taskSetId_userId_idx.
    const rows = await db.examAttempt.findMany({
      where: { userId, taskSetId },
      orderBy: { startedAt: "desc" },
      take: 10,
      select: {
        id: true,
        startedAt: true,
        submittedAt: true,
        status: true,
        correctCount: true,
        questionCountSnapshot: true,
        passed: true,
      },
    });
    return rows.map((row) =>
      taskSetAttemptSchema.parse({
        id: row.id,
        startedAt: row.startedAt,
        submittedAt: row.submittedAt,
        status: row.status,
        correctCount: row.correctCount,
        outOf: row.questionCountSnapshot,
        passed: row.passed,
      }),
    );
  }

  /** The admin build board, newest first. */
  async function listBuilds(limit = 5): Promise<AdminBuild[]> {
    // Served by TaskSetBuild_status_createdAt_idx.
    const builds = await db.taskSetBuild.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        createdAt: true,
        warnings: true,
        requestedBy: { select: { email: true } },
        taskSets: {
          orderBy: { number: "asc" },
          select: {
            id: true,
            number: true,
            status: true,
            poolSize: true,
            paperSize: true,
            passMark: true,
            timeLimitSec: true,
            composition: true,
          },
        },
      },
    });

    return builds.map((build) =>
      adminBuildSchema.parse({
        id: build.id,
        createdAt: build.createdAt,
        published: build.taskSets.some((set) => set.status === "PUBLISHED"),
        requestedByEmail: build.requestedBy?.email ?? null,
        warnings: Array.isArray(build.warnings) ? build.warnings : [],
        sets: build.taskSets,
      }),
    );
  }

  return { build, publish, studentBoard, attemptsFor, listBuilds };
}

export type TaskSetService = ReturnType<typeof createTaskSetService>;

/** topicId → ROOT slug, so a slice is balanced at the distribution level the blueprint uses. */
async function rootSlugByTopicId(
  db: PrismaClient,
): Promise<Map<string, string>> {
  const topics = await db.topic.findMany({
    where: { deletedAt: null },
    select: { id: true, slug: true, parentId: true },
  });
  const byId = new Map(topics.map((topic) => [topic.id, topic]));
  const out = new Map<string, string>();
  for (const topic of topics) {
    let node = topic;
    while (node.parentId && byId.has(node.parentId)) {
      node = byId.get(node.parentId)!;
    }
    out.set(topic.id, node.slug);
  }
  return out;
}
