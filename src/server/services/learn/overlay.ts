import type { PrismaClient } from "@prisma/client";
import { isBuiltinLocale } from "@/lib/locale";
import { logger } from "@/lib/logger";
import { servableStatuses } from "@/server/services/i18n/resolve";
import {
  hashUnit,
  type LearnBookPayload,
  type LearnDocumentPayload,
  type LearnSectionPayload,
  type TranslationUnit,
} from "@/server/services/i18n/units";
import { joinSections, splitSections } from "./markdown";

/**
 * Learn content as translation units, and translations back as a document (spec-23 C9).
 *
 * A document travels as one LEARN_DOCUMENT unit (title + summary) plus one LEARN_SECTION unit per
 * H2-bounded section, `entityId = "<documentId>:s<n>"`. Only PUBLISHED content is extracted, so a
 * draft costs nothing. On the way back the overlay is all-or-nothing per document, and every
 * unit's `sourceHash` is compared to the current text — a stale section counts as absent, so a
 * student never reads yesterday's Bangla under today's English (the hole DECISIONS 2026-09-21
 * describes in `loadOverlay`, closed here for this entity).
 */
const PUBLISHED = { status: "PUBLISHED" as const, deletedAt: null };

function bilingual(value: unknown): { en?: string; nb?: string } {
  const v = (value ?? {}) as { en?: unknown; nb?: unknown };
  return {
    ...(typeof v.en === "string" && v.en.length > 0 ? { en: v.en } : {}),
    ...(typeof v.nb === "string" && v.nb.length > 0 ? { nb: v.nb } : {}),
  };
}

export function sectionEntityId(documentId: string, index: number): string {
  return `${documentId}:s${index}`;
}

/** The units one document produces from its current text — shared by extraction and resolution. */
export function documentUnits(
  doc: { id: string; title: unknown; summary: unknown; body: unknown },
  glossaryVersion: number,
): TranslationUnit[] {
  const title = bilingual(doc.title);
  const summary = bilingual(doc.summary);
  const body = bilingual(doc.body);
  const units: TranslationUnit[] = [];

  const docEn: LearnDocumentPayload = { title: title.en ?? "", ...(summary.en ? { summary: summary.en } : {}) };
  const docNb: LearnDocumentPayload | undefined = title.nb
    ? { title: title.nb, ...(summary.nb ? { summary: summary.nb } : {}) }
    : undefined;
  units.push({
    entity: "LEARN_DOCUMENT",
    entityId: doc.id,
    en: docEn,
    nb: docNb,
    label: title.en ?? doc.id,
    sourceHash: hashUnit({ entity: "LEARN_DOCUMENT", en: docEn, nb: docNb }, glossaryVersion),
  });

  const sectionsEn = splitSections(body.en ?? "", { locale: "en" });
  const sectionsNb = splitSections(body.nb ?? "", { locale: "nb" });
  // Norwegian rides along only when the two sides have the same skeleton; otherwise the model
  // works from English alone, which is still a correct translation of what a student reads.
  const aligned = sectionsEn.length === sectionsNb.length;
  if (!aligned && sectionsNb.length > 0) {
    logger.warn({ documentId: doc.id, en: sectionsEn.length, nb: sectionsNb.length }, "learn sections not aligned — nb omitted from units");
  }
  sectionsEn.forEach((section, index) => {
    const en: LearnSectionPayload = { text: section.markdown };
    const nb: LearnSectionPayload | undefined = aligned ? { text: sectionsNb[index]!.markdown } : undefined;
    units.push({
      entity: "LEARN_SECTION",
      entityId: sectionEntityId(doc.id, index),
      en,
      nb,
      label: `${title.en ?? doc.id} · §${index + 1}${section.heading ? ` ${section.heading}` : ""}`,
      sourceHash: hashUnit({ entity: "LEARN_SECTION", en, nb }, glossaryVersion),
    });
  });
  return units;
}

export function bookUnit(book: { id: string; title: unknown; description: unknown }, glossaryVersion: number): TranslationUnit {
  const title = bilingual(book.title);
  const description = bilingual(book.description);
  const en: LearnBookPayload = { title: title.en ?? "", ...(description.en ? { description: description.en } : {}) };
  const nb: LearnBookPayload | undefined = title.nb
    ? { title: title.nb, ...(description.nb ? { description: description.nb } : {}) }
    : undefined;
  return {
    entity: "LEARN_BOOK",
    entityId: book.id,
    en,
    nb,
    label: title.en ?? book.id,
    sourceHash: hashUnit({ entity: "LEARN_BOOK", en, nb }, glossaryVersion),
  };
}

