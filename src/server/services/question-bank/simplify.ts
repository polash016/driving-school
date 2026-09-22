import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { schoolConfig } from "../../../../config/school.config";
import {
  countWords,
  wordBudget,
  type BrevityKind,
} from "@/lib/brevity";
import { logger } from "@/lib/logger";
import { aiJson } from "@/server/ai/client";
import { simplifyQuestionPrompt } from "@/server/ai/prompts/simplify";
import {
  checkDistractorDistinctness,
  checkStemDoesNotLeakAnswer,
  verifyAnswerBlind,
} from "@/server/services/pipeline/validators";
import { checkTranslation } from "@/server/services/i18n/validation";
import {
  classifyAgainstPool,
  embedStems,
} from "./similarity";
import { contentFingerprint } from "./rewrite";
import {
  brevityBlockers,
  checkItemQuality,
  stemFingerprint,
} from "./validation";

/**
 * Proposing a shorter version of an already-approved question, and proving it is still the same
 * question (spec-22).
 *
 * ## The governing rule
 *
 * Every check below fails the same way: **refuse the rewrite and leave the question exactly as it
 * is.** There is no retry loop and no threshold the campaign may lower. The existing question is
 * correct; it is merely long. A question that stays long is a non-event. A question whose answer
 * quietly moved is a learner taught the wrong rule and marked correct for it.
 *
 * ## Why the order of the checks is what it is
 *
 * Deterministic and free first, then one embedding call, then the model call that actually sits
 * the question. A rewrite that renamed an option key costs nothing to reject; only a candidate
 * that could plausibly survive is worth spending a blind check on.
 */

const sideSchema = z.object({
  stem: z.string().min(1).max(400),
  options: z.array(z.object({ key: z.string().min(1).max(8), text: z.string().min(1).max(300) })).min(2).max(6),
  explanation: z.string().min(1).max(1000),
});

export const simplifyResponseSchema = z.object({
  en: sideSchema,
  nb: sideSchema,
  unchanged: z.boolean().optional().default(false),
  changeNote: z.string().max(400).optional(),
});

export type QuestionSide = z.infer<typeof sideSchema>;
export interface QuestionContent {
  en: QuestionSide;
  nb: QuestionSide;
}

export type Verdict = "ACCEPT" | "REFUSE" | "UNCHANGED";

export interface Proposal {
  itemId: string;
  verdict: Verdict;
  findings: string[];
  proposed: QuestionContent | null;
  previous: QuestionContent;
  expectedVersion: number;
  expectedFingerprint: string;
  checks: Record<string, unknown>;
  modelVersion?: string;
  promptVersion?: string;
  verifierModel?: string;
  /** Recomputed from the new stem; the old vector describes text that no longer exists. */
  stemEmbedding?: number[];
  /** The accepted text's stem fingerprint, so the caller can add it to its pool snapshot. */
  newFingerprint?: string;
}

export interface SimplifiableItem {
  id: string;
  type: "TEXT" | "IMAGE" | "SIGN";
  version: number;
  content: unknown;
  correctOptionKey: string | null;
  legalCitations: unknown;
  difficulty: number;
  sourceImageId: string | null;
}

/** True when every field is already inside the TARGET budget (not merely under the ceiling). */
export function withinTargets(
  content: QuestionContent,
  type: SimplifiableItem["type"],
): boolean {
  const targets = schoolConfig.content.brevity;
  const optionKind: BrevityKind = type === "SIGN" ? "signMeaning" : "option";
  for (const locale of ["en", "nb"] as const) {
    const side = content[locale];
    if (!side) continue;
    if (
      countWords(side.stem, locale) >
      wordBudget({ kind: "stem", locale, targets })
    ) {
      return false;
    }
    for (const option of side.options ?? []) {
      if (
        countWords(option.text, locale) >
        wordBudget({ kind: optionKind, locale, targets })
      ) {
        return false;
      }
    }
    if (
      side.explanation &&
      countWords(side.explanation, locale) >
        wordBudget({ kind: "explanation", locale, targets })
    ) {
      return false;
    }
  }
  return true;
}

