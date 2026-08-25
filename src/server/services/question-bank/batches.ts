import type { PrismaClient } from "@prisma/client";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { AUDIT, auditLog } from "@/server/audit";
import type { SessionUser } from "@/server/authz";
import { paginatedSchema } from "@/server/contracts/common";
import {
  attachItemsToBatchInputSchema,
  batchDetailSchema,
  batchSummarySchema,
  createBatchInputSchema,
  detachItemInputSchema,
  listBatchesInputSchema,
  type BatchDetail,
  type BatchSummary,
} from "@/server/contracts/question-bank";

/**
 * Generation SETS (spec-04 amendment) — the unit a reviewer judges AI output in.
 * Created by hand here; created by the pipeline in spec-06, which fills in the provenance
 * columns (`providerId`, `modelVersion`, `promptVersion`).
 */

const listSchema = paginatedSchema(batchSummarySchema);

const ITEM_SELECT = {
  id: true,
  status: true,
  type: true,
  difficulty: true,
  version: true,
  content: true,
  createdBy: true,
  modelVersion: true,
  promptVersion: true,
  reviewReason: true,
  reviewNote: true,
  updatedAt: true,
} as const;

type ItemRow = {
  status: string;
  content: unknown;
};

function countsOf(items: { status: string }[]) {
  return countsFrom(
    items.reduce<Record<string, number>>((acc, item) => {
      acc[item.status] = (acc[item.status] ?? 0) + 1;
      return acc;
    }, {}),
  );
}

function countsFrom(byStatus: Record<string, number>) {
  const at = (status: string) => byStatus[status] ?? 0;
  return {
    total: Object.values(byStatus).reduce((sum, count) => sum + count, 0),
    draft: at("DRAFT"),
    inReview: at("IN_REVIEW"),
    approved: at("APPROVED"),
    retired: at("RETIRED"),
    needsReview: at("NEEDS_REVIEW"),
  };
}

/** approved / (approved + retired) — null until at least one item reached a terminal state. */
function acceptanceRate(counts: { approved: number; retired: number }): number | null {
  const terminal = counts.approved + counts.retired;
  return terminal === 0 ? null : counts.approved / terminal;
}

function stemOf(content: unknown): string {
  const value = content as { en?: { stem?: string }; nb?: { stem?: string } } | null;
  return (value?.en?.stem ?? value?.nb?.stem ?? "").slice(0, 160);
}

export async function createBatch(
  db: PrismaClient,
  actor: SessionUser,
  rawInput: unknown,
): Promise<BatchSummary> {
  const input = createBatchInputSchema.parse(rawInput);
  const batch = await db.generationBatch.create({
    data: {
      kind: input.kind,
      status: "READY", // manual sets hold whatever is attached to them
      topicId: input.topicId ?? null,
      sourceImageId: input.sourceImageId ?? null,
      requestedCount: input.requestedCount,
      notes: input.notes ?? null,
      createdById: actor.id,
    },
    select: {
      id: true,
      kind: true,
      status: true,
      sourceImageId: true,
      topicId: true,
      requestedCount: true,
      modelVersion: true,
      promptVersion: true,
      notes: true,
      createdAt: true,
    },
  });

  await auditLog({
    actorId: actor.id,
    action: AUDIT.batchCreated,
    entityType: "GenerationBatch",
    entityId: batch.id,
    meta: { kind: batch.kind },
  });

  const counts = countsOf([]);
  return batchSummarySchema.parse({
    ...batch,
    counts,
    acceptanceRate: acceptanceRate(counts),
  });
}

