import type {
  PrismaClient,
  TranslatableEntity,
  TranslationStatus,
  VariantSource,
} from "@prisma/client";
import { isBuiltinLocale } from "@/lib/locale";
import { logger } from "@/lib/logger";
import type { QuestionPayload, UnitPayload } from "./units";

/**
 * Getting translated text in front of a student (spec-15).
 *
 * Two rules govern everything here.
 *
 * **The overlay never replaces the source, it sits on top of it.** Options are built from the
 * SOURCE keys and their translated text is looked up per key. So a translation missing an option —
 * which the structural gate should already have refused — renders that one option in English
 * rather than throwing. The old code threw when an option key was absent from the requested
 * locale, which was safe when locales were two hand-authored sides and becomes "a bad translation
 * kills a live exam page" the moment a model is involved.
 *
 * **Fallback for exam content is all-or-nothing per question.** An Arabic stem above English
 * options is worse for a graded assessment than plain English throughout, and it is exactly the
 * shape a dispute would fasten onto. UI chrome falls back per key instead — see `catalogue.ts`.
 */

/** Which translations a language's policy allows to be served. */
export function servableStatuses(
  requiresApproval: boolean,
): TranslationStatus[] {
  // NEEDS_REVIEW and REJECTED are never served, under either policy.
  return requiresApproval ? ["APPROVED"] : ["APPROVED", "MACHINE"];
}

export type Overlay = Map<string, UnitPayload>;

/**
 * Load translations for a set of entities in one query.
 *
 * Built-in languages short-circuit to an empty overlay, so `en` and `nb` pay nothing at all for
 * this feature existing.
 */
export async function loadOverlay(
  db: PrismaClient,
  locale: string,
  entity: TranslatableEntity,
  entityIds: string[],
): Promise<Overlay> {
  if (isBuiltinLocale(locale) || entityIds.length === 0) return new Map();

  try {
    const language = await db.language.findUnique({
      where: { code: locale },
      select: { requiresApproval: true },
    });
    if (!language) return new Map();

    const rows = await db.translation.findMany({
      where: {
        locale,
        entity,
        entityId: { in: entityIds },
        status: { in: servableStatuses(language.requiresApproval) },
      },
      select: { entityId: true, value: true },
    });
    return new Map(
      rows.map((row) => [row.entityId, row.value as unknown as UnitPayload]),
    );
  } catch (error) {
    // A translation lookup that fails must degrade to English, never to an error page.
    logger.error(
      { error, locale, entity },
      "translation overlay unreadable — serving the source",
    );
    return new Map();
  }
}

/** What the engine knows about a served variant — enough to find the translation it reads. */
export interface QuestionOverlayRow {
  variantId: string;
  masterItemId: string;
  /** The master version the variant was published from. */
  masterVersion: number;
  source: VariantSource;
  /** The master's version now. */
  currentMasterVersion: number;
}

/**
 * The translation each served variant reads, keyed back by variant id (spec-20).
 *
 * The unit a translator works on is the MASTER item; what a student is served is a variant. A
 * TEMPLATE variant mirrors its master byte for byte (`publish.ts`), so the master's translation
 * IS its translation — looked up here directly, with no copy in between to be skipped by a
 * crashed run or forgotten at approval. Coverage counts masters, so "translated" and "served" are
 * the same fact.
 *
 * Two kinds of variant read English on purpose: one published from an OLDER master version —
 * showing a student a translation of a different question than the one they sat is the failure
 * this exists to avoid — and an AI_VARIATION (spec-17), which carries its own text and will carry
 * its own unit; the ITEM_VARIANT entity is reserved for it.
 */
export async function loadQuestionOverlay(
  db: PrismaClient,
  locale: string,
  rows: QuestionOverlayRow[],
): Promise<Overlay> {
  const eligible = rows.filter(
    (row) =>
      row.source === "TEMPLATE" &&
      row.masterVersion === row.currentMasterVersion,
  );
  if (isBuiltinLocale(locale) || eligible.length === 0) return new Map();

  // One batched read per paper. Index: Translation[locale, entity, entityId] (the unique key).
  const byMaster = await loadOverlay(db, locale, "MASTER_ITEM", [
    ...new Set(eligible.map((row) => row.masterItemId)),
  ]);
  const overlay: Overlay = new Map();
  for (const row of eligible) {
    const payload = byMaster.get(row.masterItemId);
    if (payload) overlay.set(row.variantId, payload);
  }
  return overlay;
}

/**
 * Merge a translated question over its authored source, keyed by option key.
 *
 * The option keys and their order come from the source, always. A translation contributes text and
 * nothing else — it cannot add an option, drop one, or change what a key means.
 */
export function mergeQuestion(
  source: QuestionPayload,
  overlay: UnitPayload | undefined,
): QuestionPayload {
  if (!overlay) return source;
  const translated = overlay as Partial<QuestionPayload>;
  const textByKey = new Map(
    (translated.options ?? []).map((option) => [option.key, option.text]),
  );

  return {
    stem: translated.stem?.trim() ? translated.stem : source.stem,
    options: source.options.map((option) => ({
      key: option.key,
      text: textByKey.get(option.key)?.trim()
        ? (textByKey.get(option.key) as string)
        : option.text,
    })),
    ...(source.explanation !== undefined || translated.explanation !== undefined
      ? {
          explanation: translated.explanation?.trim()
            ? translated.explanation
            : source.explanation,
        }
      : {}),
  };
}

/** The explanation to show: the translation's when it carries one, else the authored text. */
export function mergeExplanation(
  source: string,
  overlay: UnitPayload | undefined,
): string {
  const value = (overlay as { explanation?: unknown } | undefined)?.explanation;
  return typeof value === "string" && value.trim().length > 0 ? value : source;
}

/** One translated string from a name-shaped unit, falling through to the authored value. */
export function mergeName(
  source: string,
  overlay: UnitPayload | undefined,
): string {
  const value = (overlay as { name?: unknown } | undefined)?.name;
  return typeof value === "string" && value.trim().length > 0 ? value : source;
}
