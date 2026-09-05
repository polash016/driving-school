import { z } from "zod";
import { aiJson, aiEmbed } from "@/server/ai/client";
import { blindAnswerCheckPrompt } from "@/server/ai/prompts/validation";
import { cosine } from "@/server/services/question-bank/similarity";
import { createRng, shuffle } from "@/server/services/quiz/rng";
import { logger } from "@/lib/logger";

/**
 * Validators that need a model or an embedding, sitting on top of the deterministic quality gate
 * in `question-bank/validation.ts` (which every question, human or AI, already passes).
 */

/**
 * Tolerant on shape, and every tolerance fails towards REFUSING the question.
 *
 * A verifier that declares a question unanswerable stops bothering to return a `choice`, and some
 * answer with the number as a string. Neither should crash the run — but neither may be read as
 * agreement either: a missing or unusable choice is treated exactly like a dispute, because the
 * one thing it certainly is not is independent confirmation of the key.
 */
const verdictSchema = z.object({
  choice: z.coerce.number().int().min(1).optional(),
  quote: z.string().default(""),
  unanswerable: z.boolean().default(false),
  /** Default true: only an explicit "no" refuses, so a model that omits it cannot fail the item. */
  sceneSupported: z.boolean().default(true),
});

export interface BlindAnswerResult {
  /** The key was independently reproduced. Anything else is a refusal. */
  verified: boolean;
  reason: string;
  /**
   * The question described a scene that is not the one in the picture. Separated from `verified`
   * because it is a different fault with a different rejection reason — the rule can be stated
   * perfectly while the picture shows something else entirely.
   */
  sceneMismatch: boolean;
  /** Which model sat the question — stored so an accuracy regression can be traced to a model. */
  verifierModel: string;
}

export interface AnswerCheckInput {
  stem: string;
  options: { key: string; text: string }[];
  correctOptionKey: string;
  situationSummary: string;
  signNames: string[];
  legalText: string;
  /** Stable per item, so a re-run of the same question shuffles the same way and is reproducible. */
  seed: string;
}

/**
 * Sit the question blind and compare with the authored key.
 *
 * The verifier never receives the key, the explanation, or the options in their authored order.
 * Everything it could pattern-match on instead of reasoning is removed, which is what separates
 * this from asking a model "is this correct?" — a question it will almost always answer yes to.
 */
export async function verifyAnswerBlind(
  input: AnswerCheckInput,
): Promise<BlindAnswerResult> {
  // Re-shuffled: authored options often run correct-answer-first, and a verifier that learns that
  // agrees with the key for the wrong reason.
  const presented = shuffle(createRng(`${input.seed}:blind`), input.options);

  const result = await aiJson({
    task: "validation",
    prompt: blindAnswerCheckPrompt,
    vars: {
      situation: input.situationSummary,
      signList: input.signNames.join(", "),
      legalText: input.legalText,
      stem: input.stem,
      options: presented.map((option) => option.text),
    },
    schema: verdictSchema,
    temperature: 0,
  });

  const { choice, quote, unanswerable, sceneSupported } = result.data;
  const verifierModel = result.modelVersion;

  // Checked first: a question about a sign that is not in the picture is wrong even when the rule
  // it states is right, and the regulation text will happily support it. Observed on a real batch —
  // a question about where to stop, for a picture containing no stop sign.
  // `=== false` rather than falsy: only an EXPLICIT no refuses. A verifier that omits the field
  // has not judged the scene, and "did not say" must never read as "said no".
  if (sceneSupported === false) {
    return {
      verified: false,
      sceneMismatch: true,
      reason: "the question describes something that is not in this picture",
      verifierModel,
    };
  }

  if (unanswerable || choice === undefined) {
    return {
      verified: false,
      sceneMismatch: false,
      reason: "the cited rule does not settle the question",
      verifierModel,
    };
  }
  const chosen = presented[choice - 1];
  if (!chosen) {
    return {
      verified: false,
      sceneMismatch: false,
      reason: `verifier chose option ${choice}, which does not exist`,
      verifierModel,
    };
  }
  if (chosen.key !== input.correctOptionKey) {
    const authored = input.options.find(
      (option) => option.key === input.correctOptionKey,
    );
    return {
      verified: false,
      sceneMismatch: false,
      reason: `answer key disputed — verifier chose "${chosen.text.slice(0, 60)}", key says "${(authored?.text ?? "?").slice(0, 60)}"`,
      verifierModel,
    };
  }
  // A quote that is not actually in the supplied text means the verifier reasoned from memory
  // rather than from the regulation, so its agreement is not evidence of anything.
  if (
    quote &&
    !normalise(input.legalText).includes(normalise(quote).slice(0, 40))
  ) {
    return {
      verified: false,
      sceneMismatch: false,
      reason: "verifier's supporting quote is not in the cited text",
      verifierModel,
    };
  }
  return {
    verified: true,
    sceneMismatch: false,
    reason: "answer key independently reproduced",
    verifierModel,
  };
}