/** Everything a rewrite is forbidden to change, checked without spending a token. */
export function checkStructuralIdentity(
  previous: QuestionContent,
  proposed: QuestionContent,
  correctOptionKey: string,
): string[] {
  const findings: string[] = [];

  for (const locale of ["en", "nb"] as const) {
    const before = previous[locale]?.options ?? [];
    const after = proposed[locale]?.options ?? [];

    if (before.length !== after.length) {
      findings.push("OPTION_COUNT_CHANGED");
      continue;
    }
    // Byte-exact AND in order. Sorting first would let a reorder through, and the engine serves
    // one shuffled key order to both locales — so a reorder makes the two languages grade
    // differently.
    const beforeKeys = before.map((o) => o.key).join(",");
    const afterKeys = after.map((o) => o.key).join(",");
    if (beforeKeys !== afterKeys) findings.push("OPTION_KEYS_CHANGED");
    if (!after.some((o) => o.key === correctOptionKey)) {
      findings.push("ANSWER_KEY_LOST");
    }
  }

  const enKeys = (proposed.en?.options ?? []).map((o) => o.key).join(",");
  const nbKeys = (proposed.nb?.options ?? []).map((o) => o.key).join(",");
  if (enKeys !== nbKeys) findings.push("LOCALE_KEY_MISMATCH");

  return [...new Set(findings)];
}

/**
 * Did it actually get shorter?
 *
 * A "rewrite" no shorter than the original is churn: it would bump the version, invalidate every
 * translation and cost a full re-translation in four languages, to change nothing a student sees.
 */
export function checkGotShorter(
  previous: QuestionContent,
  proposed: QuestionContent,
): { shorter: boolean; findings: string[] } {
  const findings: string[] = [];
  let anyShorter = false;

  for (const locale of ["en", "nb"] as const) {
    const before = previous[locale];
    const after = proposed[locale];
    if (!before || !after) continue;

    const beforeStem = countWords(before.stem, locale);
    const afterStem = countWords(after.stem, locale);
    if (afterStem < beforeStem) anyShorter = true;
    if (afterStem > beforeStem) findings.push(`STEM_GREW_${locale.toUpperCase()}`);

    for (const option of after.options) {
      const match = before.options.find((o) => o.key === option.key);
      if (!match) continue;
      const b = countWords(match.text, locale);
      const a = countWords(option.text, locale);
      if (a < b) anyShorter = true;
      if (a > b) findings.push(`OPTION_GREW_${locale.toUpperCase()}`);
    }
  }
  return { shorter: anyShorter, findings: [...new Set(findings)] };
}

/**
 * Numbers, units and § references must survive verbatim.
 *
 * Reuses the spec-21 translation gate rather than reimplementing it: treating the rewrite as a
 * "translation" from English into English gets NUMBER_DRIFT and CITATION_DRIFT — including the
 * native-digit normalisation that took a production run to get right — for free, and keeps one
 * implementation of a rule that must never differ between the two paths.
 */
export function checkNumbersPreserved(
  previous: QuestionContent,
  proposed: QuestionContent,
  correctOptionKey: string,
): string[] {
  const findings: string[] = [];
  for (const locale of ["en", "nb"] as const) {
    const check = checkTranslation({
      entity: "MASTER_ITEM",
      locale,
      source: previous[locale] as never,
      translated: proposed[locale] as never,
      correctOptionKey,
    });
    for (const issue of check.issues) {
      // UNTRANSLATED means "the text is unchanged", which is the point here, not a fault.
      // VERBOSE and LENGTH_OUTLIER are about length, which is what we are deliberately changing.
      if (["UNTRANSLATED", "VERBOSE", "LENGTH_OUTLIER"].includes(issue.code)) continue;
      if (issue.blocking) findings.push(issue.code);
    }
  }
  return [...new Set(findings)];
}

