import { randomUUID } from "node:crypto";
import type {
  AttemptStatus,
  ItemType,
  Prisma,
  PrismaClient,
} from "@prisma/client";
import { z } from "zod";
import {
  ConflictError,
  ExamStateError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  ValidationError,
} from "@/lib/errors";
import { logger } from "@/lib/logger";
import type { Locale } from "@/server/contracts/common";
import {
  answerAckSchema,
  answerInputSchema,
  flagInputSchema,
  revealInputSchema,
  serveInputSchema,
  startQuizInputSchema,
  submitInputSchema,
  type AnswerAck,
  type AttemptResult,
  type ClientAttempt,
  type PracticeAnswerResult,
} from "@/server/contracts/quiz";
import { attestAttempt } from "@/server/services/assessment/attestation";
import { loadOverlay } from "@/server/services/i18n/resolve";
import { assembleQuiz } from "./assembly";
import { gradeAttempt, type GradableQuestion } from "./grading";
import type { GradedHook, SeenStore, VariantSource } from "./ports";
import {
  buildAttemptResult,
  buildClientAttempt,
  buildPracticeResult,
  type GradedQuestionRow,
  type ServedQuestionRow,
} from "./serializer";
import {
  computeExpiresAt,
  isExpired,
  remainingSeconds,
  systemClock,
  type Clock,
} from "./timer";

/**
 * Attempt lifecycle orchestration (spec-07): create → serve → answer autosave →
 * resume → submit → grade. Framework-agnostic; routes call these methods after
 * authorize(). All client-bound payloads go through the serializer (anti-leak).
 *
 * NO AI calls anywhere in this path — assembly reads existing variants only.
 */

const DEFAULT_PRACTICE_COUNT = 15;
const distributionSchema = z.record(z.string(), z.int().positive());
const optionOrderSchema = z.array(z.string().min(1));

/** Server-decided facts about an attempt that the client must not be able to assert. */
export interface StartOptions {
  /** Whether this attempt qualifies towards the pass guarantee (computed server-side). */
  countsTowardGuarantee?: boolean;
  /** What the student chose, kept so a disputed result can be explained. */
  setupSnapshot?: Record<string, unknown>;
}

export interface AttemptServiceDeps {
  db: PrismaClient;
  variantSource: VariantSource;
  seenStore: SeenStore;
  clock?: Clock;
  onGraded?: GradedHook;
}

