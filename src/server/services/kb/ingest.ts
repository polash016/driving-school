import { Prisma, type PrismaClient } from "@prisma/client";
import { logger } from "@/lib/logger";
import { AUDIT, auditLog } from "@/server/audit";
import type { SessionUser } from "@/server/authz";
import { ingestSourceInputSchema } from "@/server/contracts/kb";
import { aiEmbed } from "@/server/ai/client";
import { chunkLegalText } from "./chunking";

/**
 * Knowledge-base ingestion (spec-05): a legal text becomes citable, searchable chunks.
 *
 * Re-ingesting a source REPLACES its chunks — a law that changes must not leave the old wording
 * retrievable next to the new one. Items citing a replaced chunk are flagged NEEDS_REVIEW, which
 * is the mechanism that stops a question quietly outliving the rule it was based on.
 */

const EMBED_BATCH = 32;

export interface IngestResult {
  sourceCode: string;
  chunksCreated: number;
  chunksReplaced: number;
  itemsFlagged: number;
}

export async function ingestSource(
  db: PrismaClient,
  actor: SessionUser | null,
  rawInput: unknown,
): Promise<IngestResult> {
  const input = ingestSourceInputSchema.parse(rawInput);
  const chunks = chunkLegalText(input.text);
  if (chunks.length === 0) {
    throw new Error("Nothing to ingest: the text produced no chunks.");
  }

  const source = await db.kbSource.upsert({
    where: { code: input.code },
    create: {
      code: input.code,
      kind: input.kind,
      name: input.name,
      url: input.url ?? null,
      effectiveDate: input.effectiveDate ? new Date(input.effectiveDate) : null,
      version: input.version ?? null,
    },
    update: {
      kind: input.kind,
      name: input.name,
      url: input.url ?? null,
      effectiveDate: input.effectiveDate ? new Date(input.effectiveDate) : null,
      version: input.version ?? null,
      deletedAt: null,
    },
    select: { id: true },
  });

  // Anything citing the outgoing chunks must be re-read by a human before it is served again.
  const outgoing = await db.kbChunk.findMany({
    where: { sourceId: source.id },
    select: { id: true },
  });
  let itemsFlagged = 0;
  if (outgoing.length > 0) {
    const citing = await db.masterItemCitation.findMany({
      where: { kbChunkId: { in: outgoing.map((chunk) => chunk.id) } },
      select: { masterItemId: true },
    });
    const itemIds = [...new Set(citing.map((row) => row.masterItemId))];
    if (itemIds.length > 0) {
      const flagged = await db.masterItem.updateMany({
        where: { id: { in: itemIds }, status: "APPROVED" },
        data: { status: "NEEDS_REVIEW" },
      });
      itemsFlagged = flagged.count;
    }
    await db.kbChunk.deleteMany({ where: { sourceId: source.id } });
  }

  // Embeddings in batches: one call per chunk would be slow and wasteful of quota.
  let created = 0;
  for (let start = 0; start < chunks.length; start += EMBED_BATCH) {
    const batch = chunks.slice(start, start + EMBED_BATCH);
    const vectors = await aiEmbed(batch.map((chunk) => chunk.text));

    for (const [index, chunk] of batch.entries()) {
      const vector = vectors[index];
      // pgvector has no Prisma type: the embedding goes in as raw SQL, the rest as parameters.
      await db.$executeRaw`
        INSERT INTO "KbChunk" ("id", "sourceId", "ref", "text", "embedding", "tokenCount", "isActive", "createdAt", "updatedAt")
        VALUES (
          ${`kbc_${source.id.slice(-8)}_${start + index}_${Date.now().toString(36)}`},
          ${source.id},
          ${chunk.ref},
          ${chunk.text},
          ${`[${vector.join(",")}]`}::vector,
          ${Math.round(chunk.text.length / 4)},
          true,
          now(),
          now()
        )
      `;
      created++;
    }
    logger.info(
      {
        source: input.code,
        embedded: Math.min(start + EMBED_BATCH, chunks.length),
        total: chunks.length,
      },
      "kb ingest progress",
    );
  }

  await db.kbSource.update({
    where: { id: source.id },
    data: { lastIngestedAt: new Date() },
    select: { id: true },
  });

  await auditLog({
    actorId: actor?.id ?? null,
    action: AUDIT.kbIngested,
    entityType: "KbSource",
    entityId: source.id,
    meta: {
      code: input.code,
      chunks: created,
      replaced: outgoing.length,
      itemsFlagged,
    },
  });

  return {
    sourceCode: input.code,
    chunksCreated: created,
    chunksReplaced: outgoing.length,
    itemsFlagged,
  };
}

/** Sources with their chunk counts — the admin KB screen and the ingest CLI both show this. */
export async function listSources(db: PrismaClient) {
  const sources = await db.kbSource.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      code: true,
      name: true,
      kind: true,
      url: true,
      lastIngestedAt: true,
      _count: { select: { chunks: true } },
    },
    orderBy: { code: "asc" },
  });
  return sources.map(({ _count, ...source }) => ({
    ...source,
    chunkCount: _count.chunks,
  }));
}

export type { Prisma };
