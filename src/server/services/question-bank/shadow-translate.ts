import type { PrismaClient, TranslationStatus } from "@prisma/client";
import { logger } from "@/lib/logger";
import { servableStatuses } from "@/server/services/i18n/resolve";
import {
  translateBatch,
  type LanguagePolicy,
  type TranslatedUnit,
} from "@/server/services/i18n/translate";
import { hashUnit, type TranslationUnit } from "@/server/services/i18n/units";
import type { QuestionContent } from "./simplify";
import type { RewriteTranslation } from "./rewrite";

/**
 * Translating a question BEFORE it goes live (spec-22).
 *
 * ## Why this exists instead of letting the normal sync do it
 *
 * The ordinary pipeline translates what is already in `MasterItem`. If the campaign rewrote the
 * source and left the sync to catch up, every non-built-in language would be stale in between —
 * and stale does not mean "missing". `loadOverlay` picks a translation by status alone and never
 * compares `sourceHash`, and `mergeQuestion` merges by option key, so the OLD Bangla would be
 * served over the NEW English, silently, with every key matching. In a sign question, where an
 * option's text IS another sign's meaning, that can leave two defensible options.
 *
 * The alternative — parking the stale rows so the question reads English — is correct but visible:
 * with ~2 040 approved translations each in bn and es, that window is days of students reading a
 * language they did not choose.
 *
 * So the translation is done FIRST, against the proposed text, and held in the proposal. The swap
 * then writes content, variant and every locale together. A student sees neither a stale pairing
 * nor a fallback.
 *
 * ## What it reuses
 *
 * `translateBatch` entirely: translation memory, the glossary, the deterministic gate, the QA
 * sample and the status decision. This module only builds the unit and decides whether the result
 * is good enough to swap with — it re-implements none of the translation logic, which is exactly
 * the part that must not have a second version.
 */

export interface ShadowTranslationResult {
  locale: string;
  /** Null when the QA gate refused it — the proposal cannot swap until this is resolved. */
  translation: RewriteTranslation | null;
  qaFlags: string[];
  reason?: string;
}

/**
 * Translate one proposed question into one language and decide whether it may go live.
 *
 * The bar is deliberately the SERVING bar, not the storage bar: a translation that would not be
 * shown to a student under this language's own policy is not one to swap in, because swapping it
 * would put the question back into exactly the English-fallback state this design exists to avoid.
 */
export async function shadowTranslate(
  db: PrismaClient,
  language: LanguagePolicy & { requiresApproval: boolean },
  input: { itemId: string; proposed: QuestionContent; correctOptionKey: string; label: string },
): Promise<ShadowTranslationResult> {
  const unit: TranslationUnit = {
    entity: "MASTER_ITEM",
    entityId: input.itemId,
    en: input.proposed.en,
    nb: input.proposed.nb,
    correctOptionKey: input.correctOptionKey,
    label: input.label,
    sourceHash: hashUnit(
      { entity: "MASTER_ITEM", en: input.proposed.en, nb: input.proposed.nb },
      language.glossaryVersion,
    ),
  };

  let results: TranslatedUnit[];
  try {
    results = await translateBatch(db, language, [unit]);
  } catch (error) {
    logger.warn(
      { itemId: input.itemId, locale: language.code, error },
      "shadow translation failed",
    );
    return {
      locale: language.code,
      translation: null,
      qaFlags: [],
      reason: "translation call failed",
    };
  }

  const result = results[0];
  if (!result) {
    return { locale: language.code, translation: null, qaFlags: [], reason: "no result" };
  }

  // The serving bar: APPROVED always, MACHINE only where the language does not require a human.
  // NEEDS_REVIEW and REJECTED are never served, so swapping one in would mean English anyway.
  const servable = servableStatuses(language.requiresApproval);
  if (!servable.includes(result.status)) {
    return {
      locale: language.code,
      translation: null,
      qaFlags: result.qaFlags,
      reason: `QA returned ${result.status}: ${result.qaFlags.join(", ") || "no flags"}`,
    };
  }

  return {
    locale: language.code,
    qaFlags: result.qaFlags,
    translation: {
      locale: language.code,
      value: result.value as never,
      // MACHINE, not APPROVED: the old row's approval was for the OLD text, and carrying it over
      // would forge a human sign-off for words nobody read. Where a language requires approval,
      // `translateBatch` will not have returned a servable status at all, so this is only reached
      // for languages that serve MACHINE — which is what keeps the swap gap-free and honest.
      status: result.status as TranslationStatus,
      sourceHash: unit.sourceHash,
      qaFlags: result.qaFlags,
      modelVersion: result.modelVersion,
      promptVersion: result.promptVersion,
      providerLabel: result.providerLabel,
    },
  };
}

export interface ShadowSet {
  ready: boolean;
  translations: RewriteTranslation[];
  failures: Array<{ locale: string; reason: string; qaFlags: string[] }>;
}

/**
 * Translate one proposal into every target language.
 *
 * `ready` is decided by the STUDENT-VISIBLE languages only, and that distinction is load-bearing.
 *
 * The no-gap guarantee is about what a student reads. A language nobody can open cannot show
 * anyone a stale pairing or an English fallback, so it has no vote on whether the swap may
 * proceed. Requiring it anyway is not caution, it is a deadlock: `ar` carries
 * `requiresApproval = true`, so a freshly machine-translated unit is never servable in it until a
 * human approves, and an all-or-nothing rule would therefore hold every item in the campaign
 * forever while changing nothing for any student.
 *
 * Unpublished languages are still translated, and their result still travels with the swap when it
 * is good — they simply do not block it. `bn` and `es` are the ones that must be ready, and both
 * serve MACHINE, so both can be.
 */
export async function shadowTranslateAll(
  db: PrismaClient,
  languages: Array<
    LanguagePolicy & { requiresApproval: boolean; studentVisible: boolean }
  >,
  input: { itemId: string; proposed: QuestionContent; correctOptionKey: string; label: string },
): Promise<ShadowSet> {
  const translations: RewriteTranslation[] = [];
  const failures: ShadowSet["failures"] = [];
  const blocking: ShadowSet["failures"] = [];

  // Serially, not in parallel: `translationParallelSlots` is 1 because three slots measured 161
  // rate-limit rejections in one run. Fanning out per language here would reintroduce exactly that.
  for (const language of languages) {
    const result = await shadowTranslate(db, language, input);
    if (result.translation) {
      translations.push(result.translation);
      continue;
    }
    const failure = {
      locale: language.code,
      reason: result.reason ?? "unknown",
      qaFlags: result.qaFlags,
    };
    failures.push(failure);
    if (language.studentVisible) blocking.push(failure);
  }

  return { ready: blocking.length === 0, translations, failures };
}

/** The languages a campaign must satisfy: everything a student could be reading. */
export async function targetLanguages(
  db: PrismaClient,
): Promise<
  Array<LanguagePolicy & { requiresApproval: boolean; studentVisible: boolean }>
> {
  const rows = await db.language.findMany({
    where: { isBuiltIn: false },
    select: {
      code: true,
      englishName: true,
      nativeName: true,
      glossary: true,
      glossaryVersion: true,
      styleNote: true,
      qaSampleRate: true,
      requiresApproval: true,
      studentVisible: true,
    },
    orderBy: { code: "asc" },
  });
  return rows.map((row) => ({
    ...row,
    glossary: (row.glossary ?? null) as Record<string, string> | null,
  }));
}
