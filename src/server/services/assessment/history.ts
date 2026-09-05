import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { NotFoundError } from "@/lib/errors";
import { pickBilingualText } from "@/lib/i18n-content";
import type { AppLocale } from "../../../../config/school.config";
import { authorizeOwner, type SessionUser } from "@/server/authz";
import {
  idSchema,
  localeSchema,
  paginatedSchema,
} from "@/server/contracts/common";
import {
  attemptModeSchema,
  attemptStatusSchema,
} from "@/server/contracts/models";

/**
 * A student's own exam record (spec-04b). Every attempt they have sat, with the score that was
 * recorded and whether it still verifies.
 *
 * Retention is deliberate: attempts are never deleted (the `attempt_result_final` trigger
 * refuses), because "show me the test I passed" has to be answerable months later, and a
 * disputed mark is answerable only while its record exists.
 */

export const attemptKindSchema = z.enum([
  "TASK_SET",
  "TEST",
  "PRACTICE",
  "TOPIC",
  "SIGN",
]);
export type AttemptKind = z.infer<typeof attemptKindSchema>;

export const attemptSummarySchema = z
  .object({
    id: idSchema,
    mode: attemptModeSchema,
    status: attemptStatusSchema,
    startedAt: z.date(),
    submittedAt: z.date().nullable(),
    questionCount: z.int().min(0),
    correctCount: z.int().min(0).nullable(),
    passMark: z.int().nullable(),
    passed: z.boolean().nullable(),
    /** Present once submitted — the evidence the result has not been altered since. */
    attested: z.boolean(),
    /** Whether this attempt qualified towards the pass guarantee, decided when it started. */
    countsTowardGuarantee: z.boolean(),
    /** How it is named to the student: a configured test is a TEST whatever its engine mode. */
    kind: attemptKindSchema,
    /**
     * The set's student-facing number, when this was a task set (spec-16/18).
     *
     * Without it every row in the history reads "Task set", which is the one thing a student
     * cannot use to tell their attempts apart.
     */
    taskSetNumber: z.number().int().nullable(),
    durationSec: z.int().min(0).nullable(),
  })
  .strict();
export type AttemptSummary = z.infer<typeof attemptSummarySchema>;

const historySchema = paginatedSchema(attemptSummarySchema);

export const historyInputSchema = z
  .object({
    page: z.int().min(1).default(1),
    pageSize: z.int().min(1).max(50).default(10),
    locale: localeSchema.optional(),
    /**
     * Tests only, by default: the record is about tests sat, not questions practised. Practice
     * is not lost — it is simply not what "my tests" means.
     */
    onlyTests: z.boolean().default(true),
  })
  .strict();

/** Served by ExamAttempt(userId, startedAt DESC). */
export async function listAttemptHistory(
  db: PrismaClient,
  session: SessionUser,
  userId: string,
  rawInput: unknown = {},
) {
  // A student sees only their own history; staff may open a student's record for support.
  authorizeOwner(session, userId);
  const input = historyInputSchema.parse(rawInput);

  const where: Prisma.ExamAttemptWhereInput = input.onlyTests
    ? { userId, ...TEST_ONLY }
    : { userId };

  const [rows, totalCount] = await Promise.all([
    db.examAttempt.findMany({
      where,
      select: {
        id: true,
        mode: true,
        status: true,
        startedAt: true,
        submittedAt: true,
        questionCountSnapshot: true,
        taskSet: { select: { number: true } },
        correctCount: true,
        passMarkSnapshot: true,
        passed: true,
        resultHash: true,
        countsTowardGuarantee: true,
        setupSnapshot: true,
      },
      orderBy: { startedAt: "desc" },
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
    }),
    db.examAttempt.count({ where }),
  ]);

  return historySchema.parse({
    items: rows.map((row) => ({
      id: row.id,
      mode: row.mode,
      status: row.status,
      startedAt: row.startedAt,
      submittedAt: row.submittedAt,
      questionCount: row.questionCountSnapshot,
      correctCount: row.correctCount,
      passMark: row.passMarkSnapshot,
      passed: row.passed,
      attested: row.resultHash !== null,
      countsTowardGuarantee: row.countsTowardGuarantee,
      kind: kindOf(row.mode, row.setupSnapshot),
      taskSetNumber: row.taskSet?.number ?? null,
      durationSec: row.submittedAt
        ? Math.max(
            0,
            Math.round(
              (row.submittedAt.getTime() - row.startedAt.getTime()) / 1000,
            ),
          )
        : null,
    })),
    page: input.page,
    pageSize: input.pageSize,
    totalCount,
  });
}

export const resumableAttemptSchema = z
  .object({
    id: idSchema,
    mode: attemptModeSchema,
    kind: attemptKindSchema,
    startedAt: z.date(),
    questionCount: z.int().min(1),
    answeredCount: z.int().min(0),
    /** null = untimed. 0 would mean the clock has run out, which is never returned as resumable. */
    timeRemainingSec: z.int().min(0).nullable(),
    countsTowardGuarantee: z.boolean(),
  })
  .strict();
