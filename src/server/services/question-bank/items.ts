import {
  Prisma,
  type PrismaClient,
  type RejectionReason,
} from "@prisma/client";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { AUDIT, auditLog } from "@/server/audit";
import type { SessionUser } from "@/server/authz";
import { paginatedSchema } from "@/server/contracts/common";
import {
  itemListRowSchema,
  listItemsInputSchema,
  upsertItemInputSchema,
} from "@/server/contracts/question-bank";
import { unpublishItem } from "./publish";
import { invalidateAccuracyStats } from "./stats";
import { transitionItem } from "./transitions";

/**
 * Question CRUD (spec-04). Status changes are NOT here — they belong to `transitionItem`,
 * the single lifecycle chokepoint.
 *
 * Editing an APPROVED item bumps `version`, deactivates the variants published from the old
 * version and republishes from the new one: a corrected answer must not keep being served.
 * Attempts already in flight are unaffected — they reference their variant row directly, so
 * they keep rendering exactly what the student was shown.
 */

const listRowsSchema = paginatedSchema(itemListRowSchema);

export async function listItems(
  db: PrismaClient,
  rawInput: unknown,
  viewerId?: string,
) {
  const input = listItemsInputSchema.parse(rawInput);
  const conditions: Prisma.Sql[] = [Prisma.sql`m."deletedAt" IS NULL`];

  if (input.awaitingMyReview && viewerId) {
    // Exactly what this reviewer can still move: in review, not already signed off by them, and
    // not their own human-authored question (nobody vouches for their own work).
    conditions.push(Prisma.sql`m."status" = 'IN_REVIEW'::"ItemStatus"`);
    conditions.push(
      Prisma.sql`NOT EXISTS (
        SELECT 1 FROM "ItemApproval" a
         WHERE a."masterItemId" = m."id"
           AND a."approverId" = ${viewerId}
           AND a."itemVersion" = m."version"
      )`,
    );
    conditions.push(
      Prisma.sql`(m."createdById" IS DISTINCT FROM ${viewerId} OR m."createdBy" = 'AI'::"Provenance")`,
    );
  }

  // Cast the PARAMETER, never the column: `m."status"::text = $1` is unindexable and turns the
  // table into a seq scan (measured — it is how the sort index was found to be doing nothing).
  if (input.status) {
    conditions.push(Prisma.sql`m."status" = ${input.status}::"ItemStatus"`);
  }
  if (input.type)
    conditions.push(Prisma.sql`m."type" = ${input.type}::"ItemType"`);
  if (input.difficulty)
    conditions.push(Prisma.sql`m."difficulty" = ${input.difficulty}`);
  if (input.topicSlug) {
    // Match the whole subtree, not just the topic itself: questions are tagged to the specific
    // subtopic they test ("roundabouts"), while a filter is normally reached for by its parent
    // ("right of way"). Matching the slug alone returned an empty table for every root topic.
    conditions.push(
      Prisma.sql`m."topicId" IN (
        WITH RECURSIVE subtree AS (
          SELECT "id" FROM "Topic" WHERE "slug" = ${input.topicSlug} AND "deletedAt" IS NULL
          UNION ALL
          SELECT c."id" FROM "Topic" c JOIN subtree s ON c."parentId" = s."id"
           WHERE c."deletedAt" IS NULL
        )
        SELECT "id" FROM subtree
      )`,
    );
  }
  if (input.search) {
    // GIN index MasterItem_searchText_idx over the generated tsvector (both locales' stems).
    conditions.push(
      Prisma.sql`m."searchText" @@ plainto_tsquery('simple', ${input.search})`,
    );
  }
  if (input.languageIncomplete) {
    conditions.push(
      Prisma.sql`(coalesce(m."content"->'nb'->>'stem', '') = '' OR coalesce(m."content"->'en'->>'stem', '') = '')`,
    );
  }

  const where = Prisma.join(conditions, " AND ");
  const offset = (input.page - 1) * input.pageSize;

  const [rows, counted] = await Promise.all([
    db.$queryRaw<
      Array<{
        id: string;
        type: string;
        status: string;
        topicId: string;
        difficulty: number;
        version: number;
        createdBy: string;
        stemPreview: string | null;
        updatedAt: Date;
      }>
    >(Prisma.sql`
      SELECT m."id", m."type"::text, m."status"::text, m."topicId", m."difficulty",
             m."version", m."createdBy"::text,
             coalesce(m."content"->'en'->>'stem', m."content"->'nb'->>'stem') AS "stemPreview",
             m."updatedAt"
        FROM "MasterItem" m
        JOIN "Topic" t ON t."id" = m."topicId"
       WHERE ${where}
       ORDER BY m."updatedAt" DESC
       LIMIT ${input.pageSize} OFFSET ${offset}
    `),
    db.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
      SELECT count(*)::bigint AS count
        FROM "MasterItem" m
        JOIN "Topic" t ON t."id" = m."topicId"
       WHERE ${where}
    `),
  ]);

  return listRowsSchema.parse({
    items: rows.map((row) => ({
      ...row,
      stemPreview: (row.stemPreview ?? "").slice(0, 160),
    })),
    page: input.page,
    pageSize: input.pageSize,
    totalCount: Number(counted[0]?.count ?? 0),
  });
}

export async function getItem(db: PrismaClient, id: string) {
  const item = await db.masterItem.findFirst({
    where: { id, deletedAt: null },
    select: {
      id: true,
      type: true,
      status: true,
      topicId: true,
      licenseClassId: true,
      difficulty: true,
      content: true,
      correctOptionKey: true,
      legalCitations: true,
      version: true,
      createdBy: true,
      modelVersion: true,
      promptVersion: true,
      sourceImageId: true,
      batchId: true,
      reviewNote: true,
      reviewReason: true,
      updatedAt: true,
    },
  });
  if (!item) throw new NotFoundError({ itemId: id });
  return item;
}

export async function upsertItem(
  db: PrismaClient,
  actor: SessionUser,
  rawInput: unknown,
  options: { batchId?: string; facts?: Record<string, string> } = {},
) {
  const input = upsertItemInputSchema.parse(rawInput);

  const topic = await db.topic.findFirst({
    where: { id: input.topicId, deletedAt: null },
    select: { id: true },
  });
  if (!topic) throw new NotFoundError({ topicId: input.topicId });

  if (!input.id) {
    const created = await db.masterItem.create({
      data: {
        type: input.type,
        status: "DRAFT",
        topicId: input.topicId,
        licenseClassId: input.licenseClassId,
        difficulty: input.difficulty,
        content: input.content as unknown as Prisma.InputJsonValue,
        correctOptionKey: input.correctOptionKey,
        legalCitations:
          input.legalCitations as unknown as Prisma.InputJsonValue,
        sourceImageId: input.sourceImageId ?? null,
        batchId: options.batchId ?? null,
        createdBy: "HUMAN",
        createdById: actor.id,
      },
      select: { id: true, version: true },
    });
    await auditLog({
      actorId: actor.id,
      action: AUDIT.itemUpserted,
      entityType: "MasterItem",
      entityId: created.id,
      meta: { created: true, topicId: input.topicId },
    });
    return created;
  }

  const existing = await db.masterItem.findFirst({
    where: { id: input.id, deletedAt: null },
    select: {
      id: true,
      status: true,
      version: true,
      content: true,
      correctOptionKey: true,
    },
  });
  if (!existing) throw new NotFoundError({ itemId: input.id });
  if (existing.status === "RETIRED") {
    throw new ConflictError(
      { itemId: input.id },
      "admin.questions.errors.retiredNotEditable",
    );
  }
  if (existing.status === "APPROVED") {
    // Frozen (spec-04b): a result must stay explainable by pointing at a question whose text
    // never changed. Corrections go through `replaceItem` — retire this one, approve a new one.
    throw new ConflictError(
      { itemId: input.id },
      "admin.questions.errors.approvedIsFrozen",
    );
  }

  // Editing a draft bumps the version so any approval collected for the old text is void
  // (ItemApproval is keyed by version — a reviewer only ever vouches for what they read).
  const updated = await db.masterItem.update({
    where: { id: existing.id },
    data: {
      type: input.type,
      topicId: input.topicId,
      licenseClassId: input.licenseClassId,
      difficulty: input.difficulty,
      content: input.content as unknown as Prisma.InputJsonValue,
      correctOptionKey: input.correctOptionKey,
      legalCitations: input.legalCitations as unknown as Prisma.InputJsonValue,
      sourceImageId: input.sourceImageId ?? null,
      version: existing.version + 1,
    },
    select: { id: true, version: true },
  });

  await invalidateAccuracyStats();
  await auditLog({
    actorId: actor.id,
    action: AUDIT.itemUpserted,
    entityType: "MasterItem",
    entityId: existing.id,
    // Previous content snapshot: the rollback record the brief's "no version table" leaves out.
    meta: {
      created: false,
      versionFrom: existing.version,
      versionTo: updated.version,
      previousContent: existing.content as Prisma.InputJsonValue,
      previousCorrectOptionKey: existing.correctOptionKey,
    },
  });
  return updated;
}

/** Soft delete — ADMIN only, and never for an item that has been served. */
export async function deleteItem(
  db: PrismaClient,
  actor: SessionUser,
  id: string,
): Promise<void> {
  const served = await db.examAttemptQuestion.count({
    where: { variant: { masterItemId: id } },
  });
  if (served > 0) {
    throw new ConflictError(
      { itemId: id, served },
      "admin.questions.errors.servedNotDeletable",
    );
  }
  await db.$transaction(async (tx) => {
    await unpublishItem(tx, id);
    // Status is left alone: `deletedAt` already excludes the row from every read path, and
    // rewriting it to RETIRED would trip the answer-key constraint on an incomplete draft.
    await tx.masterItem.updateMany({
      where: { id, deletedAt: null },
      data: { deletedAt: new Date() },
    });
  });
  await invalidateAccuracyStats();
  await auditLog({
    actorId: actor.id,
    action: AUDIT.itemTransitioned,
    entityType: "MasterItem",
    entityId: id,
    meta: { deleted: true },
  });
}

/**
 * Retire-and-replace (spec-04b): the only way to correct an approved question.
 *
 * The approved question is retired with a reason and a NEW draft is created carrying the fix,
 * linked back to what it supersedes. Every exam already sat keeps pointing at the original text,
 * which is exactly what makes a disputed mark answerable: this is the question that was asked.
 */
export async function replaceItem(
  db: PrismaClient,
  actor: SessionUser,
  originalId: string,
  rawInput: unknown,
  reason: RejectionReason = "OTHER",
): Promise<{ id: string; replacesId: string }> {
  const input = upsertItemInputSchema.parse(rawInput);
  const original = await db.masterItem.findFirst({
    where: { id: originalId, deletedAt: null },
    select: { id: true, status: true, batchId: true },
  });
  if (!original) throw new NotFoundError({ itemId: originalId });
  if (original.status !== "APPROVED") {
    throw new ConflictError(
      { itemId: originalId, status: original.status },
      "admin.questions.errors.onlyApprovedReplaceable",
    );
  }

  const replacement = await db.masterItem.create({
    data: {
      type: input.type,
      status: "DRAFT",
      topicId: input.topicId,
      licenseClassId: input.licenseClassId,
      difficulty: input.difficulty,
      content: input.content as unknown as Prisma.InputJsonValue,
      correctOptionKey: input.correctOptionKey,
      legalCitations: input.legalCitations as unknown as Prisma.InputJsonValue,
      sourceImageId: input.sourceImageId ?? null,
      batchId: original.batchId,
      replacesId: original.id,
      createdBy: "HUMAN",
      createdById: actor.id,
    },
    select: { id: true },
  });

  // Retire the original only after the replacement exists, so the pool is never left with a gap
  // that a replacement failure would make permanent.
  await transitionItem(db, actor, { id: original.id, to: "RETIRED", reason });

  await auditLog({
    actorId: actor.id,
    action: AUDIT.itemReplaced,
    entityType: "MasterItem",
    entityId: original.id,
    meta: { replacementId: replacement.id, reason },
  });
  return { id: replacement.id, replacesId: original.id };
}