/** The legal text behind a question, resolved without spending an embedding call. */
export async function citedText(
  db: PrismaClient,
  item: SimplifiableItem,
): Promise<string> {
  const citations = (item.legalCitations ?? []) as Array<{
    sourceCode?: string;
    ref?: string;
  }>;
  if (!Array.isArray(citations) || citations.length === 0) return "";

  // Deliberately NOT kb/search: that is one embedding request per item, ~1000 requests straight
  // into the daily cap, to fetch rows we can address directly.
  const usable = citations.filter(
    (c): c is { sourceCode: string; ref: string } =>
      Boolean(c.sourceCode?.trim() && c.ref?.trim()),
  );
  if (usable.length === 0) return "";

  const lookup = async (
    pairs: Array<{ sourceCode: string; ref: string }>,
  ): Promise<string[]> => {
    if (pairs.length === 0) return [];
    const rows = await db.kbChunk.findMany({
      where: {
        // `isActive` belongs to the CHUNK; `KbSource` carries `code` and `deletedAt`.
        isActive: true,
        OR: pairs.map((c) => ({
          ref: c.ref,
          source: { code: c.sourceCode, deletedAt: null },
        })),
      },
      select: { text: true },
      take: 12,
    });
    return rows.map((row) => row.text);
  };

  const exact = await lookup(usable);
  if (exact.length > 0) return exact.join("\n\n");

  // Fall back to the whole SECTION. The knowledge base is chunked per section ("§ 7"), while a
  // citation may name a subsection ("§ 7 nr. 3", "§ 13-3"). Measured on the production bank: 9 of
  // 20 text questions resolved nothing on an exact match, and most of those cite a subsection of a
  // section that IS ingested. Refusing them would skip a correct question for a formatting
  // mismatch. What stays unresolvable is a source never ingested at all — `vegtrafikkloven` and
  // `kjoretoyforskriften` have zero chunks — and refusing those is right, because the blind check
  // would have no ground truth to answer from.
  const heads = usable
    .map((c) => {
      const match = c.ref.match(/§\s*(\d+)/);
      return match ? { sourceCode: c.sourceCode, ref: `§ ${match[1]}` } : null;
    })
    .filter((c): c is { sourceCode: string; ref: string } => c !== null);

  return (await lookup(heads)).join("\n\n");
}

export interface ProposeOptions {
  /** Skip the blind answer check. Only for SIGN items — see `simplify-signs`. */
  skipBlindCheck?: boolean;
  /**
   * Every approved/in-review stem fingerprint, mapped to its item id, snapshotted ONCE per run.
   *
   * `checkItemQualityAgainstPool` reads all ~722 rows on every call; doing that per item would be
   * ~520 000 row reads across a campaign. Just as important, the caller mutates this map as it
   * accepts proposals, so two items rewritten in the same run that collapse into the same stem are
   * caught against each other — a database-only check cannot see that.
   */
  poolFingerprints?: Map<string, string>;
}

/** Snapshot the bank's stem fingerprints once, for `poolFingerprints`. */
export async function loadPoolFingerprints(
  db: PrismaClient,
): Promise<Map<string, string>> {
  const rows = await db.masterItem.findMany({
    where: { deletedAt: null, status: { in: ["APPROVED", "IN_REVIEW"] } },
    select: { id: true, content: true, sourceImageId: true },
  });
  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(stemFingerprint(row.content, row.sourceImageId), row.id);
  }
  return map;
}

/**
 * Ask for a shorter version of one question and put it through every gate.
 *
 * Returns a proposal with `verdict`. Nothing is written to `MasterItem` here — applying is a
 * separate, transactional step that also carries the translations (`rewrite.ts`).
 */
