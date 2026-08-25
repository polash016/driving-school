import type { PrismaClient, TranslatableEntity } from "@prisma/client";
import { z } from "zod";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { AUDIT, auditLog } from "@/server/audit";
import type { SessionUser } from "@/server/authz";
import { invalidateMessages } from "./catalogue";
import { rememberTranslation } from "./memory";
import { deriveVariantTranslations } from "./runs";
import type { UnitPayload } from "./units";
import { checkTranslation } from "./validation";

/**
 * Human review of translations (spec-15).
 *
 * A reviewer here is someone who reads the language — often an instructor rather than an admin,
 * which is why INSTRUCTOR is the floor. They see the source beside the translation and the QA
 * report, and can approve, refuse, or correct.
 *
 * A correction is worth more than an approval: it is written back into translation memory, so the
 * reviewer's wording is reused everywhere that source text appears rather than being corrected
 * once and re-generated wrongly next time.
 */

export const reviewInputSchema = z
  .object({
    id: z.string().min(1),
    action: z.enum(["APPROVE", "REJECT"]),
    note: z.string().max(1000).optional(),
  })
  .strict();

export const editTranslationInputSchema = z
  .object({
    id: z.string().min(1),
    value: z.record(z.string(), z.unknown()),
    note: z.string().max(1000).optional(),
  })
  .strict();

export interface ReviewQueueItem {
  id: string;
  entity: TranslatableEntity;
  entityId: string;
  status: string;
  value: UnitPayload;
  source: UnitPayload | null;
  qaFlags: string[];
  semanticScore: number | null;
  qaReport: unknown;
  label: string;
}

/**
 * What is waiting for a reviewer, worst first.
 *
 * Ordered by QA flags then by drift score, because a queue is only useful if the thing most likely
 * to be wrong is at the top of it.
 */
export async function reviewQueue(
  db: PrismaClient,
  locale: string,
  options: {
    entity?: TranslatableEntity;
    limit?: number;
    onlyFlagged?: boolean;
  } = {},
): Promise<ReviewQueueItem[]> {
  const rows = await db.translation.findMany({
    where: {
      locale,
      ...(options.entity ? { entity: options.entity } : {}),
      status: options.onlyFlagged
        ? "NEEDS_REVIEW"
        : { in: ["MACHINE", "NEEDS_REVIEW"] },
    },
    orderBy: [{ semanticScore: "asc" }, { createdAt: "asc" }],
    take: options.limit ?? 50,
    select: {
      id: true,
      entity: true,
      entityId: true,
      status: true,
      value: true,
      qaFlags: true,
      semanticScore: true,
      qaReport: true,
    },
  });

  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      entity: row.entity,
      entityId: row.entityId,
      status: row.status,
      value: row.value as unknown as UnitPayload,
      source: await sourceFor(db, row.entity, row.entityId),
      qaFlags: row.qaFlags,
      semanticScore: row.semanticScore,
      qaReport: row.qaReport,
      label: labelOf(row.value as unknown as UnitPayload, row.entityId),
    })),
  );
}

function labelOf(value: UnitPayload, fallback: string): string {
  const shape = value as { stem?: string; name?: string; text?: string };
  return (shape.stem ?? shape.name ?? shape.text ?? fallback).slice(0, 100);
}

/** The authored English a reviewer compares against. */
export async function sourceFor(
  db: PrismaClient,
  entity: TranslatableEntity,
  entityId: string,
): Promise<UnitPayload | null> {
  switch (entity) {
    case "MASTER_ITEM": {
      const item = await db.masterItem.findUnique({
        where: { id: entityId },
        select: { content: true },
      });
      return (
        ((item?.content as { en?: unknown } | null)?.en as UnitPayload) ?? null
      );
    }
    case "ITEM_VARIANT": {
      const variant = await db.itemVariant.findUnique({
        where: { id: entityId },
        select: { content: true },
      });
      return (
        ((variant?.content as { en?: unknown } | null)?.en as UnitPayload) ??
        null
      );
    }
    case "TOPIC": {
      const topic = await db.topic.findUnique({
        where: { id: entityId },
        select: { name: true, description: true },
      });
      if (!topic) return null;
      const name = (topic.name as { en?: string } | null)?.en ?? "";
      const description = (topic.description as { en?: string } | null)?.en;
      return { name, ...(description ? { description } : {}) };
    }
    case "LICENSE_CLASS": {
      const licenseClass = await db.licenseClass.findUnique({
        where: { id: entityId },
        select: { name: true },
      });
      return { name: (licenseClass?.name as { en?: string } | null)?.en ?? "" };
    }
    case "SIGN": {
      const sign = await db.sign.findUnique({
        where: { id: entityId },
        select: { name: true, meaning: true },
      });
      if (!sign) return null;
      return {
        name: (sign.name as { en?: string } | null)?.en ?? "",
        meaning: (sign.meaning as { en?: string } | null)?.en ?? "",
      };
    }
    case "KB_SOURCE": {
      const source = await db.kbSource.findUnique({
        where: { code: entityId },
        select: { name: true },
      });
      return source ? { name: source.name } : null;
    }
    case "UI_MESSAGE": {
      const { BASE_MESSAGES } = await import("@/i18n/builtin");
      const { flattenMessages } = await import("./catalogue");
      const flat = flattenMessages(BASE_MESSAGES as Record<string, unknown>);
      return flat[entityId] ? { text: flat[entityId] } : null;
    }
    default:
      return null;
  }
}