export type ResumableAttempt = z.infer<typeof resumableAttemptSchema>;

/**
 * The test the student walked away from, if there is one.
 *
 * Leaving a test half-finished is ordinary — a phone rings, a bus arrives. The attempt is already
 * durable (every answer is written the moment it is given), so resuming is a matter of finding it
 * and saying where they got to.
 *
 * A timed attempt whose clock has run out is NOT resumable: it is over, and opening it closes and
 * grades it. Reporting it as resumable would offer a test that cannot be continued.
 *
 * Served by `ExamAttempt(userId, startedAt DESC)`; the answered count is one grouped count over
 * `ExamAttemptQuestion(attemptId)`.
 */
export async function getResumableAttempt(
  db: PrismaClient,
  session: SessionUser,
  userId: string,
): Promise<ResumableAttempt | null> {
  authorizeOwner(session, userId);

  const attempt = await db.examAttempt.findFirst({
    where: { userId, status: "IN_PROGRESS" },
    select: {
      id: true,
      mode: true,
      startedAt: true,
      questionCountSnapshot: true,
      timeLimitSecSnapshot: true,
      countsTowardGuarantee: true,
      setupSnapshot: true,
    },
    orderBy: { startedAt: "desc" },
  });
  if (!attempt) return null;

  let timeRemainingSec: number | null = null;
  if (attempt.timeLimitSecSnapshot) {
    const elapsed = Math.floor(
      (Date.now() - attempt.startedAt.getTime()) / 1000,
    );
    timeRemainingSec = attempt.timeLimitSecSnapshot - elapsed;
    if (timeRemainingSec <= 0) return null; // the clock ran out while they were away
  }

  const answeredCount = await db.examAttemptQuestion.count({
    where: { attemptId: attempt.id, answeredOptionKey: { not: null } },
  });

  return resumableAttemptSchema.parse({
    id: attempt.id,
    mode: attempt.mode,
    kind: kindOf(attempt.mode, attempt.setupSnapshot),
    startedAt: attempt.startedAt,
    questionCount: attempt.questionCountSnapshot,
    answeredCount,
    timeRemainingSec,
    countsTowardGuarantee: attempt.countsTowardGuarantee,
  });
}

/** One attempt's headline figures — the header of its result page. */
export async function getAttemptSummary(
  db: PrismaClient,
  session: SessionUser,
  attemptId: string,
): Promise<AttemptSummary> {
  const attempt = await db.examAttempt.findUnique({
    where: { id: attemptId },
    select: {
      id: true,
      userId: true,
      mode: true,
      status: true,
      startedAt: true,
      submittedAt: true,
      questionCountSnapshot: true,
      correctCount: true,
      passMarkSnapshot: true,
      passed: true,
      resultHash: true,
      countsTowardGuarantee: true,
      taskSet: { select: { number: true } },
      setupSnapshot: true,
    },
  });
  // Same reasoning as the engine: a foreign attempt is "not found", never "forbidden".
  if (!attempt) throw new NotFoundError();
  authorizeOwner(session, attempt.userId);

  return attemptSummarySchema.parse({
    id: attempt.id,
    mode: attempt.mode,
    status: attempt.status,
    startedAt: attempt.startedAt,
    submittedAt: attempt.submittedAt,
    questionCount: attempt.questionCountSnapshot,
    correctCount: attempt.correctCount,
    passMark: attempt.passMarkSnapshot,
    passed: attempt.passed,
    attested: attempt.resultHash !== null,
    countsTowardGuarantee: attempt.countsTowardGuarantee,
    kind: kindOf(attempt.mode, attempt.setupSnapshot),
    taskSetNumber: attempt.taskSet?.number ?? null,
    durationSec: attempt.submittedAt
      ? Math.max(
          0,
          Math.round(
            (attempt.submittedAt.getTime() - attempt.startedAt.getTime()) /
              1000,
          ),
        )
      : null,
  });
}

/**
 * What counts as a *test* rather than practice.
 *
 * Two things qualify: a full blueprint exam (`mode = EXAM`), and a test the student configured on
 * the setup screen — which is the only thing that writes a `setupSnapshot`. A topic drill or the
 * quick practice run writes neither, so this cleanly separates "a test I sat" from "questions I
 * practised", without a column that could drift out of step with how an attempt was actually
 * started.
 */
const TEST_ONLY: Prisma.ExamAttemptWhereInput = {
  OR: [
    { mode: "EXAM" },
    // A task set IS the mock exam, so it counts towards category standing (spec-16).
    { mode: "TASK_SET" },
    { setupSnapshot: { not: Prisma.DbNull } },
  ],
};

/** How an attempt is named to the student. A configured test is a test, whatever its mode. */
function kindOf(mode: string, setupSnapshot: unknown): AttemptKind {
  // Checked before the setupSnapshot branch: a task set carries no setup, but it is a task set
  // first and a test second — the student knows it by its number, not by its shape (spec-16).
  if (mode === "TASK_SET") return "TASK_SET";
  if (mode === "EXAM" || setupSnapshot !== null) return "TEST";
  if (mode === "SIGN") return "SIGN";
  if (mode === "TOPIC") return "TOPIC";
  return "PRACTICE";
}

