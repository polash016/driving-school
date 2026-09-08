import { z } from "zod";
import { logger } from "@/lib/logger";
import { aiEmbed, aiJson } from "@/server/ai/client";
import { backTranslatePrompt } from "@/server/ai/prompts/translation";
import { cosine } from "@/server/services/question-bank/similarity";
import {
  isQuestionEntity,
  type QuestionPayload,
  type UnitPayload,
} from "./units";
import type { TranslatableEntity } from "@prisma/client";

/**
 * Semantic QA for translations (spec-15).
 *
 * The structural gate in `validation.ts` catches everything a regex can see. This catches what it
 * cannot: a translation that is well-formed, keeps every number and every option key, and still
 * says something different.
 *
 * Two checks, both built on embeddings so they cost almost nothing:
 *
 * 1. **Drift** — how far the stem moved, measured by back-translating it to English and comparing.
 * 2. **Answer integrity** — of the translated options, the one under the correct key must still be
 *    nearest to the English correct option. If back-option `c` is closest to source-option `a`,
 *    the translation swapped two meanings and *the answer key is now wrong*. This is the check
 *    that actually answers "is the correct answer still correct".
 *
 * The back-translation runs on the `validation` task, so a school can route it to a different
 * model from the one doing the translating. A model checking its own work is a much weaker check,
 * and the route table makes "a different model" a setting rather than a code change.
 */

/**
 * Below this, the stem is flagged and a human looks at it.
 *
 * NOT the 0.94/0.85 thresholds used for question dedupe — those measure whether two questions are
 * the same question, calibrated on `en\nnb` concatenations, and this measures how far a round trip
 * moved one sentence. Different distribution entirely. This number is a starting point: it should
 * be re-measured on the first language's first fifty items, with a human rating them, and the
 * measured value written into DECISIONS.md. Until then, treat the flag as advisory and review
 * everything.
 */
export const SEMANTIC_FLAG_THRESHOLD = 0.86;

/** How much closer a wrong pairing has to be before it counts as a swap rather than noise. */
const PAIRING_MARGIN = 0.02;

/**
 * Below this many characters the drift check is not run at all.
 *
 * Measured, not guessed: on the first real run, six of ten Spanish category names came back at
 * cosine 1.000 and four at 0.637–0.872 — and every one of the four was a correct translation
 * ("Glorietas" for "Roundabouts", "La regla de la derecha" for "The right-hand rule"). Two or three
 * words simply do not carry enough signal for a round-trip cosine to mean anything, and a check
 * that flags correct work teaches reviewers to ignore it.
 *
 * Question stems are sentences and are always well above this. Short names keep the structural
 * checks and, for a language that requires approval, a human — which is the right toolset for a
 * two-word label anyway.
 */
const MIN_CHARS_FOR_DRIFT = 40;

const backTranslationSchema = z.object({
  units: z.array(
    z.object({
      id: z.string(),
      value: z.object({
        stem: z.string().optional(),
        options: z
          .array(z.object({ key: z.string(), text: z.string() }))
          .optional(),
        explanation: z.string().optional(),
        name: z.string().optional(),
        meaning: z.string().optional(),
        description: z.string().optional(),
        text: z.string().optional(),
      }),
    }),
  ),
});

export interface QaInput {
  id: string;
  entity: TranslatableEntity;
  source: UnitPayload;
  translated: UnitPayload;
  correctOptionKey?: string;
}

export interface QaResult {
  id: string;
  semanticScore: number | null;
  flags: string[];
  /** What was checked and what came back — stored on the row so a reviewer can see the working. */
  report: Record<string, unknown>;
}

function stemOf(payload: UnitPayload): string {
  const value = payload as { stem?: string; name?: string; text?: string };
  return value.stem ?? value.name ?? value.text ?? "";
}

/** Google's batchEmbedContents accepts at most 100 requests per call. */
const EMBED_CHUNK = 100;

async function embedAll(
  texts: string[],
  signal?: AbortSignal,
): Promise<number[][]> {
  const vectors: number[][] = [];
  // Sequential, not Promise.all: the runner will soon run several translation batches concurrently
  // against a rate-limited (free-tier) Gemini key — firing all of a batch's chunks at once compounds
  // that.
  for (let start = 0; start < texts.length; start += EMBED_CHUNK) {
    vectors.push(
      ...(await aiEmbed(
        texts.slice(start, start + EMBED_CHUNK),
        signal ? { signal } : {},
      )),
    );
  }
  return vectors;
}

/**
 * Run the semantic pass over a batch.
 *
 * Never throws: QA is a safety net, and a net that takes the run down with it when the provider is
 * having a bad day is worse than no net. A unit whose QA could not run is flagged `QA_UNAVAILABLE`
 * and goes to review, which is the safe direction to fail in.
 */
