import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { parseCsvRecords, toCsv } from "@/lib/csv";
import { ValidationError } from "@/lib/errors";
import { AUDIT, auditLog } from "@/server/audit";
import type { SessionUser } from "@/server/authz";
import {
  importResultSchema,
  itemExportSchema,
  upsertItemInputSchema,
  type ImportResult,
  type ItemExport,
} from "@/server/contracts/question-bank";
import { upsertItem } from "./items";
import { invalidateAccuracyStats } from "./stats";

/**
 * Interchange (spec-04). JSON is the lossless format; CSV is the one a content team can edit in
 * a spreadsheet. Both derive from `itemExportSchema`, so a CSV round-trip cannot silently drop
 * a locale or a citation — the tests assert equality, not "looks similar".
 *
 * Options are encoded as `key:text` joined by `|`; citations as `sourceCode §ref` joined by `|`.
 */

const CSV_HEADERS = [
  "topicSlug",
  "type",
  "status",
  "difficulty",
  "licenseClassCode",
  "correctOptionKey",
  "en_stem",
  "en_options",
  "en_explanation",
  "nb_stem",
  "nb_options",
  "nb_explanation",
  "citations",
] as const;

const OPTION_SEP = "|";
const KEY_SEP = ":";

function encodeOptions(options: { key: string; text: string }[]): string {
  return options
    .map((option) => `${option.key}${KEY_SEP}${option.text}`)
    .join(OPTION_SEP);
}

function decodeOptions(encoded: string): { key: string; text: string }[] {
  return encoded
    .split(OPTION_SEP)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf(KEY_SEP);
      if (index < 1) {
        throw new ValidationError(
          { part },
          "admin.questions.errors.optionFormat",
        );
      }
      return {
        key: part.slice(0, index).trim(),
        text: part.slice(index + 1).trim(),
      };
    });
}

function encodeCitations(citations: ItemExport["legalCitations"]): string {
  return citations.map((c) => `${c.sourceCode} ${c.ref}`).join(OPTION_SEP);
}

function decodeCitations(encoded: string): ItemExport["legalCitations"] {
  return encoded
    .split(OPTION_SEP)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [sourceCode, ...ref] = part.split(/\s+/);
      return { sourceCode, ref: ref.join(" ") || "—" };
    });
}

