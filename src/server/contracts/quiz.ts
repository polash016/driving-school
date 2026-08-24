import { z } from "zod";
import { idSchema, localeSchema } from "./common";
import {
  attemptModeSchema,
  attemptStatusSchema,
  itemTypeSchema,
  legalCitationSchema,
} from "./models";

/**
 * Quiz engine API contracts (spec-07) — THE anti-leak boundary.
 *
 * SECURITY INVARIANT: every client-bound schema here is `.strict()` and
 * structurally excludes correctness (`isCorrect`, `correctOptionKey`) and
 * explanations until the server has graded. Serializers in
 * src/server/services/quiz/serializer.ts may ONLY return these shapes;
 * serializer.test.ts and an e2e network assertion guard this forever.
 */

// ── Inputs ──────────────────────────────────────────────────────────────────

export const startQuizInputSchema = z
  .object({
    mode: attemptModeSchema,
    licenseClassCode: z.string().min(1).optional(), // EXAM mode: required (validated in service)
    topicSlugs: z.array(z.string().min(1)).max(20).optional(), // TOPIC mode
    questionCount: z.int().min(1).max(100).optional(), // TOPIC/SIGN/PRACTICE; EXAM uses blueprint
    locale: localeSchema,
  })
  .strict();
export type StartQuizInput = z.infer<typeof startQuizInputSchema>;

export const answerInputSchema = z
  .object({
    attemptId: idSchema,
    position: z.int().min(1),
    optionKey: z.string().min(1).max(8),
    /** Idempotency: re-sending the same answer is a no-op; changing pre-submit is allowed. */
    clientAnsweredAt: z.iso.datetime().optional(),
  })
  .strict();
export type AnswerInput = z.infer<typeof answerInputSchema>;

export const flagInputSchema = z
  .object({
    attemptId: idSchema,
    position: z.int().min(1),
    flagged: z.boolean(),
  })
  .strict();

export const submitInputSchema = z.object({ attemptId: idSchema }).strict();

export const serveInputSchema = z
  .object({ attemptId: idSchema, locale: localeSchema })
  .strict();

// ── Client-bound DTOs (pre-submit: NO correctness anywhere) ─────────────────

/** One option as the client sees it — key + localized text, nothing else. */
export const clientOptionSchema = z
  .object({
    key: z.string().min(1).max(8),
    text: z.string().min(1),
  })
  .strict();

/** One question as served. Localized server-side; option order = per-attempt shuffle. */
export const clientQuestionSchema = z
  .object({
    position: z.int().min(1),
    type: itemTypeSchema,
    topicSlug: z.string().min(1),
    stem: z.string().min(1),
    options: z.array(clientOptionSchema).min(2).max(6),
    imageUrl: z.string().nullable(), // signed short-TTL URL (spec-12)
    flagged: z.boolean(),
    answeredOptionKey: z.string().nullable(), // the student's own answer (resume support)
  })
  .strict();
export type ClientQuestion = z.infer<typeof clientQuestionSchema>;

/** Attempt as served to the client — timer is server-authoritative. */
export const clientAttemptSchema = z
  .object({
    id: idSchema,
    mode: attemptModeSchema,
    status: attemptStatusSchema,
    locale: localeSchema,
    questionCount: z.int().min(1),
    currentPosition: z.int().min(1),
    timeRemainingSec: z.int().min(0).nullable(), // null = untimed
    questions: z.array(clientQuestionSchema),
  })
  .strict();
export type ClientAttempt = z.infer<typeof clientAttemptSchema>;

// ── Post-grading DTOs (server has graded — reveal allowed) ──────────────────

export const explanationClientSchema = z
  .object({
    text: z.string().min(1), // localized
    citations: z.array(legalCitationSchema),
  })
  .strict();

/** PRACTICE mode: per-question server grading response (allowed AFTER the answer). */
export const practiceAnswerResultSchema = z
  .object({
    position: z.int().min(1),
    correct: z.boolean(),
    correctOptionKey: z.string().min(1),
    explanation: explanationClientSchema,
  })
  .strict();
export type PracticeAnswerResult = z.infer<typeof practiceAnswerResultSchema>;

export const topicResultSchema = z
  .object({
    topicSlug: z.string().min(1),
    topicName: z.string().min(1), // localized
    total: z.int().min(0),
    correct: z.int().min(0),
  })
  .strict();

export const reviewQuestionSchema = z
  .object({
    position: z.int().min(1),
    stem: z.string().min(1),
    options: z.array(clientOptionSchema).min(2).max(6),
    answeredOptionKey: z.string().nullable(),
    correctOptionKey: z.string().min(1),
    correct: z.boolean(),
    explanation: explanationClientSchema,
    imageUrl: z.string().nullable(),
  })
  .strict();

/** Submit/result payload — the only place full correctness ships, post-grading. */
export const attemptResultSchema = z
  .object({
    attemptId: idSchema,
    mode: attemptModeSchema,
    questionCount: z.int().min(1),
    correctCount: z.int().min(0),
    passMark: z.int().min(1).nullable(),
    passed: z.boolean().nullable(), // null for untimed practice without pass rules
    topicBreakdown: z.array(topicResultSchema),
    review: z.array(reviewQuestionSchema),
  })
  .strict();
export type AttemptResult = z.infer<typeof attemptResultSchema>;