export async function semanticCheck(input: {
  locale: string;
  languageName: string;
  units: QaInput[];
  /** Worker shutdown. An aborted call is rethrown rather than recorded as a QA verdict. */
  signal?: AbortSignal;
}): Promise<Map<string, QaResult>> {
  const results = new Map<string, QaResult>();
  if (input.units.length === 0) return results;

  let back: z.infer<typeof backTranslationSchema>;
  try {
    const response = await aiJson({
      task: "validation",
      prompt: backTranslatePrompt,
      vars: {
        sourceLanguage: input.languageName,
        unitsJson: JSON.stringify(
          input.units.map((unit) => ({ id: unit.id, value: unit.translated })),
        ),
      },
      schema: backTranslationSchema,
      temperature: 0,
      maxTokens: 8192,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    back = response.data;
  } catch (error) {
    // A shutdown must not be recorded as a QA verdict on a translation that was fine.
    if (input.signal?.aborted) throw error;
    logger.warn(
      { error, locale: input.locale },
      "back-translation unavailable — flagging for review",
    );
    for (const unit of input.units) {
      results.set(unit.id, {
        id: unit.id,
        semanticScore: null,
        flags: ["QA_UNAVAILABLE"],
        report: { backTranslation: "failed" },
      });
    }
    return results;
  }

  const backById = new Map(back.units.map((unit) => [unit.id, unit.value]));

  // One embedding call for the whole batch: every string that needs comparing, in order.
  const texts: string[] = [];
  const index = new Map<
    string,
    { stem: [number, number]; options: Array<[string, number, number]> }
  >();
  for (const unit of input.units) {
    const backValue = backById.get(unit.id);
    if (!backValue) continue;
    const sourceStem = stemOf(unit.source);
    const backStem = stemOf(backValue as UnitPayload);
    if (!sourceStem || !backStem) continue;

    const entry: {
      stem: [number, number];
      options: Array<[string, number, number]>;
    } = {
      stem: [texts.push(sourceStem) - 1, texts.push(backStem) - 1],
      options: [],
    };

    if (isQuestionEntity(unit.entity)) {
      const sourceOptions = (unit.source as QuestionPayload).options ?? [];
      const backOptions = (backValue as QuestionPayload).options ?? [];
      const backByKey = new Map(
        backOptions.map((option) => [option.key, option.text]),
      );
      for (const option of sourceOptions) {
        const backText = backByKey.get(option.key);
        if (!backText) continue;
        entry.options.push([
          option.key,
          texts.push(option.text) - 1,
          texts.push(backText) - 1,
        ]);
      }
    }
    index.set(unit.id, entry);
  }

  let vectors: number[][];
  try {
    // Chunked: a 20-unit question batch is 200 texts, twice Google's per-call cap.
    vectors = texts.length > 0 ? await embedAll(texts, input.signal) : [];
  } catch (error) {
    // A shutdown must not be recorded as a QA verdict on a translation that was fine.
    if (input.signal?.aborted) throw error;
    logger.warn(
      { error, locale: input.locale },
      "QA embeddings unavailable — flagging for review",
    );
    for (const unit of input.units) {
      results.set(unit.id, {
        id: unit.id,
        semanticScore: null,
        flags: ["QA_UNAVAILABLE"],
        report: { embeddings: "failed" },
      });
    }
    return results;
  }

  for (const unit of input.units) {
    const entry = index.get(unit.id);
    if (!entry) {
      results.set(unit.id, {
        id: unit.id,
        semanticScore: null,
        flags: ["QA_UNAVAILABLE"],
        report: { reason: "no comparable text returned" },
      });
      continue;
    }

    const flags: string[] = [];
    const sourceStem = texts[entry.stem[0]];
    const score = cosine(vectors[entry.stem[0]], vectors[entry.stem[1]]);
    const longEnough = sourceStem.length >= MIN_CHARS_FOR_DRIFT;
    if (longEnough && score < SEMANTIC_FLAG_THRESHOLD)
      flags.push("SEMANTIC_DRIFT");

    // Answer integrity: each translated option must still be nearest to its own source option.
    // A swap here means the key now points at a different meaning — the failure that matters.
    const pairings: Array<{
      key: string;
      nearest: string;
      self: number;
      best: number;
    }> = [];
    for (const [key, sourceIndex, backIndex] of entry.options) {
      const backVector = vectors[backIndex];
      let nearest = key;
      let best = -Infinity;
      for (const [otherKey, otherSourceIndex] of entry.options.map(
        ([k, s]) => [k, s] as const,
      )) {
        const similarity = cosine(vectors[otherSourceIndex], backVector);
        if (similarity > best) {
          best = similarity;
          nearest = otherKey;
        }
      }
      const self = cosine(vectors[sourceIndex], backVector);
      pairings.push({ key, nearest, self, best });
      // A margin, because two near-identical distractors can legitimately tie.
      if (nearest !== key && best - self > PAIRING_MARGIN) {
        flags.push("ANSWER_PERMUTED");
      }
    }

    results.set(unit.id, {
      id: unit.id,
      semanticScore: longEnough ? score : null,
      flags: [...new Set(flags)],
      report: {
        stemSimilarity: Number(score.toFixed(4)),
        threshold: longEnough ? SEMANTIC_FLAG_THRESHOLD : null,
        driftChecked: longEnough,
        optionPairings: pairings.map((pairing) => ({
          key: pairing.key,
          nearest: pairing.nearest,
          self: Number(pairing.self.toFixed(4)),
          best: Number(pairing.best.toFixed(4)),
        })),
      },
    });
  }

  return results;
}