/** Approve or refuse a translation. A refusal's note becomes a lesson in the next prompt. */
export async function reviewTranslation(
  db: PrismaClient,
  actor: SessionUser,
  rawInput: unknown,
) {
  const input = reviewInputSchema.parse(rawInput);
  const row = await db.translation.findUnique({
    where: { id: input.id },
    select: {
      id: true,
      locale: true,
      entity: true,
      entityId: true,
      qaFlags: true,
    },
  });
  if (!row) throw new NotFoundError({ id: input.id });

  const updated = await db.translation.update({
    where: { id: input.id },
    data: {
      status: input.action === "APPROVE" ? "APPROVED" : "REJECTED",
      reviewedById: actor.id,
      reviewedAt: new Date(),
      reviewNote: input.note?.trim() || null,
    },
    select: {
      id: true,
      status: true,
      locale: true,
      entity: true,
      entityId: true,
    },
  });

  // An approved question translation is what the student is actually served, so push it out to
  // the variants immediately rather than waiting for the next sync.
  if (updated.status === "APPROVED" && updated.entity === "MASTER_ITEM") {
    await deriveVariantTranslations(db, updated.locale, [updated.entityId]);
  }
  if (updated.entity === "UI_MESSAGE") await invalidateMessages(updated.locale);

  await auditLog({
    actorId: actor.id,
    action:
      input.action === "APPROVE"
        ? AUDIT.translationApproved
        : AUDIT.translationRejected,
    entityType: "Translation",
    entityId: updated.id,
    meta: {
      locale: updated.locale,
      entity: updated.entity,
      qaFlags: row.qaFlags,
    },
  });
  return updated;
}

/**
 * A reviewer's own wording.
 *
 * Re-checked structurally before it is stored — a human can drop a placeholder or rename an option
 * key just as easily as a model can, and the consequence is identical.
 */
export async function editTranslation(
  db: PrismaClient,
  actor: SessionUser,
  rawInput: unknown,
) {
  const input = editTranslationInputSchema.parse(rawInput);
  const row = await db.translation.findUnique({
    where: { id: input.id },
    select: {
      id: true,
      locale: true,
      entity: true,
      entityId: true,
      sourceHash: true,
    },
  });
  if (!row) throw new NotFoundError({ id: input.id });

  const source = await sourceFor(db, row.entity, row.entityId);
  if (!source) throw new NotFoundError({ entityId: row.entityId });

  const correctOptionKey =
    row.entity === "MASTER_ITEM"
      ? ((
          await db.masterItem.findUnique({
            where: { id: row.entityId },
            select: { correctOptionKey: true },
          })
        )?.correctOptionKey ?? undefined)
      : undefined;

  const check = checkTranslation({
    entity: row.entity,
    locale: row.locale,
    source,
    translated: input.value as unknown as UnitPayload,
    correctOptionKey,
  });
  if (!check.passed) {
    throw new ConflictError(
      { issues: check.issues },
      "admin.languages.errors.editRejected",
    );
  }

  const language = await db.language.findUniqueOrThrow({
    where: { code: row.locale },
    select: { glossaryVersion: true },
  });

  const updated = await db.translation.update({
    where: { id: input.id },
    data: {
      value: input.value as object,
      // A human wrote this, so it is approved by definition and carries no model provenance.
      status: "APPROVED",
      modelVersion: null,
      promptVersion: null,
      fromMemory: false,
      qaFlags: [],
      qaReport: { source: "human", issues: check.issues } as object,
      reviewedById: actor.id,
      reviewedAt: new Date(),
      reviewNote: input.note?.trim() || null,
    },
    select: { id: true, locale: true, entity: true, entityId: true },
  });

  // The correction is remembered, so this wording is reused wherever the same source appears
  // instead of being re-generated wrongly and corrected again.
  await rememberTranslation(db, {
    locale: row.locale,
    entity: row.entity,
    source,
    value: input.value as unknown as UnitPayload,
    glossaryVersion: language.glossaryVersion,
  });

  if (updated.entity === "MASTER_ITEM") {
    await deriveVariantTranslations(db, updated.locale, [updated.entityId]);
  }
  if (updated.entity === "UI_MESSAGE") await invalidateMessages(updated.locale);

  await auditLog({
    actorId: actor.id,
    action: AUDIT.translationEdited,
    entityType: "Translation",
    entityId: updated.id,
    meta: { locale: updated.locale, entity: updated.entity },
  });
  return updated;
}

/**
 * One entity in every language, for the side-by-side screen.
 *
 * The reverse of the serving access pattern — served by `Translation_entity_entityId_idx`.
 */
export async function translationsAcrossLanguages(
  db: PrismaClient,
  entity: TranslatableEntity,
  entityId: string,
) {
  const rows = await db.translation.findMany({
    where: { entity, entityId },
    select: {
      id: true,
      locale: true,
      value: true,
      status: true,
      qaFlags: true,
      semanticScore: true,
      language: {
        select: { nativeName: true, englishName: true, direction: true },
      },
    },
    orderBy: { locale: "asc" },
  });
  return rows.map((row) => ({
    id: row.id,
    locale: row.locale,
    value: row.value as unknown as UnitPayload,
    status: row.status,
    qaFlags: row.qaFlags,
    semanticScore: row.semanticScore,
    nativeName: row.language.nativeName,
    englishName: row.language.englishName,
    direction: row.language.direction,
  }));
}