export function createAttemptService(deps: AttemptServiceDeps) {
  const { db, variantSource, seenStore } = deps;
  const clock = deps.clock ?? systemClock;

  /** topicId → root topic slug (student-facing breakdowns roll up to main topics). */
  async function rootSlugMap(): Promise<Map<string, string>> {
    const topics = await db.topic.findMany({
      where: { deletedAt: null },
      select: { id: true, slug: true, parentId: true },
    });
    const byId = new Map(topics.map((t) => [t.id, t]));
    const map = new Map<string, string>();
    for (const t of topics) {
      let node = t;
      while (node.parentId && byId.has(node.parentId)) {
        node = byId.get(node.parentId)!;
      }
      map.set(t.id, node.slug);
    }
    return map;
  }

  async function startQuiz(
    userId: string,
    rawInput: unknown,
    options: StartOptions = {},
  ): Promise<ClientAttempt> {
    const input = startQuizInputSchema.parse(rawInput);
    const now = clock.now();

    let distribution: Record<string, number>;
    let imageRatio = 0;
    let timeLimitSec: number | null = null;
    let passMark: number | null = null;
    let licenseClassId: string | null = null;
    let blueprintId: string | null = null;
    let typeFilter: ItemType | undefined;

    if (input.mode === "EXAM") {
      if (!input.licenseClassCode) {
        throw new ValidationError({
          reason: "licenseClassCode required for EXAM",
        });
      }
      const licenseClass = await db.licenseClass.findFirst({
        where: { code: input.licenseClassCode, isEnabled: true },
        select: {
          id: true,
          questionCount: true,
          timeLimitMin: true,
          passMark: true,
        },
      });
      if (!licenseClass)
        throw new NotFoundError({ licenseClassCode: input.licenseClassCode });
      const blueprint = await db.examBlueprint.findFirst({
        where: {
          licenseClassId: licenseClass.id,
          isDefault: true,
          isActive: true,
        },
        select: { id: true, topicDistribution: true, imageRatio: true },
      });
      if (!blueprint)
        throw new InternalError({ reason: "no default blueprint" });

      distribution = distributionSchema.parse(blueprint.topicDistribution);
      const sum = Object.values(distribution).reduce((a, b) => a + b, 0);
      if (sum !== licenseClass.questionCount) {
        throw new InternalError({ reason: "blueprint/class mismatch", sum });
      }
      imageRatio = blueprint.imageRatio;
      timeLimitSec = licenseClass.timeLimitMin * 60;
      passMark = licenseClass.passMark;
      licenseClassId = licenseClass.id;
      blueprintId = blueprint.id;
    } else {
      // A self-configured rehearsal can still run against the official clock, and a full-length
      // one is graded like the real test rather than shown as untimed practice.
      const requestedCount = input.questionCount ?? DEFAULT_PRACTICE_COUNT;
      if (input.timed || options.countsTowardGuarantee) {
        const licenseClass = await db.licenseClass.findFirst({
          where: { isEnabled: true },
          orderBy: { sortOrder: "asc" },
          select: {
            timeLimitMin: true,
            questionCount: true,
            passMark: true,
            id: true,
          },
        });
        if (licenseClass) {
          if (input.timed) timeLimitSec = licenseClass.timeLimitMin * 60;
          if (options.countsTowardGuarantee) {
            licenseClassId = licenseClass.id;
            // The official ratio (38 of 45), scaled to whatever length the student chose.
            passMark = Math.ceil(
              (requestedCount * licenseClass.passMark) /
                licenseClass.questionCount,
            );
          }
        }
      }
      if (input.mode === "TOPIC" && (input.topicSlugs?.length ?? 0) === 0) {
        throw new ValidationError({
          reason: "topicSlugs required for TOPIC mode",
        });
      }
      let slugs = input.topicSlugs ?? [];
      if (slugs.length === 0) {
        const roots = await db.topic.findMany({
          where: { parentId: null, isActive: true, deletedAt: null },
          select: { slug: true },
        });
        slugs = roots.map((r) => r.slug);
      }
      // An explicit itemType wins; SIGN mode implies its own type so the Sign Test tile does not
      // have to send both. EXAM deliberately never filters — the official paper mixes types.
      typeFilter =
        input.itemType ?? (input.mode === "SIGN" ? "SIGN" : undefined);
      const count = input.questionCount ?? DEFAULT_PRACTICE_COUNT;
      distribution = evenDistribution(slugs, count);
    }

    const candidates = await variantSource.candidatesByTopic({
      topicSlugs: Object.keys(distribution),
      type: typeFilter,
      licenseClassId,
    });
    if (input.mode !== "EXAM") {
      distribution = rebalanceToAvailability(distribution, candidates);
    }

    const seenHashes = await seenStore.getSeenHashes(userId);
    const seed = randomUUID(); // entropy per attempt; reproducibility = seed is stored
    const assembled = assembleQuiz({
      seed,
      distribution,
      imageRatio,
      candidatesByTopic: candidates,
      seenHashes,
    });

    if (assembled.warnings.length > 0) {
      logger.warn(
        { userId, mode: input.mode, warnings: assembled.warnings },
        "assembly warnings",
      );
    }
    if (assembled.questions.length === 0) {
      throw new ExamStateError({ reason: "no questions available" });
    }
    if (input.mode === "EXAM" && assembled.shortfall > 0) {
      throw new InternalError({
        reason: "pool cannot fill exam blueprint",
        shortfall: assembled.shortfall,
      });
    }

    const attempt = await db.$transaction(async (tx) => {
      const created = await tx.examAttempt.create({
        data: {
          userId,
          mode: input.mode,
          status: "IN_PROGRESS",
          // The language this paper is sat in, frozen at the start (spec-15). A disputed mark has
          // to be answerable with the exact wording the student saw, and with more than two
          // languages "re-render it in whatever locale the reader has" stops being good enough.
          locale: input.locale,
          licenseClassId,
          blueprintId,
          seed,
          questionCountSnapshot: assembled.questions.length,
          timeLimitSecSnapshot: timeLimitSec,
          passMarkSnapshot: passMark,
          startedAt: now,
          expiresAt: computeExpiresAt(now, timeLimitSec),
          countsTowardGuarantee: options.countsTowardGuarantee ?? false,
          ...(options.setupSnapshot
            ? { setupSnapshot: options.setupSnapshot as Prisma.InputJsonValue }
            : {}),
        },
        select: { id: true },
      });
      await tx.examAttemptQuestion.createMany({
        data: assembled.questions.map((q) => ({
          attemptId: created.id,
          variantId: q.variantId,
          position: q.position,
          topicId: q.topicId,
          optionOrder: q.optionOrder as Prisma.InputJsonValue & string[],
        })),
      });
      return created;
    });

    await seenStore.recordServed(
      userId,
      assembled.questions.map((q) => q.contentHash),
      now,
    );

    return serveAttempt(userId, {
      attemptId: attempt.id,
      locale: input.locale,
    });
  }

  async function loadOwnedAttempt(userId: string, attemptId: string) {
    const attempt = await db.examAttempt.findUnique({
      where: { id: attemptId },
      select: {
        id: true,
        userId: true,
        mode: true,
        status: true,
        startedAt: true,
        expiresAt: true,
        submittedAt: true,
        timeLimitSecSnapshot: true,
        passMarkSnapshot: true,
        questionCountSnapshot: true,
        correctCount: true,
        passed: true,
        topicBreakdown: true,
      },
    });
    // NotFound (not Forbidden) for foreign attempts — don't leak existence (IDOR, spec-12)
    if (!attempt || attempt.userId !== userId) throw new NotFoundError();
    return attempt;
  }

  type LoadedAttempt = Awaited<ReturnType<typeof loadOwnedAttempt>>;

  async function serveAttempt(
    userId: string,
    rawInput: unknown,
  ): Promise<ClientAttempt> {
    const input = serveInputSchema.parse(rawInput);
    let attempt = await loadOwnedAttempt(userId, input.attemptId);

    if (
      attempt.status === "IN_PROGRESS" &&
      isExpired(clock, attempt.expiresAt)
    ) {
      await gradeAndClose(attempt, "EXPIRED");
      attempt = await loadOwnedAttempt(userId, input.attemptId);
    }

    const rows = await servedRows(attempt.id, input.locale);
    return buildClientAttempt({
      id: attempt.id,
      mode: attempt.mode,
      status: attempt.status,
      locale: input.locale,
      questionCount: attempt.questionCountSnapshot,
      timeRemainingSec:
        attempt.status === "IN_PROGRESS"
          ? remainingSeconds(
              clock,
              attempt.startedAt,
              attempt.timeLimitSecSnapshot,
            )
          : 0,
      questions: rows,
    });
  }

  async function servedRows(
    attemptId: string,
    locale: string,
  ): Promise<ServedQuestionRow[]> {
    const roots = await rootSlugMap();
    const questions = await db.examAttemptQuestion.findMany({
      where: { attemptId },
      select: {
        position: true,
        variantId: true,
        optionOrder: true,
        answeredOptionKey: true,
        flagged: true,
        topicId: true,
        variant: {
          select: {
            content: true,
            masterItem: {
              select: { type: true, sourceImage: { select: { url: true } } },
            },
          },
        },
      },
      orderBy: { position: "asc" },
    });
    // One batched read for the whole paper — the overlay is never fetched per question.
    const overlay = await loadOverlay(
      db,
      locale,
      "ITEM_VARIANT",
      questions.map((q) => q.variantId),
    );

    return questions.map((q) => ({
      position: q.position,
      optionOrder: optionOrderSchema.parse(q.optionOrder),
      answeredOptionKey: q.answeredOptionKey,
      flagged: q.flagged,
      topicSlug: roots.get(q.topicId) ?? "unknown",
      type: q.variant.masterItem.type,
      variantContent: q.variant.content,
      imageUrl: q.variant.masterItem.sourceImage?.url ?? null,
      translation: overlay.get(q.variantId),
    }));
  }

  async function answer(
    userId: string,
    rawInput: unknown,
  ): Promise<PracticeAnswerResult | AnswerAck> {
    const input = answerInputSchema.parse(rawInput);
    const attempt = await loadOwnedAttempt(userId, input.attemptId);

    if (attempt.status !== "IN_PROGRESS") {
      throw new ExamStateError({ state: attempt.status });
    }
    if (isExpired(clock, attempt.expiresAt)) {
      await gradeAndClose(attempt, "EXPIRED");
      throw new ExamStateError({ reason: "expired" });
    }

    const question = await db.examAttemptQuestion.findUnique({
      where: {
        attemptId_position: { attemptId: attempt.id, position: input.position },
      },
      select: {
        id: true,
        optionOrder: true,
        answeredOptionKey: true,
        answeredAt: true,
        variant: { select: { correctOptionKey: true, explanation: true } },
      },
    });
    if (!question) throw new NotFoundError();

    const optionOrder = optionOrderSchema.parse(question.optionOrder);
    if (!optionOrder.includes(input.optionKey)) {
      throw new ValidationError({ reason: "option not part of this question" });
    }

    const reveal = attempt.mode !== "EXAM"; // practice-like modes get instant server-graded feedback
    const correct = input.optionKey === question.variant.correctOptionKey;

    // An answer is written once (developer decision 2026-08-25). Re-sending the SAME answer is
    // still fine — a retry, a double tap or a reconnect must not become an error — but a
    // different one is refused. In practice mode the answer is revealed the moment it is given,
    // so a changeable answer would make every practice score a formality. The database enforces
    // this too (`tp_attempt_question_immutable`); this check is what turns it into a message.
    if (
      question.answeredOptionKey !== null &&
      question.answeredOptionKey !== input.optionKey
    ) {
      throw new ConflictError(
        { attemptId: attempt.id, position: input.position },
        "quiz.errors.answerLocked",
      );
    }

    if (question.answeredOptionKey === null) {
      await db.examAttemptQuestion.update({
        where: { id: question.id },
        data: {
          answeredOptionKey: input.optionKey,
          answeredAt: clock.now(),
          ...(reveal ? { isCorrect: correct } : {}),
        },
      });
    }

    if (!reveal) {
      return answerAckSchema.parse({ position: input.position, saved: true });
    }
    return buildPracticeResult({
      position: input.position,
      correct,
      correctOptionKey: question.variant.correctOptionKey,
      explanation: question.variant.explanation,
      locale: input.locale,
    });
  }

  /**
   * Re-read the feedback for a question the student has ALREADY answered (practice-like modes).
   *
   * Exists so that navigating back to an answered question — or refreshing the page — shows the
   * explanation again instead of a blank card. It reveals nothing new: the answer is recorded and
   * can no longer change, and this is the same payload the student was shown when they answered.
   *
   * It is a read, not a re-answer, and it refuses on both counts that matter: never in EXAM mode,
   * never for a question that has not been answered yet.
   */
  async function revealAnswered(
    userId: string,
    rawInput: unknown,
  ): Promise<PracticeAnswerResult> {
    const input = revealInputSchema.parse(rawInput);
    const attempt = await loadOwnedAttempt(userId, input.attemptId);

    if (attempt.mode === "EXAM") {
      throw new ForbiddenError({ attemptId: attempt.id }, "errors.forbidden");
    }

    const question = await db.examAttemptQuestion.findUnique({
      where: {
        attemptId_position: { attemptId: attempt.id, position: input.position },
      },
      select: {
        answeredOptionKey: true,
        variant: { select: { correctOptionKey: true, explanation: true } },
      },
    });
    if (!question) throw new NotFoundError();
    if (question.answeredOptionKey === null) {
      throw new ConflictError(
        { attemptId: attempt.id, position: input.position },
        "quiz.errors.notAnsweredYet",
      );
    }

    return buildPracticeResult({
      position: input.position,
      correct: question.answeredOptionKey === question.variant.correctOptionKey,
      correctOptionKey: question.variant.correctOptionKey,
      explanation: question.variant.explanation,
      locale: input.locale,
    });
  }

  async function setFlag(userId: string, rawInput: unknown): Promise<void> {
    const input = flagInputSchema.parse(rawInput);
    const attempt = await loadOwnedAttempt(userId, input.attemptId);
    if (attempt.status !== "IN_PROGRESS") {
      throw new ExamStateError({ state: attempt.status });
    }
    await db.examAttemptQuestion.update({
      where: {
        attemptId_position: { attemptId: attempt.id, position: input.position },
      },
      data: { flagged: input.flagged },
    });
  }

  /** Grade + persist + close. Used by submit and by expiry auto-submit. */
  async function gradeAndClose(
    attempt: LoadedAttempt,
    status: Extract<AttemptStatus, "SUBMITTED" | "EXPIRED">,
  ): Promise<void> {
    const roots = await rootSlugMap();
    const questions = await db.examAttemptQuestion.findMany({
      where: { attemptId: attempt.id },
      select: {
        id: true,
        position: true,
        topicId: true,
        answeredOptionKey: true,
        variant: { select: { correctOptionKey: true } },
      },
    });

    const gradable: GradableQuestion[] = questions.map((q) => ({
      position: q.position,
      topicSlug: roots.get(q.topicId) ?? "unknown",
      answeredOptionKey: q.answeredOptionKey,
      correctOptionKey: q.variant.correctOptionKey,
    }));
    const grade = gradeAttempt(gradable, attempt.passMarkSnapshot);
    const correctByPosition = new Map(
      grade.perQuestion.map((q) => [q.position, q.correct]),
    );

    await db.$transaction(async (tx) => {
      for (const q of questions) {
        await tx.examAttemptQuestion.update({
          where: { id: q.id },
          data: { isCorrect: correctByPosition.get(q.position) ?? false },
        });
      }
      await tx.examAttempt.update({
        where: { id: attempt.id },
        data: {
          status,
          submittedAt: clock.now(),
          correctCount: grade.correctCount,
          passed: grade.passed,
          topicBreakdown:
            grade.topicBreakdown as unknown as Prisma.InputJsonValue,
        },
      });
      // Attest inside the same transaction (spec-04b): after this the DB refuses to change the
      // result at all, so the digest has to be written while the record is still being closed.
      await attestAttempt(tx, attempt.id);
    });

    if (deps.onGraded) await deps.onGraded(attempt.userId);
  }

  async function submit(
    userId: string,
    rawInput: unknown,
  ): Promise<AttemptResult> {
    const input = submitInputSchema.parse(rawInput);
    let attempt = await loadOwnedAttempt(userId, input.attemptId);

    if (attempt.status === "IN_PROGRESS") {
      const status = isExpired(clock, attempt.expiresAt)
        ? "EXPIRED"
        : "SUBMITTED";
      await gradeAndClose(attempt, status);
      attempt = await loadOwnedAttempt(userId, input.attemptId);
    }
    // From here the attempt is closed — result building is idempotent from stored state.
    return buildStoredResult(attempt, input.locale);
  }

  async function buildStoredResult(
    attempt: LoadedAttempt,
    locale: Locale,
  ): Promise<AttemptResult> {
    const roots = await rootSlugMap();
    const questions = await db.examAttemptQuestion.findMany({
      where: { attemptId: attempt.id },
      select: {
        position: true,
        variantId: true,
        optionOrder: true,
        answeredOptionKey: true,
        flagged: true,
        isCorrect: true,
        topicId: true,
        variant: {
          select: {
            content: true,
            correctOptionKey: true,
            explanation: true,
            masterItem: {
              select: { type: true, sourceImage: { select: { url: true } } },
            },
          },
        },
      },
      orderBy: { position: "asc" },
    });

    // A past paper reads in the language it is being viewed in, from the same overlay the live
    // exam used. The attempt also records the language it was SAT in, so a dispute can always be
    // answered with the wording the student actually saw.
    const overlay = await loadOverlay(
      db,
      locale,
      "ITEM_VARIANT",
      questions.map((q) => q.variantId),
    );

    const gradedRows: GradedQuestionRow[] = questions.map((q) => ({
      position: q.position,
      optionOrder: optionOrderSchema.parse(q.optionOrder),
      answeredOptionKey: q.answeredOptionKey,
      flagged: q.flagged,
      topicSlug: roots.get(q.topicId) ?? "unknown",
      type: q.variant.masterItem.type,
      variantContent: q.variant.content,
      imageUrl: q.variant.masterItem.sourceImage?.url ?? null,
      correctOptionKey: q.variant.correctOptionKey,
      isCorrect: q.isCorrect ?? false,
      explanation: q.variant.explanation,
      translation: overlay.get(q.variantId),
    }));

    const breakdown = z
      .array(
        z.object({ topicSlug: z.string(), total: z.int(), correct: z.int() }),
      )
      .parse(attempt.topicBreakdown ?? []);

    const rootSlugs = [...new Set(breakdown.map((b) => b.topicSlug))];
    const topics = await db.topic.findMany({
      where: { slug: { in: rootSlugs } },
      select: { slug: true, name: true },
    });
    const topicNames = Object.fromEntries(
      topics.map((t) => [
        t.slug,
        z.object({ en: z.string(), nb: z.string() }).parse(t.name),
      ]),
    );

    return buildAttemptResult({
      attemptId: attempt.id,
      mode: attempt.mode,
      locale,
      correctCount: attempt.correctCount ?? 0,
      passMark: attempt.passMarkSnapshot,
      passed: attempt.passed,
      topicNames,
      topicBreakdown: breakdown,
      questions: gradedRows,
    });
  }

  /**
   * The stored result of a CLOSED attempt — what the student sees in their history (spec-04b).
   * Refuses an attempt that is still running: correctness and explanations must not leak into a
   * live exam, which is the same invariant the serializer enforces on the way out.
   */
  async function getResult(
    userId: string,
    rawInput: unknown,
  ): Promise<AttemptResult> {
    const input = submitInputSchema.parse(rawInput);
    const attempt = await loadOwnedAttempt(userId, input.attemptId);
    if (attempt.status === "IN_PROGRESS") {
      throw new ExamStateError({
        attemptId: attempt.id,
        reason: "still in progress",
      });
    }
    return buildStoredResult(attempt, input.locale);
  }

  return {
    startQuiz,
    serveAttempt,
    answer,
    revealAnswered,
    setFlag,
    submit,
    getResult,
  };
}