/** Every Learn unit in the system: published books, published documents, their sections. */
export async function extractLearnUnits(
  db: PrismaClient,
  glossaryVersion: number,
  options: { only?: Array<"LEARN_BOOK" | "LEARN_DOCUMENT" | "LEARN_SECTION">; ids?: string[] } = {},
): Promise<TranslationUnit[]> {
  const wanted = (entity: "LEARN_BOOK" | "LEARN_DOCUMENT" | "LEARN_SECTION") =>
    !options.only || options.only.includes(entity);
  const units: TranslationUnit[] = [];
  // A section id names its document: "<documentId>:s<n>".
  const documentIds = options.ids?.map((id) => id.split(":s")[0]!);

  if (wanted("LEARN_BOOK")) {
    // Index: LearnBook_status_sortOrder_idx.
    const books = await db.learnBook.findMany({
      where: { ...PUBLISHED, ...(options.ids ? { id: { in: options.ids } } : {}) },
      select: { id: true, title: true, description: true },
    });
    units.push(...books.map((book) => bookUnit(book, glossaryVersion)));
  }
  if (wanted("LEARN_DOCUMENT") || wanted("LEARN_SECTION")) {
    // Index: LearnDocument_kind_status_publishedAt_idx (status leg).
    const docs = await db.learnDocument.findMany({
      where: {
        ...PUBLISHED,
        ...(documentIds ? { id: { in: [...new Set(documentIds)] } } : {}),
        OR: [{ kind: "ARTICLE" }, { book: { status: "PUBLISHED", deletedAt: null } }],
      },
      select: { id: true, title: true, summary: true, body: true },
    });
    for (const doc of docs) {
      for (const unit of documentUnits(doc, glossaryVersion)) {
        if (unit.entity === "LEARN_DOCUMENT" && !wanted("LEARN_DOCUMENT")) continue;
        if (unit.entity === "LEARN_SECTION" && !wanted("LEARN_SECTION")) continue;
        if (options.ids && !options.ids.includes(unit.entityId)) continue;
        units.push(unit);
      }
    }
  }
  return units;
}

export interface LearnDocOverlay {
  title: string;
  summary: string | null;
  body: string;
}

/**
 * The translated document, or null when any of its units is missing, unservable or stale.
 *
 * One indexed read per call (unique [locale, entity, entityId]) for all documents asked for.
 */
export async function loadLearnDocumentOverlay(
  db: PrismaClient,
  locale: string,
  docs: Array<{ id: string; title: unknown; summary: unknown; body: unknown }>,
): Promise<Map<string, LearnDocOverlay>> {
  const out = new Map<string, LearnDocOverlay>();
  if (isBuiltinLocale(locale) || docs.length === 0) return out;
  try {
    const language = await db.language.findUnique({
      where: { code: locale },
      select: { requiresApproval: true, glossaryVersion: true },
    });
    if (!language) return out;
    const expected = new Map<string, { unit: TranslationUnit; docId: string }>();
    const perDoc = new Map<string, TranslationUnit[]>();
    for (const doc of docs) {
      const units = documentUnits(doc, language.glossaryVersion);
      perDoc.set(doc.id, units);
      for (const unit of units) expected.set(`${unit.entity}:${unit.entityId}`, { unit, docId: doc.id });
    }
    const rows = await db.translation.findMany({
      where: {
        locale,
        entity: { in: ["LEARN_DOCUMENT", "LEARN_SECTION"] },
        entityId: { in: [...expected.values()].map((e) => e.unit.entityId) },
        status: { in: servableStatuses(language.requiresApproval) },
      },
      select: { entity: true, entityId: true, sourceHash: true, value: true },
    });
    const fresh = new Map(
      rows
        .filter((row) => expected.get(`${row.entity}:${row.entityId}`)?.unit.sourceHash === row.sourceHash)
        .map((row) => [`${row.entity}:${row.entityId}`, row.value as unknown as LearnDocumentPayload & LearnSectionPayload]),
    );
    for (const [docId, units] of perDoc) {
      if (!units.every((unit) => fresh.has(`${unit.entity}:${unit.entityId}`))) continue;
      const head = fresh.get(`LEARN_DOCUMENT:${docId}`)!;
      const sections = units
        .filter((unit) => unit.entity === "LEARN_SECTION")
        .map((unit) => ({ markdown: fresh.get(`LEARN_SECTION:${unit.entityId}`)!.text }));
      out.set(docId, { title: head.title, summary: head.summary ?? null, body: joinSections(sections) });
    }
  } catch (error) {
    logger.error({ error, locale }, "learn overlay unreadable — serving the source");
  }
  return out;
}

/** Book titles and descriptions for one locale, hash-checked the same way. */
export async function loadLearnBookOverlay(
  db: PrismaClient,
  locale: string,
  books: Array<{ id: string; title: unknown; description: unknown }>,
): Promise<Map<string, { title: string; description: string | null }>> {
  const out = new Map<string, { title: string; description: string | null }>();
  if (isBuiltinLocale(locale) || books.length === 0) return out;
  try {
    const language = await db.language.findUnique({
      where: { code: locale },
      select: { requiresApproval: true, glossaryVersion: true },
    });
    if (!language) return out;
    const expected = new Map(books.map((book) => [book.id, bookUnit(book, language.glossaryVersion).sourceHash]));
    const rows = await db.translation.findMany({
      where: {
        locale,
        entity: "LEARN_BOOK",
        entityId: { in: books.map((b) => b.id) },
        status: { in: servableStatuses(language.requiresApproval) },
      },
      select: { entityId: true, sourceHash: true, value: true },
    });
    for (const row of rows) {
      if (expected.get(row.entityId) !== row.sourceHash) continue;
      const value = row.value as unknown as LearnBookPayload;
      out.set(row.entityId, { title: value.title, description: value.description ?? null });
    }
  } catch (error) {
    logger.error({ error, locale }, "learn book overlay unreadable — serving the source");
  }
  return out;
}
