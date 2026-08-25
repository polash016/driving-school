import type { AttemptMode, AttemptStatus, ItemType } from "@prisma/client";
import { pickLocale } from "@/lib/i18n-content";
import { mergeQuestion } from "@/server/services/i18n/resolve";
import type { UnitPayload } from "@/server/services/i18n/units";
import type { Locale } from "@/server/contracts/common";
import {
  explanationSchema,
  variantContentSchema,
} from "@/server/contracts/models";
import {
  attemptResultSchema,
  clientAttemptSchema,
  clientQuestionSchema,
  practiceAnswerResultSchema,
  type AttemptResult,
  type ClientAttempt,
  type ClientQuestion,
  type PracticeAnswerResult,
} from "@/server/contracts/quiz";

/**
 * THE anti-leak boundary (spec-07 security invariant).
 *
 * Every payload that leaves the server for a student goes through these
 * builders, which (a) construct only whitelisted fields and (b) runtime-parse
 * the result through the `.strict()` contracts — an accidentally added field
 * THROWS rather than ships. correctOptionKey/explanations appear only in the
 * post-grading builders.
 */

export interface ServedQuestionRow {
  position: number;
  optionOrder: string[];
  answeredOptionKey: string | null;
  flagged: boolean;
  topicSlug: string;
  type: ItemType;
  variantContent: unknown; // ItemVariant.content JSON (validated here)
  imageUrl: string | null;
  /**
   * Translated text for this variant, when the student's language has one that is servable
   * (spec-15). Resolved by the caller in one batched query — never fetched here, so this stays a
   * pure builder and cannot become an N+1.
   */
  translation?: unknown;
}

export function buildClientQuestion(
  row: ServedQuestionRow,
  locale: Locale,
): ClientQuestion {
  const content = variantContentSchema.parse(row.variantContent);
  const authored = pickLocale(content, locale);
  // Translation is an OVERLAY: keys and their order come from the authored side, always, and a
  // translation contributes text and nothing else. A translated question missing an option would
  // otherwise have thrown here — which, in a live exam, means a 500 mid-attempt.
  const localized = mergeQuestion(authored, row.translation as UnitPayload | undefined);
  const textByKey = new Map(localized.options.map((o) => [o.key, o.text]));

  const options = row.optionOrder.map((key) => {
    const text = textByKey.get(key);
    // Still a hard error, because now it can only mean the AUTHORED content is inconsistent with
    // the option order stored on the attempt — a real data bug, not a translation problem.
    if (!text) throw new Error(`optionOrder key ${key} missing in content`);
    return { key, text };
  });

  return clientQuestionSchema.parse({
    position: row.position,
    type: row.type,
    topicSlug: row.topicSlug,
    stem: localized.stem,
    options,
    imageUrl: row.imageUrl,
    flagged: row.flagged,
    answeredOptionKey: row.answeredOptionKey,
  });
}

export function buildClientAttempt(input: {
  id: string;
  mode: AttemptMode;
  status: AttemptStatus;
  locale: Locale;
  questionCount: number;
  timeRemainingSec: number | null;
  questions: ServedQuestionRow[];
}): ClientAttempt {
  const questions = input.questions
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((q) => buildClientQuestion(q, input.locale));

  const firstUnanswered = questions.find((q) => q.answeredOptionKey === null);

  return clientAttemptSchema.parse({
    id: input.id,
    mode: input.mode,
    status: input.status,
    locale: input.locale,
    questionCount: input.questionCount,
    currentPosition: firstUnanswered?.position ?? questions.length,
    timeRemainingSec: input.timeRemainingSec,
    questions,
  });
}

// ── Post-grading builders (reveal allowed) ──────────────────────────────────

export function buildPracticeResult(input: {
  position: number;
  correct: boolean;
  correctOptionKey: string;
  explanation: unknown; // ItemVariant.explanation JSON
  locale: Locale;
}): PracticeAnswerResult {
  const explanation = explanationSchema.parse(input.explanation);
  return practiceAnswerResultSchema.parse({
    position: input.position,
    correct: input.correct,
    correctOptionKey: input.correctOptionKey,
    explanation: {
      text: pickLocale(explanation, input.locale),
      citations: explanation.citations,
    },
  });
}

export interface GradedQuestionRow extends ServedQuestionRow {
  correctOptionKey: string;
  isCorrect: boolean;
  explanation: unknown;
}

export function buildAttemptResult(input: {
  attemptId: string;
  mode: AttemptMode;
  locale: Locale;
  correctCount: number;
  passMark: number | null;
  passed: boolean | null;
  topicNames: Record<string, { en: string; nb: string }>;
  topicBreakdown: Array<{ topicSlug: string; total: number; correct: number }>;
  questions: GradedQuestionRow[];
}): AttemptResult {
  const review = input.questions
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((q) => {
      const base = buildClientQuestion(q, input.locale);
      const explanation = explanationSchema.parse(q.explanation);
      return {
        position: base.position,
        stem: base.stem,
        options: base.options,
        answeredOptionKey: q.answeredOptionKey,
        correctOptionKey: q.correctOptionKey,
        correct: q.isCorrect,
        explanation: {
          text: pickLocale(explanation, input.locale),
          citations: explanation.citations,
        },
        imageUrl: q.imageUrl,
      };
    });

  return attemptResultSchema.parse({
    attemptId: input.attemptId,
    mode: input.mode,
    questionCount: input.questions.length,
    correctCount: input.correctCount,
    passMark: input.passMark,
    passed: input.passed,
    topicBreakdown: input.topicBreakdown.map((t) => ({
      topicSlug: t.topicSlug,
      topicName: pickLocale(
        input.topicNames[t.topicSlug] ?? { en: t.topicSlug, nb: t.topicSlug },
        input.locale,
      ),
      total: t.total,
      correct: t.correct,
    })),
    review,
  });
}