export async function proposeSimplification(
  db: PrismaClient,
  item: SimplifiableItem,
  options: ProposeOptions = {},
): Promise<Proposal> {
  const previous = item.content as QuestionContent;
  const base: Omit<Proposal, "verdict" | "findings" | "proposed"> = {
    itemId: item.id,
    previous,
    expectedVersion: item.version,
    expectedFingerprint: contentFingerprint(item.content),
    checks: {},
  };
  const refuse = (findings: string[], checks: Record<string, unknown> = {}) => ({
    ...base,
    verdict: "REFUSE" as const,
    findings,
    proposed: null,
    checks: { ...base.checks, ...checks },
  });

  if (!item.correctOptionKey) return refuse(["ANSWER_MISSING"]);

  // Already short enough? Then do not touch it.
  //
  // Measured on the production bank: 3 of the first 8 text questions were inside budget already
  // (a 14-word stem with a 3-word worst option, for instance). Sending those to a model buys
  // nothing a student would notice and costs a call, a version bump, a re-translation in four
  // languages, and a real chance of introducing drift — one of them came back with a changed
  // number and had to be refused. The cheapest safe rewrite is the one not attempted.
  if (brevityBlockers(previous, item.type).length === 0 && withinTargets(previous, item.type)) {
    return { ...base, verdict: "UNCHANGED", findings: ["ALREADY_SHORT"], proposed: null };
  }

  const legal = await citedText(db, item);
  if (!legal) {
    // A citation pointing at nothing means the blind check has no ground truth to work from.
    // Rewriting it would be guessing; this also doubles as a free audit of citation integrity.
    return refuse(["CITATION_UNRESOLVABLE"]);
  }

  const brevity = schoolConfig.content.brevity;
  const response = await aiJson({
    task: "generation",
    prompt: simplifyQuestionPrompt,
    vars: {
      questionJson: JSON.stringify({ ...previous, correctOptionKey: item.correctOptionKey }, null, 2),
      correctOptionKey: item.correctOptionKey,
      citedText: legal,
      maxStemWords: brevity.stemWords,
      maxOptionWords: item.type === "SIGN" ? brevity.signMeaningWords : brevity.optionWords,
      maxExplanationSentences: brevity.explanationSentences,
    },
    schema: simplifyResponseSchema,
    // A rewrite has no creative budget: determinism makes a re-run reproducible and a disputed
    // item re-checkable.
    temperature: 0,
  });

  const meta = {
    modelVersion: response.modelVersion,
    promptVersion: response.promptVersion,
  };
  const proposed: QuestionContent = { en: response.data.en, nb: response.data.nb };

  // The model said it could not shorten safely. That is an answer, not a failure.
  if (response.data.unchanged) {
    return { ...base, ...meta, verdict: "UNCHANGED", findings: [], proposed: null };
  }

  // 1. Structural identity — the catastrophic failure, caught for free.
  const structural = checkStructuralIdentity(previous, proposed, item.correctOptionKey);
  if (structural.length > 0) return { ...refuse(structural), ...meta };

  // 2. Numbers, units and § references.
  const numbers = checkNumbersPreserved(previous, proposed, item.correctOptionKey);
  if (numbers.length > 0) return { ...refuse(numbers), ...meta };

  // 3. The deterministic quality gate, at the CEILING — the rewrite must actually meet the budget.
  const quality = checkItemQuality({
    id: item.id,
    type: item.type,
    content: proposed,
    correctOptionKey: item.correctOptionKey,
    legalCitations: item.legalCitations,
    difficulty: item.difficulty,
    sourceImageId: item.sourceImageId,
  });
  if (!quality.passed) {
    return { ...refuse(quality.errors.map((e) => e.code)), ...meta };
  }
  const tooLong = brevityBlockers(proposed, item.type);
  if (tooLong.length > 0) return { ...refuse(tooLong), ...meta };

  // 4. Did it get shorter at all?
  const shorter = checkGotShorter(previous, proposed);
  if (shorter.findings.length > 0) return { ...refuse(shorter.findings), ...meta };
  if (!shorter.shorter) {
    return { ...base, ...meta, verdict: "UNCHANGED", findings: ["NO_GAIN"], proposed: null };
  }

  // 5. Distractor distinctness. The sharpest risk in the campaign: shortening four options can
  //    collapse two into paraphrases, which makes the question ungradeable rather than merely
  //    wrong — a student is marked incorrect for a distinction that no longer exists.
  const distinct = await checkDistractorDistinctness(proposed.en.options);
  if (!distinct.ok) {
    return {
      ...refuse(["DISTRACTOR_COLLISION"], {
        collidingKeys: distinct.collidingKeys,
        similarity: distinct.similarity,
      }),
      ...meta,
    };
  }

  // 6. A shortened stem must not have started stating its own answer.
  const correctText =
    proposed.en.options.find((o) => o.key === item.correctOptionKey)?.text ?? "";
  const leak = await checkStemDoesNotLeakAnswer(proposed.en.stem, correctText);
  if (!leak.ok) {
    return { ...refuse(["STEM_LEAKS_ANSWER"], { similarity: leak.similarity }), ...meta };
  }

  // 7. Duplicate safety. Shortening makes two previously distinct questions far likelier to
  //    converge — on the exact normalised stem, or semantically.
  const newFingerprint = stemFingerprint(proposed, item.sourceImageId);
  const twinId = options.poolFingerprints?.get(newFingerprint);
  if (twinId && twinId !== item.id) {
    return { ...refuse(["DUPLICATE_OF_EXISTING"], { twinId }), ...meta };
  }

  const [embedding] = await embedStems([
    { en: proposed.en.stem, nb: proposed.nb.stem },
  ]);
  const verdict = await classifyAgainstPool(db, embedding, item.id);
  if (verdict.kind === "repeat") {
    return { ...refuse(["DUPLICATE_OF_EXISTING"], { twinId: verdict.matchedItemId }), ...meta };
  }

  // 8. THE check: sit the question blind and see whether the key still wins.
  if (!options.skipBlindCheck) {
    const blind = await verifyAnswerBlind({
      stem: proposed.en.stem,
      options: proposed.en.options,
      correctOptionKey: item.correctOptionKey,
      // A text question has no scene; `sceneSupported` defaults to true, so an absent scene
      // cannot refuse it spuriously.
      situationSummary:
        item.type === "TEXT"
          ? "A learner sitting the Norwegian class B theory test. No picture is shown."
          : "",
      signNames: [],
      legalText: legal,
      seed: `simplify:${item.id}:${contentFingerprint(proposed)}`,
    });
    if (!blind.verified) {
      // Before blaming the rewrite, sit the ORIGINAL question the same way.
      //
      // "The verifier disagrees with the key" has two very different causes: the shortening moved
      // the answer, or the question was already arguable and nobody had checked — the theory
      // generation path never ran a blind check, so ~148 production questions have never had their
      // key independently reproduced. Only the second call tells them apart, and it is worth its
      // cost because the two need opposite responses: the first is a rewrite to discard, the second
      // is a defect in the live bank that a human must look at.
      //
      // Run only on disagreement, so a healthy item never pays for it.
      const baseline = await verifyAnswerBlind({
        stem: previous.en.stem,
        options: previous.en.options,
        correctOptionKey: item.correctOptionKey,
        situationSummary:
          item.type === "TEXT"
            ? "A learner sitting the Norwegian class B theory test. No picture is shown."
            : "",
        signNames: [],
        legalText: legal,
        seed: `baseline:${item.id}`,
      }).catch(() => null);

      if (baseline && !baseline.verified) {
        logger.warn(
          { itemId: item.id, reason: baseline.reason },
          "PRE-EXISTING DISPUTE: the approved question fails a blind answer check as it stands",
        );
        return {
          ...refuse(["PREEXISTING_DISPUTE"], {
            rewriteReason: blind.reason,
            originalReason: baseline.reason,
          }),
          ...meta,
          verifierModel: blind.verifierModel,
        };
      }

      return {
        ...refuse(["BLIND_DISAGREED"], { reason: blind.reason }),
        ...meta,
        verifierModel: blind.verifierModel,
      };
    }
    return {
      ...base,
      ...meta,
      verifierModel: blind.verifierModel,
      verdict: "ACCEPT",
      findings: [],
      proposed,
      stemEmbedding: embedding,
      newFingerprint,
      checks: { distinctness: distinct.similarity, leak: leak.similarity, blind: true },
    };
  }

  logger.info({ itemId: item.id }, "simplification proposed");
  return {
    ...base,
    ...meta,
    verdict: "ACCEPT",
    findings: [],
    proposed,
    stemEmbedding: embedding,
    newFingerprint,
    checks: { distinctness: distinct.similarity, leak: leak.similarity, blind: false },
  };
}
