import {
  Prisma,
  type PrismaClient,
  type TranslatableEntity,
} from "@prisma/client";
import { BASE_MESSAGES } from "@/i18n/builtin";
import { flattenMessages } from "./catalogue";
import {
  hashUnit,
  type QuestionPayload,
  type TranslationUnit,
  type UnitPayload,
} from "./units";

/**
 * Everything that needs translating, read out of the source of truth (spec-15).
 *
 * This is where the sync's cheapness comes from: extraction computes a hash per unit, and the
 * planner keeps only the units whose hash has no matching translation. Nothing else is ever sent
 * to a model, so a second run over unchanged content costs zero tokens.
 *
 * Deliberately NOT extracted: `KbChunk.text`. The knowledge base is the Norwegian law the AI cites
 * when writing questions; putting a translation layer between a question and the law it rests on
 * is precisely what a disputed mark does not need.
 */

type Messages = Record<string, unknown>;

function questionPayload(side: unknown): QuestionPayload | null {
  const value = side as
    | { stem?: unknown; options?: unknown; explanation?: unknown }
    | null
    | undefined;
  if (!value || typeof value.stem !== "string" || !Array.isArray(value.options))
    return null;
  const options = value.options
    .map((option) => option as { key?: unknown; text?: unknown })
    .filter(
      (option): option is { key: string; text: string } =>
        typeof option.key === "string" && typeof option.text === "string",
    )
    .map((option) => ({ key: option.key, text: option.text }));
  if (options.length === 0) return null;
  return {
    stem: value.stem,
    options,
    explanation: typeof value.explanation === "string" ? value.explanation : "",
  };
}

function bilingual(value: unknown): { en?: string; nb?: string } {
  const content = value as { en?: unknown; nb?: unknown } | null;
  return {
    en: typeof content?.en === "string" ? content.en : undefined,
    nb: typeof content?.nb === "string" ? content.nb : undefined,
  };
}

function unit(
  entity: TranslatableEntity,
  entityId: string,
  en: UnitPayload,
  nb: UnitPayload | undefined,
  label: string,
  glossaryVersion: number,
  correctOptionKey?: string,
): TranslationUnit {
  return {
    entity,
    entityId,
    en,
    nb,
    label,
    correctOptionKey,
    sourceHash: hashUnit({ entity, en, nb }, glossaryVersion),
  };
}

/**
 * Namespaces a student never sees.
 *
 * Admin and instructor screens stay English/Norwegian by design — the staff running a Norwegian
 * driving school read those, not the students. Leaving them in the denominator would mean no
 * language could ever reach the coverage a school needs to switch it on, and would spend two
 * thirds of every translation budget on screens nobody in that language will open.
 */
const STAFF_ONLY_NAMESPACES = ["admin"];

/** Every student-facing UI message key. */
export function extractMessages(
  glossaryVersion: number,
  ids?: string[],
): TranslationUnit[] {
  const flat = flattenMessages(BASE_MESSAGES as Messages);
  return Object.entries(flat)
    .filter(([key]) => !STAFF_ONLY_NAMESPACES.includes(key.split(".")[0]))
    .filter(([key]) => (ids ? ids.includes(key) : true))
    .map(([key, text]) =>
      unit("UI_MESSAGE", key, { text }, undefined, key, glossaryVersion),
    );
}

/**
 * Approved questions, as authored.
 *
 * The MASTER item is the unit a reviewer approves. What a student is actually served is an
 * `ItemVariant`, which is derived from the approved master translation at no token cost — see
 * `deriveVariantTranslations`.
 */
export async function extractMasterItems(
  db: PrismaClient,
  glossaryVersion: number,
  ids?: string[],
): Promise<TranslationUnit[]> {
  const items = await db.masterItem.findMany({
    where: {
      status: "APPROVED",
      deletedAt: null,
      // Templated items are excluded from v1: translating a template means carrying {{slot}}
      // tokens through an AI round trip. None exist today (0 of 139), and the coverage report
      // names any that appear rather than letting them fail quietly.
      parameterSlots: { equals: Prisma.DbNull },
      ...(ids ? { id: { in: ids } } : {}),
    },
    select: { id: true, content: true, correctOptionKey: true },
  });

  const units: TranslationUnit[] = [];
  for (const item of items) {
    const content = item.content as { en?: unknown; nb?: unknown } | null;
    const en = questionPayload(content?.en);
    if (!en) continue; // an item without usable English cannot be translated from
    const nb = questionPayload(content?.nb) ?? undefined;
    units.push(
      unit(
        "MASTER_ITEM",
        item.id,
        en,
        nb,
        en.stem.slice(0, 80),
        glossaryVersion,
        item.correctOptionKey ?? undefined,
      ),
    );
  }
  return units;
}

export async function extractTopics(
  db: PrismaClient,
  glossaryVersion: number,
  ids?: string[],
): Promise<TranslationUnit[]> {
  const topics = await db.topic.findMany({
    where: { deletedAt: null, ...(ids ? { id: { in: ids } } : {}) },
    select: { id: true, slug: true, name: true, description: true },
  });
  return topics.map((topic) => {
    const name = bilingual(topic.name);
    const description = bilingual(topic.description);
    return unit(
      "TOPIC",
      topic.id,
      {
        name: name.en ?? topic.slug,
        ...(description.en ? { description: description.en } : {}),
      },
      name.nb
        ? {
            name: name.nb,
            ...(description.nb ? { description: description.nb } : {}),
          }
        : undefined,
      name.en ?? topic.slug,
      glossaryVersion,
    );
  });
}