/**
 * How often this student passes a test they sit (spec-18 / spec-09's headline stat).
 *
 * Counts the same attempts the category panel counts — real tests only, practice excluded — and
 * returns null rather than 0 when there is nothing graded yet: "0%" reads as a verdict on a student
 * who has not been assessed.
 *
 * Served by ExamAttempt_userId_startedAt_idx.
 */
export async function passRate(
  db: PrismaClient,
  session: SessionUser,
  userId: string,
): Promise<{ percent: number | null; graded: number }> {
  authorizeOwner(session, userId);

  const rows = await db.examAttempt.groupBy({
    by: ["passed"],
    where: { userId, status: { not: "IN_PROGRESS" }, ...TEST_ONLY },
    _count: { _all: true },
  });

  const graded = rows
    .filter((row) => row.passed !== null)
    .reduce((sum, row) => sum + row._count._all, 0);
  if (graded === 0) return { percent: null, graded: 0 };

  const passed = rows.find((row) => row.passed === true)?._count._all ?? 0;
  return { percent: Math.round((passed / graded) * 100), graded };
}

export const categoryPerformanceSchema = z
  .object({
    topicSlug: z.string().min(1),
    topicName: z.string().min(1),
    /** Questions the student actually answered in a test. Blanks are not evidence either way. */
    answered: z.int().min(0),
    correct: z.int().min(0),
    /** null until there is anything to divide by. */
    percent: z.int().min(0).max(100).nullable(),
  })
  .strict();
export type CategoryPerformance = z.infer<typeof categoryPerformanceSchema>;

/**
 * How the student is doing in each category, from the tests they have sat.
 *
 * Counts only questions they actually **answered**: a blank left on a test is a zero for the
 * score, but it is not evidence that the category is weak, and this panel exists to point at
 * weak categories. Practice is excluded on purpose — the point is how they perform under test
 * conditions.
 *
 * Every root category is returned, including ones never tested, so the panel reads as a map of
 * what is covered rather than a list that silently omits the gaps. It is therefore useful from
 * the very first answered question.
 *
 * One grouped scan of `ExamAttemptQuestion` joined to the student's closed test attempts
 * (`ExamAttempt(userId, startedAt DESC)` finds them; `ExamAttemptQuestion_attemptId_position_key`
 * serves the join).
 */
export async function categoryPerformance(
  db: PrismaClient,
  session: SessionUser,
  userId: string,
  locale: AppLocale,
): Promise<CategoryPerformance[]> {
  authorizeOwner(session, userId);

  const [rows, topics] = await Promise.all([
    db.$queryRaw<
      Array<{ topicId: string; answered: bigint; correct: bigint }>
    >(Prisma.sql`
      SELECT q."topicId",
             count(*) FILTER (WHERE q."answeredOptionKey" IS NOT NULL) AS "answered",
             count(*) FILTER (WHERE q."isCorrect" IS TRUE)             AS "correct"
        FROM "ExamAttemptQuestion" q
        JOIN "ExamAttempt" a ON a."id" = q."attemptId"
       WHERE a."userId" = ${userId}
         AND a."status" <> 'IN_PROGRESS'
         AND (a."mode" IN ('EXAM', 'TASK_SET') OR a."setupSnapshot" IS NOT NULL)
       GROUP BY q."topicId"
    `),
    db.topic.findMany({
      where: { isActive: true, deletedAt: null },
      select: {
        id: true,
        slug: true,
        name: true,
        parentId: true,
        sortOrder: true,
      },
      orderBy: { sortOrder: "asc" },
    }),
  ]);

  // A question is tagged with the subtopic it tests; the panel speaks in root categories.
  const byId = new Map(topics.map((topic) => [topic.id, topic]));
  const rootOf = (topicId: string) => {
    let node = byId.get(topicId);
    while (node?.parentId && byId.has(node.parentId))
      node = byId.get(node.parentId);
    return node;
  };

  const totals = new Map<string, { answered: number; correct: number }>();
  for (const row of rows) {
    const root = rootOf(row.topicId);
    if (!root) continue;
    const current = totals.get(root.slug) ?? { answered: 0, correct: 0 };
    current.answered += Number(row.answered);
    current.correct += Number(row.correct);
    totals.set(root.slug, current);
  }

  return topics
    .filter((topic) => !topic.parentId)
    .map((topic) => {
      const total = totals.get(topic.slug) ?? { answered: 0, correct: 0 };
      return categoryPerformanceSchema.parse({
        topicSlug: topic.slug,
        topicName: pickBilingualText(topic.name, locale),
        answered: total.answered,
        correct: total.correct,
        percent:
          total.answered === 0
            ? null
            : Math.round((total.correct / total.answered) * 100),
      });
    });
}