export type AttemptService = ReturnType<typeof createAttemptService>;

// ── distribution helpers ─────────────────────────────────────────────────────

/** Spread `count` evenly over slugs (largest remainder, deterministic order). */
export function evenDistribution(
  slugs: string[],
  count: number,
): Record<string, number> {
  const sorted = [...new Set(slugs)].sort();
  const base = Math.floor(count / sorted.length);
  let leftover = count - base * sorted.length;
  const out: Record<string, number> = {};
  for (const slug of sorted) {
    out[slug] = base + (leftover > 0 ? 1 : 0);
    if (leftover > 0) leftover--;
  }
  return out;
}

/**
 * Non-exam modes: shift counts away from topics with too few candidates so the
 * quiz still reaches its size when some topics are thin/empty.
 */
export function rebalanceToAvailability(
  distribution: Record<string, number>,
  candidates: Record<
    string,
    { masterItemId: string; conceptGroupId?: string | null }[]
  >,
): Record<string, number> {
  const out: Record<string, number> = {};
  let deficit = 0;
  const capacity = new Map<string, number>();
  for (const slug of Object.keys(distribution).sort()) {
    // capacity = distinct CONCEPTS, not rows: a master appears at most once per attempt, and
    // re-phrasings of one rule (same conceptGroupId) are one question as far as a paper is
    // concerned. Counting rows here promises a topic more questions than assembly can serve.
    const distinctMasters = new Set(
      (candidates[slug] ?? []).map((c) => c.conceptGroupId ?? c.masterItemId),
    ).size;
    capacity.set(slug, distinctMasters);
    const take = Math.min(distribution[slug], distinctMasters);
    out[slug] = take;
    deficit += distribution[slug] - take;
  }
  if (deficit > 0) {
    for (const slug of Object.keys(out).sort()) {
      if (deficit === 0) break;
      const spare = (capacity.get(slug) ?? 0) - out[slug];
      const add = Math.min(spare, deficit);
      out[slug] += add;
      deficit -= add;
    }
  }
  for (const slug of Object.keys(out)) {
    if (out[slug] === 0) delete out[slug];
  }
  return out;
}