/** Set board, newest first — served by GenerationBatch(status, createdAt DESC). */
export async function listBatches(db: PrismaClient, rawInput: unknown = {}) {
  const input = listBatchesInputSchema.parse(rawInput);
  const where = {
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.status ? { status: input.status } : {}),
  };

  const [batches, totalCount] = await Promise.all([
    db.generationBatch.findMany({
      where,
      select: {
        id: true,
        kind: true,
        status: true,
        sourceImageId: true,
        topicId: true,
        requestedCount: true,
        modelVersion: true,
        promptVersion: true,
        notes: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
    }),
    db.generationBatch.count({ where }),
  ]);

  // One aggregate for the whole page — loading every item row just to count it turned the board
  // into a 10k-row read (measured at 27 ms; this is ~2 ms). Served by MasterItem(batchId, status).
  const grouped = await db.masterItem.groupBy({
    by: ["batchId", "status"],
    where: { batchId: { in: batches.map((batch) => batch.id) }, deletedAt: null },
    _count: { _all: true },
  });
  const byBatch = new Map<string, Record<string, number>>();
  for (const row of grouped) {
    if (!row.batchId) continue;
    const entry = byBatch.get(row.batchId) ?? {};
    entry[row.status] = row._count._all;
    byBatch.set(row.batchId, entry);
  }

  return listSchema.parse({
    items: batches.map((batch) => {
      const counts = countsFrom(byBatch.get(batch.id) ?? {});
      return { ...batch, counts, acceptanceRate: acceptanceRate(counts) };
    }),
    page: input.page,
    pageSize: input.pageSize,
    totalCount,
  });
}

/** Set detail — served by MasterItem(batchId, status). */
export async function getBatch(db: PrismaClient, id: string): Promise<BatchDetail> {
  const batch = await db.generationBatch.findUnique({
    where: { id },
    select: {
      id: true,
      kind: true,
      status: true,
      sourceImageId: true,
      topicId: true,
      requestedCount: true,
      modelVersion: true,
      promptVersion: true,
      notes: true,
      createdAt: true,
      items: {
        where: { deletedAt: null },
        select: ITEM_SELECT,
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!batch) throw new NotFoundError({ batchId: id });

  const { items, ...rest } = batch;
  const counts = countsOf(items as ItemRow[]);
  return batchDetailSchema.parse({
    ...rest,
    counts,
    acceptanceRate: acceptanceRate(counts),
    items: items.map(({ content, ...item }) => ({
      ...item,
      stemPreview: stemOf(content),
    })),
  });
}

export async function attachItemsToBatch(
  db: PrismaClient,
  actor: SessionUser,
  rawInput: unknown,
): Promise<number> {
  const input = attachItemsToBatchInputSchema.parse(rawInput);
  const batch = await db.generationBatch.findUnique({
    where: { id: input.batchId },
    select: { id: true },
  });
  if (!batch) throw new NotFoundError({ batchId: input.batchId });

  const claimed = await db.masterItem.findMany({
    where: { id: { in: input.itemIds }, deletedAt: null, batchId: { not: null } },
    select: { id: true, batchId: true },
  });
  const foreign = claimed.filter((item) => item.batchId !== input.batchId);
  if (foreign.length > 0) {
    // A question belongs to the set it was generated in; moving it would corrupt that set's
    // acceptance rate as well as this one's.
    throw new ConflictError(
      { itemIds: foreign.map((item) => item.id) },
      "admin.sets.errors.alreadyInAnotherSet",
    );
  }

  const result = await db.masterItem.updateMany({
    where: { id: { in: input.itemIds }, deletedAt: null },
    data: { batchId: input.batchId },
  });
  await auditLog({
    actorId: actor.id,
    action: AUDIT.batchItemsAttached,
    entityType: "GenerationBatch",
    entityId: input.batchId,
    meta: { attached: result.count },
  });
  return result.count;
}

export async function detachItem(
  db: PrismaClient,
  actor: SessionUser,
  rawInput: unknown,
): Promise<void> {
  const input = detachItemInputSchema.parse(rawInput);
  const item = await db.masterItem.findFirst({
    where: { id: input.itemId, deletedAt: null },
    select: { id: true, batchId: true },
  });
  if (!item?.batchId) throw new NotFoundError({ itemId: input.itemId });

  await db.masterItem.update({
    where: { id: item.id },
    data: { batchId: null },
    select: { id: true },
  });
  await auditLog({
    actorId: actor.id,
    action: AUDIT.batchItemDetached,
    entityType: "GenerationBatch",
    entityId: item.batchId,
    meta: { itemId: item.id },
  });
}
