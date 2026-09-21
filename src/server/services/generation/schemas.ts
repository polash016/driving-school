import { z } from "zod";

/**
 * The shape a generation model must answer in (spec-05/06), in one place.
 *
 * These lived as byte-identical copies in `theory.ts` and `image.ts` until spec-22; a rail that
 * exists twice is a rail that will be tightened once.
 *
 * ## These are RUNAWAY-OUTPUT RAILS, not the editorial length budget
 *
 * Do not tighten them toward the brevity budget in `config/school.config.ts`. `aiJson` parses this
 * schema ONCE, after the whole provider-fallback loop, with no retry (`src/server/ai/client.ts`) —
 * so a single over-long option makes the parse throw `AiPipelineError` and destroys **every other
 * candidate in the batch**, plus the tokens that produced them.
 *
 * A Zod cap is a whole-batch instrument. Brevity is a per-candidate judgement, and it is enforced
 * per candidate by `brevityBlockers` in the generation loops, where a refusal costs one question
 * and teaches the next prompt through the rejection ledger.
 *
 * What these numbers are for: stopping a model that has started writing an essay.
 */

/** 300 chars is ~40 English words — far past any budget, and nowhere near a paragraph. */
export const OPTION_TEXT_MAX = 300;
export const STEM_MAX = 400;
export const EXPLANATION_MAX = 1000;

export const optionSchema = z.object({
  key: z.string().min(1).max(2),
  text: z.string().min(1).max(OPTION_TEXT_MAX),
});

export const localizedSchema = z.object({
  stem: z.string().min(10).max(STEM_MAX),
  options: z.array(optionSchema).min(3).max(4),
  explanation: z.string().min(10).max(EXPLANATION_MAX),
});

/** The model must answer in exactly this shape; anything else fails at the gateway. */
export const candidateSchema = z.object({
  en: localizedSchema,
  nb: localizedSchema,
  correctOptionKey: z.string().min(1).max(2),
  difficulty: z.number().int().min(1).max(5),
  citations: z
    .array(z.object({ sourceCode: z.string().min(1), ref: z.string().min(1) }))
    .min(1),
  /** What this question actually tests — makes the model commit to one point per question. */
  testsPoint: z.string().min(3).max(200).optional(),
});

/**
 * Models vary on whether they wrap a list: some answer `{questions: [...]}`, some a bare array.
 * Both are accepted and normalised — rejecting a good batch over its envelope would be silly.
 */
export const generationResponseSchema = z.union([
  z.object({ questions: z.array(candidateSchema).min(1).max(10) }),
  z
    .array(candidateSchema)
    .min(1)
    .max(10)
    .transform((questions) => ({ questions })),
]);

export type GenerationCandidate = z.infer<typeof candidateSchema>;