export async function extractLicenseClasses(
  db: PrismaClient,
  glossaryVersion: number,
  ids?: string[],
): Promise<TranslationUnit[]> {
  const classes = await db.licenseClass.findMany({
    where: { ...(ids ? { id: { in: ids } } : {}) },
    select: { id: true, code: true, name: true },
  });
  return classes.map((licenseClass) => {
    const name = bilingual(licenseClass.name);
    return unit(
      "LICENSE_CLASS",
      licenseClass.id,
      { name: name.en ?? licenseClass.code },
      name.nb ? { name: name.nb } : undefined,
      licenseClass.code,
      glossaryVersion,
    );
  });
}

export async function extractSigns(
  db: PrismaClient,
  glossaryVersion: number,
  ids?: string[],
): Promise<TranslationUnit[]> {
  const signs = await db.sign.findMany({
    where: { ...(ids ? { id: { in: ids } } : {}) },
    select: { id: true, code: true, name: true, meaning: true },
  });
  return signs.map((sign) => {
    const name = bilingual(sign.name);
    const meaning = bilingual(sign.meaning);
    return unit(
      "SIGN",
      sign.id,
      { name: name.en ?? sign.code, meaning: meaning.en ?? "" },
      name.nb ? { name: name.nb, meaning: meaning.nb ?? "" } : undefined,
      sign.code,
      glossaryVersion,
    );
  });
}

/**
 * The display name of a legal source.
 *
 * This is what "translate the legal citation text" actually amounts to: the § reference itself is
 * an address and is quoted verbatim, but "Trafikkreglene" is a label a student should be able to
 * read. Students currently see the raw slug; the resolver renders this instead.
 */
export async function extractKbSources(
  db: PrismaClient,
  glossaryVersion: number,
  ids?: string[],
): Promise<TranslationUnit[]> {
  const sources = await db.kbSource.findMany({
    where: { ...(ids ? { code: { in: ids } } : {}) },
    select: { code: true, name: true },
  });
  return sources.map((source) =>
    unit(
      "KB_SOURCE",
      source.code,
      { name: source.name },
      undefined,
      source.code,
      glossaryVersion,
    ),
  );
}

export interface ExtractOptions {
  glossaryVersion: number;
  /** Limit to one kind — the "translate just the UI" path in the admin screen. */
  only?: TranslatableEntity[];
  /** Restrict to these entityIds (per-entity primary key, or message key / KbSource.code).
   * The runner extracts per batch; without this every batch re-read the whole bank to keep a
   * handful of ids. */
  ids?: string[];
}

/** Every translatable unit in the system, hashed and ready to be compared with what exists. */
export async function extractAll(
  db: PrismaClient,
  options: ExtractOptions,
): Promise<TranslationUnit[]> {
  const wanted = (entity: TranslatableEntity) =>
    !options.only || options.only.includes(entity);
  const { ids } = options;
  const groups = await Promise.all([
    wanted("UI_MESSAGE") ? extractMessages(options.glossaryVersion, ids) : [],
    wanted("MASTER_ITEM")
      ? extractMasterItems(db, options.glossaryVersion, ids)
      : [],
    wanted("TOPIC") ? extractTopics(db, options.glossaryVersion, ids) : [],
    wanted("LICENSE_CLASS")
      ? extractLicenseClasses(db, options.glossaryVersion, ids)
      : [],
    wanted("SIGN") ? extractSigns(db, options.glossaryVersion, ids) : [],
    wanted("KB_SOURCE")
      ? extractKbSources(db, options.glossaryVersion, ids)
      : [],
  ]);
  return groups.flat();
}

/**
 * The units that still need work: never translated, or translated from text that has since moved.
 *
 * One indexed read of the existing hashes, then a set difference in memory — no per-unit query,
 * and no AI call for anything unchanged.
 */
export async function pendingUnits(
  db: PrismaClient,
  locale: string,
  units: TranslationUnit[],
): Promise<TranslationUnit[]> {
  const existing = await db.translation.findMany({
    where: { locale },
    select: { entity: true, entityId: true, sourceHash: true, status: true },
  });
  const byKey = new Map(
    existing.map((row) => [`${row.entity}:${row.entityId}`, row]),
  );

  return units.filter((candidate) => {
    const current = byKey.get(`${candidate.entity}:${candidate.entityId}`);
    if (!current) return true;
    // A rejected translation is re-attempted; the rejection note goes into the prompt as a lesson.
    if (current.status === "REJECTED") return true;
    return current.sourceHash !== candidate.sourceHash;
  });
}

/**
 * Delete translations whose source no longer exists.
 *
 * Renaming a message key or removing a question leaves its translations behind: invisible to
 * coverage (which counts current units), unreviewable (there is nothing to compare against), and
 * permanently stuck in the queue. `home.practice` was exactly this — renamed when the start tiles
 * were relabelled, with its Spanish translation still sitting there.
 *
 * ITEM_VARIANT is skipped deliberately: those are derived from masters and never appear in the
 * extractor's output, so treating absence as orphanhood would delete every one of them.
 */
export async function pruneOrphans(
  db: PrismaClient,
  locale: string,
  currentUnits: Array<{ entity: TranslatableEntity; entityId: string }>,
): Promise<number> {
  const live = new Set(
    currentUnits.map((unit) => `${unit.entity}:${unit.entityId}`),
  );
  const existing = await db.translation.findMany({
    where: { locale, entity: { not: "ITEM_VARIANT" } },
    select: { id: true, entity: true, entityId: true },
  });

  const orphans = existing
    .filter((row) => !live.has(`${row.entity}:${row.entityId}`))
    .map((row) => row.id);
  if (orphans.length === 0) return 0;

  const result = await db.translation.deleteMany({
    where: { id: { in: orphans } },
  });
  return result.count;
}
