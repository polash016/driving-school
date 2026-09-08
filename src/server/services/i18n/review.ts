import type {
  PrismaClient,
  TranslatableEntity,
  TranslationStatus,
} from "@prisma/client";
import { z } from "zod";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { AUDIT, auditLog } from "@/server/audit";
import type { SessionUser } from "@/server/authz";
import { invalidateMessages } from "./catalogue";
import { extractAll } from "./extract";
import { rememberTranslation } from "./memory";
import { deriveVariantTranslations } from "./runs";
import type { UnitPayload } from "./units";
import { checkTranslation, NOT_A_QUALITY_FLAG } from "./validation";

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
    /**
     * Exactly which statuses to list, overriding `onlyFlagged`. The readiness checklist uses it to
     * open the queue on precisely the rows one blocker counted — `REJECTED` included, which the
     * default view deliberately leaves out.
     */
    status?: TranslationStatus[];
  } = {},
): Promise<ReviewQueueItem[]> {
  // Index: Translation[locale, entity, status].
  const rows = await db.translation.findMany({
    where: {
      locale,
      ...(options.entity ? { entity: options.entity } : {}),
      status: options.status
        ? { in: options.status }
        : options.onlyFlagged
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

  const items = await Promise.all(
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

  // A translation whose source has since been deleted cannot be judged — there is nothing to
  // compare it against. `pruneOrphans` clears these out on the next sync; hiding them here means
  // a reviewer never meets an empty comparison panel in the meantime.
  return items.filter((item) => item.source !== null);
}

/**
 * How many rows each QA code is currently holding back, worst first.
 *
 * The number is the point: "405 held by a check that could not run" and "3 held because the
 * options may have swapped meaning" are different problems, and a reviewer cannot consent to
 * clearing the first without being shown that the second exists.
 *
 * Tallied in JS rather than with a raw `unnest` — these are a few thousand rows of short string
 * arrays, and keeping it in Prisma keeps the whole path typed.
 *
 * Index: Translation[locale, status, createdAt] — locale and status are the leading columns.
 */
export async function flagCounts(
  db: PrismaClient,
  locale: string,
): Promise<Array<{ code: string; count: number; quality: boolean }>> {
  const rows = await db.translation.findMany({
    where: {
      locale,
      status: { in: ["MACHINE", "NEEDS_REVIEW"] },
      entity: { not: "ITEM_VARIANT" },
    },
    select: { qaFlags: true },
  });

  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const flag of row.qaFlags) {
      counts.set(flag, (counts.get(flag) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([code, count]) => ({
      code,
      count,
      quality: !NOT_A_QUALITY_FLAG.has(code),
    }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

/**
 * The kinds of unit a reviewer can narrow a bulk approve to.
 *
 * Exactly what `extractAll` emits, and deliberately NOT the whole `TranslatableEntity` enum:
 * `ITEM_VARIANT` is derived from its master and has no source of its own to compare against, so
 * naming one here could only approve a row nobody ever read. A free-form string would have let a
 * crafted POST do precisely that.
 */
export const bulkApproveEntitySchema = z.enum([
  "UI_MESSAGE",
  "MASTER_ITEM",
  "TOPIC",
  "LICENSE_CLASS",
  "SIGN",
  "KB_SOURCE",
]);

export const bulkApproveInputSchema = z
  .object({
    locale: z.string().min(2),
    entity: bulkApproveEntitySchema.optional(),
    /**
     * Flag codes the reviewer has explicitly consented to. A row is approved only when EVERY one
     * of its flags appears here, so consenting to an infrastructure code can never sweep up a
     * quality finding that happens to sit on the same row.
     */
    allowFlags: z.array(z.string()).max(32).default([]),
  })
  .strict();

/**
 * Approve machine translations at once, scoped to the flags the reviewer consented to.
 *
 * Necessary rather than convenient: a language has 534 UI strings, and approving those one at a
 * time is not a workflow anybody completes. It is still a human act, recorded as one — a reviewer
 * saying "the automated checks are good enough for the boilerplate".
 *
 * The scope is what keeps it honest. `allowFlags: []` — the default, and what every existing
 * caller gets — approves only rows nothing flagged at all. Passing `QA_UNAVAILABLE` says "the
 * semantic check could not run, and that was never a statement about the translation"; it does
 * NOT say anything about a `NUMBER_DRIFT` sitting on the same row, which is why approval is
 * decided per ROW over ALL of its flags rather than per flag.
 *
 * Staleness is the other half of that honesty, and it only became reachable here. Until bulk
 * approve could touch a flagged row, anything flagged reached APPROVED through `reviewQueue`,
 * which renders the current English beside it — so a human saw the drift. A sweep does not, which
 * is why the candidate set is intersected with the live source hashes.
 */
export async function bulkApproveTranslations(
  db: PrismaClient,
  actor: SessionUser,
  rawInput: unknown,
): Promise<{ approved: number; skipped: number }> {
  const input = bulkApproveInputSchema.parse(rawInput);
  const allowed = new Set(input.allowFlags);
  const language = await db.language.findUniqueOrThrow({
    where: { code: input.locale },
    select: { glossaryVersion: true },
  });

  const [candidates, units] = await Promise.all([
    // Index: Translation[locale, status, createdAt].
    db.translation.findMany({
      where: {
        locale: input.locale,
        status: { in: ["MACHINE", "NEEDS_REVIEW"] },
        entity: input.entity ?? ({ not: "ITEM_VARIANT" } as const),
      },
      select: {
        id: true,
        entity: true,
        entityId: true,
        status: true,
        qaFlags: true,
        sourceHash: true,
      },
    }),
    extractAll(db, { glossaryVersion: language.glossaryVersion }),
  ]);

  // Never approve a row whose source has moved: coverage counts it untranslated, but the resolver
  // serves on status alone, so an approved stale row reaches students against English it was not
  // translated from.
  const fresh = new Set(
    units.map((unit) => `${unit.entity}:${unit.entityId}:${unit.sourceHash}`),
  );

  const targets = candidates.filter(
    (row) =>
      fresh.has(`${row.entity}:${row.entityId}:${row.sourceHash}`) &&
      // `[].every()` is vacuously true, which is exactly right for a MACHINE row: nothing flagged
      // it, so every consent set approves it. A NEEDS_REVIEW row with no flags is a writer bug
      // rather than a clean row, and must never be swept up on a technicality.
      (row.qaFlags.length > 0 || row.status === "MACHINE") &&
      row.qaFlags.every((flag) => allowed.has(flag)),
  );
  const skipped = candidates.length - targets.length;

  if (targets.length === 0) return { approved: 0, skipped };

  const result = await db.translation.updateMany({
    where: { id: { in: targets.map((row) => row.id) } },
    data: {
      status: "APPROVED",
      reviewedById: actor.id,
      reviewedAt: new Date(),
    },
  });

  // Push approved questions out to the variants students are actually served.
  const masterIds = targets
    .filter((row) => row.entity === "MASTER_ITEM")
    .map((row) => row.entityId);
  if (masterIds.length > 0)
    await deriveVariantTranslations(db, input.locale, masterIds);
  if (targets.some((row) => row.entity === "UI_MESSAGE")) {
    await invalidateMessages(input.locale);
  }

  await auditLog({
    actorId: actor.id,
    action: AUDIT.translationApproved,
    entityType: "Language",
    entityId: input.locale,
    // `allowFlags` is the consent itself: what a reviewer waved through, and on what grounds, has
    // to survive in the record rather than only in the count.
    meta: {
      bulk: true,
      approved: result.count,
      skipped,
      allowFlags: input.allowFlags,
    },
  });
  return { approved: result.count, skipped };
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