export async function exportItems(
  db: PrismaClient,
  filter: { topicSlug?: string; status?: string } = {},
): Promise<ItemExport[]> {
  const rows = await db.masterItem.findMany({
    where: {
      deletedAt: null,
      ...(filter.status ? { status: filter.status as never } : {}),
      ...(filter.topicSlug ? { topic: { slug: filter.topicSlug } } : {}),
    },
    select: {
      type: true,
      status: true,
      difficulty: true,
      content: true,
      correctOptionKey: true,
      legalCitations: true,
      topic: { select: { slug: true } },
      licenseClass: { select: { code: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  return rows.map((row) =>
    itemExportSchema.parse({
      topicSlug: row.topic.slug,
      type: row.type,
      status: row.status,
      difficulty: row.difficulty,
      licenseClassCode: row.licenseClass?.code ?? null,
      correctOptionKey: row.correctOptionKey ?? "",
      content: row.content,
      legalCitations: row.legalCitations ?? [],
    }),
  );
}

export function itemsToCsv(items: ItemExport[]): string {
  return toCsv(
    items.map((item) => ({
      topicSlug: item.topicSlug,
      type: item.type,
      status: item.status,
      difficulty: item.difficulty,
      licenseClassCode: item.licenseClassCode ?? "",
      correctOptionKey: item.correctOptionKey,
      en_stem: item.content.en.stem,
      en_options: encodeOptions(item.content.en.options),
      en_explanation: item.content.en.explanation,
      nb_stem: item.content.nb.stem,
      nb_options: encodeOptions(item.content.nb.options),
      nb_explanation: item.content.nb.explanation,
      citations: encodeCitations(item.legalCitations),
    })),
    [...CSV_HEADERS],
  );
}

/** CSV → the same shape `exportItems` produces, so a round-trip is comparable field by field. */
export function csvToItems(csv: string): ItemExport[] {
  return parseCsvRecords(csv).map((record) =>
    itemExportSchema.parse({
      topicSlug: record.topicslug,
      type: record.type,
      status: record.status || "DRAFT",
      difficulty: Number(record.difficulty || 3),
      licenseClassCode: record.licenseclasscode || null,
      correctOptionKey: record.correctoptionkey,
      content: {
        en: {
          stem: record.en_stem ?? record.enstem,
          options: decodeOptions(record.en_options ?? record.enoptions ?? ""),
          explanation: record.en_explanation ?? record.enexplanation ?? "",
        },
        nb: {
          stem: record.nb_stem ?? record.nbstem,
          options: decodeOptions(record.nb_options ?? record.nboptions ?? ""),
          explanation: record.nb_explanation ?? record.nbexplanation ?? "",
        },
      },
      legalCitations: decodeCitations(record.citations ?? ""),
    }),
  );
}

const importInputSchema = z.union([
  z.object({ format: z.literal("json"), payload: z.string().min(1) }).strict(),
  z.object({ format: z.literal("csv"), payload: z.string().min(1) }).strict(),
]);

/**
 * Imports items as DRAFTs — never straight to APPROVED. Import is a bulk authoring tool, not a
 * way around review.
 */
export async function importItems(
  db: PrismaClient,
  actor: SessionUser,
  rawInput: unknown,
  options: { batchId?: string } = {},
): Promise<ImportResult> {
  const input = importInputSchema.parse(rawInput);

  let parsed: ItemExport[];
  try {
    parsed =
      input.format === "csv"
        ? csvToItems(input.payload)
        : z.array(itemExportSchema).parse(JSON.parse(input.payload));
  } catch (error) {
    throw new ValidationError(
      { reason: String(error).slice(0, 300) },
      "admin.questions.errors.importUnreadable",
    );
  }

  const topics = await db.topic.findMany({
    where: { deletedAt: null },
    select: { id: true, slug: true },
  });
  const topicBySlug = new Map(topics.map((topic) => [topic.slug, topic.id]));
  const licenseClasses = await db.licenseClass.findMany({
    select: { id: true, code: true },
  });
  const classByCode = new Map(licenseClasses.map((row) => [row.code, row.id]));

  const rows: ImportResult["rows"] = [];
  let imported = 0;

  for (const [index, item] of parsed.entries()) {
    const rowNumber = index + 1;
    const stem = item.content.en.stem || item.content.nb.stem;
    const topicId = topicBySlug.get(item.topicSlug);

    if (!topicId) {
      rows.push({
        row: rowNumber,
        stem,
        status: "invalid",
        messageKey: "admin.questions.rows.unknownTopic",
      });
      continue;
    }

    try {
      await upsertItem(
        db,
        actor,
        upsertItemInputSchema.parse({
          type: item.type,
          topicId,
          licenseClassId: item.licenseClassCode
            ? (classByCode.get(item.licenseClassCode) ?? null)
            : null,
          difficulty: item.difficulty,
          content: item.content,
          correctOptionKey: item.correctOptionKey,
          legalCitations: item.legalCitations,
        }),
        { batchId: options.batchId },
      );
      imported++;
      rows.push({
        row: rowNumber,
        stem,
        status: "imported",
        messageKey: "admin.questions.rows.imported",
      });
    } catch (error) {
      rows.push({
        row: rowNumber,
        stem,
        status: "invalid",
        messageKey:
          error instanceof ValidationError
            ? error.messageKey
            : "admin.questions.rows.invalid",
      });
    }
  }

  await invalidateAccuracyStats();
  await auditLog({
    actorId: actor.id,
    action: AUDIT.itemsImported,
    entityType: "MasterItem",
    meta: { imported, total: parsed.length, format: input.format },
  });

  return importResultSchema.parse({
    imported,
    skipped: rows.length - imported,
    rows,
  });
}