const normalise = (text: string) =>
  text.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Two options that mean the same thing make a question ungradeable — a student who picks the
 * "wrong" one of a matched pair is marked wrong for a distinction that does not exist.
 *
 * Compared by embedding rather than by string, because the failure is paraphrase, not repetition:
 * "You must stop completely" and "You have to come to a full halt" share almost no characters.
 */
export const DISTRACTOR_SIMILARITY_LIMIT = 0.93;

export async function checkDistractorDistinctness(
  options: { key: string; text: string }[],
  limit = DISTRACTOR_SIMILARITY_LIMIT,
): Promise<{
  ok: boolean;
  collidingKeys: [string, string] | null;
  similarity: number;
}> {
  if (options.length < 2)
    return { ok: true, collidingKeys: null, similarity: 0 };

  const vectors = await aiEmbed(options.map((option) => option.text));
  let worst = 0;
  let colliding: [string, string] | null = null;

  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      const similarity = cosine(vectors[i], vectors[j]);
      if (similarity > worst) {
        worst = similarity;
        if (similarity >= limit) colliding = [options[i].key, options[j].key];
      }
    }
  }

  if (colliding) {
    logger.info({ colliding, similarity: worst }, "distractor collision");
  }
  return { ok: !colliding, collidingKeys: colliding, similarity: worst };
}

/**
 * An image question must not name the sign it is showing.
 *
 * "One of which is the Give Way sign — what does it specify?" is answerable without looking at the
 * picture, and usually hands over the answer outright. The prompt forbids it and the model does it
 * anyway (observed on the first real batch), which is exactly the sort of instruction that needs a
 * check behind it rather than trust.
 *
 * Matched narrowly, as the sign's NAME used to refer to the sign — "the give way sign", "sign 202"
 * — so that a question legitimately asking whether you must *give way* still passes.
 */
export function checkStemHidesTheSign(
  stem: string,
  signs: { code: string; name: string }[],
): { ok: boolean; revealed: string | null } {
  const haystack = stem.toLowerCase();
  for (const sign of signs) {
    const name = sign.name.toLowerCase().trim();
    if (!name) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const namedAsSign = new RegExp(
      `(\\b${escaped}\\s+sign\\b|\\bsign\\s+${escaped}\\b)`,
      "i",
    );
    const byCode = new RegExp(`\\bsign\\s+${sign.code.toLowerCase()}\\b`, "i");
    if (namedAsSign.test(haystack) || byCode.test(haystack)) {
      return { ok: false, revealed: sign.name };
    }
  }
  return { ok: true, revealed: null };
}

/**
 * A stem must not contain its own answer.
 *
 * `checkStemHidesTheSign` catches the sign being NAMED; this catches it being described. Observed
 * on a real batch: "one of them indicates that drivers must give way to traffic in both
 * directions", with the correct option restating exactly that. Nothing about the picture is being
 * tested — the student reads the answer out of the question.
 *
 * Compared by embedding, because paraphrase is the whole problem.
 */
export const STEM_LEAK_LIMIT = 0.9;

export async function checkStemDoesNotLeakAnswer(
  stem: string,
  correctOptionText: string,
  limit = STEM_LEAK_LIMIT,
): Promise<{ ok: boolean; similarity: number }> {
  const [stemVector, answerVector] = await aiEmbed([stem, correctOptionText]);
  const similarity = cosine(stemVector, answerVector);
  return { ok: similarity < limit, similarity };
}
