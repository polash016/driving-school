import type { PrismaClient } from "@prisma/client";
import { pickBilingualText } from "@/lib/i18n-content";
import { isBuiltinLocale } from "@/lib/locale";
import { logger } from "@/lib/logger";
import { cacheDel, cacheGet, cacheSet, keys } from "@/server/redis";
import { mergeName, servableStatuses } from "./resolve";
import type { UnitPayload } from "./units";

/**
 * Names on the student's screens (spec-20, delivering spec-15 D6).
 *
 * Topic names, the licence class and the legal sources' display names are translation units of
 * their own — counted by coverage, paid for by every run — and until now read by nothing a
 * student sees. One overlay per language, cached in Redis, now serves the result page's per-topic
 * bars, the setup screen, the category standing and the citation line.
 *
 * The § reference itself is never translated: it is a legal address. What a student reads beside
 * it is the source's name — "Trafikkreglene" — rather than its slug.
 */

const CACHE_TTL_SEC = 3_600;

/** entityId (topic id, class id) or KbSource code → translated payload. Keys never collide. */
type TaxonomyOverlay = Record<string, UnitPayload>;

const TAXONOMY_ENTITIES = ["TOPIC", "LICENSE_CLASS", "KB_SOURCE"] as const;

async function taxonomyOverlay(
  db: PrismaClient,
  locale: string,
): Promise<TaxonomyOverlay> {
  if (isBuiltinLocale(locale)) return {};

  const cached = await cacheGet<TaxonomyOverlay>(keys.i18nTaxonomy(locale));
  if (cached) return cached;

  try {
    const language = await db.language.findUnique({
      where: { code: locale },
      select: { requiresApproval: true },
    });
    if (!language) return {};
    // Index: Translation[locale, entity, status]. A few dozen rows per language.
    const rows = await db.translation.findMany({
      where: {
        locale,
        entity: { in: [...TAXONOMY_ENTITIES] },
        status: { in: servableStatuses(language.requiresApproval) },
      },
      select: { entityId: true, value: true },
    });
    const overlay: TaxonomyOverlay = {};
    for (const row of rows)
      overlay[row.entityId] = row.value as unknown as UnitPayload;
    await cacheSet(keys.i18nTaxonomy(locale), overlay, CACHE_TTL_SEC);
    return overlay;
  } catch (error) {
    // A label lookup that fails degrades to the authored name, never to an error page.
    logger.error(
      { error, locale },
      "taxonomy overlay unreadable — serving the source",
    );
    return {};
  }
}

/** Topics with a `label` in the requested language — authored en/nb underneath, as ever. */
export async function localizeTopicNames<
  T extends { id: string; name: unknown },
>(
  db: PrismaClient,
  locale: string,
  topics: T[],
): Promise<Array<T & { label: string }>> {
  const overlay = topics.length > 0 ? await taxonomyOverlay(db, locale) : {};
  return topics.map((topic) => ({
    ...topic,
    label: mergeName(pickBilingualText(topic.name, locale), overlay[topic.id]),
  }));
}

/** Legal source code → display name in the requested language; an unknown code names itself. */
export async function sourceLabels(
  db: PrismaClient,
  locale: string,
  codes: string[],
): Promise<Record<string, string>> {
  const unique = [...new Set(codes)];
  if (unique.length === 0) return {};
  const [sources, overlay] = await Promise.all([
    // Index: KbSource.code (unique).
    db.kbSource.findMany({
      where: { code: { in: unique } },
      select: { code: true, name: true },
    }),
    taxonomyOverlay(db, locale),
  ]);
  const byCode = new Map(sources.map((source) => [source.code, source.name]));
  return Object.fromEntries(
    unique.map((code) => [
      code,
      mergeName(byCode.get(code) ?? code, overlay[code]),
    ]),
  );
}

/** Called wherever a TOPIC / LICENSE_CLASS / KB_SOURCE translation or the policy changes. */
export async function invalidateTaxonomy(locale: string): Promise<void> {
  await cacheDel(keys.i18nTaxonomy(locale));
}
