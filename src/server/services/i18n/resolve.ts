import type {
  PrismaClient,
  TranslatableEntity,
  TranslationStatus,
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

/** One translated string from a name-shaped unit, falling through to the authored value. */
export function mergeName(
  source: string,
  overlay: UnitPayload | undefined,
): string {
  const value = (overlay as { name?: unknown } | undefined)?.name;
  return typeof value === "string" && value.trim().length > 0 ? value : source;
}

/**
 * Category and class names for one language, resolved in a single pass.
 *
 * Built once per request rather than per call site: `pickBilingualText` has eight callers across
 * the home page, the setup screen, the result page and the admin tree, and adding a database read
 * to each of them would be exactly the N+1 the mandate forbids.
 */
export async function loadTaxonomy(
  db: PrismaClient,
  locale: string,
  ids: {
    topicIds?: string[];
    licenseClassIds?: string[];
    sourceCodes?: string[];
  } = {},
): Promise<Overlay> {
  if (isBuiltinLocale(locale)) return new Map();
  const [topics, classes, sources] = await Promise.all([
    loadOverlay(db, locale, "TOPIC", ids.topicIds ?? []),
    loadOverlay(db, locale, "LICENSE_CLASS", ids.licenseClassIds ?? []),
    loadOverlay(db, locale, "KB_SOURCE", ids.sourceCodes ?? []),
  ]);
  // One map: the keys are ids and codes, which do not collide across these three kinds.
  return new Map([...topics, ...classes, ...sources]);
}
