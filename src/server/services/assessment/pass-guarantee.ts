import { z } from "zod";

/**
 * What makes a mock exam count towards the pass guarantee (spec-09/11 policy, built here because
 * the student must be told BEFORE they start, not after).
 *
 * The rule exists because a guarantee is only meaningful if the tests behind it resemble the real
 * one: every category in play, and the full question count. A student who practises fifteen
 * questions on road signs has not rehearsed the teoriprøve, and a guarantee built on that would be
 * a promise the school cannot keep.
 *
 * Timing is deliberately NOT part of the criteria: the developer asked for the timer to be the
 * student's choice, so an untimed full-length test still counts. Adding `timed` to
 * `QUALIFYING_CRITERIA` is the one-line change if that judgement ever shifts.
 */

/** The official class B test: 45 questions across every category. */
export const QUALIFYING_CRITERIA = {
  minQuestions: 45,
  allCategoriesRequired: true,
} as const;

export const guaranteeConfigSchema = z
  .object({
    questionCount: z.int().min(1).max(100),
    selectedTopicCount: z.int().min(0),
    totalTopicCount: z.int().min(1),
  })
  .strict();
export type GuaranteeConfig = z.infer<typeof guaranteeConfigSchema>;

/** Each reason is an i18n key, so the student reads why in their own language. */
export interface GuaranteeEvaluation {
  counts: boolean;
  reasons: string[];
}

export function evaluateGuarantee(rawConfig: unknown): GuaranteeEvaluation {
  const config = guaranteeConfigSchema.parse(rawConfig);
  const reasons: string[] = [];

  if (config.selectedTopicCount < config.totalTopicCount) {
    reasons.push("quiz.setup.guaranteeNeedsAllCategories");
  }
  if (config.questionCount < QUALIFYING_CRITERIA.minQuestions) {
    reasons.push("quiz.setup.guaranteeNeedsQuestionCount");
  }

  return { counts: reasons.length === 0, reasons };
}
