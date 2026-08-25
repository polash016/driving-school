import { Prisma, type PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { logger } from "@/lib/logger";
import { aiEmbed } from "@/server/ai/client";
import { kbSearchInputSchema, kbSearchResultSchema } from "@/server/contracts/kb";
import { cacheGet, cacheSet, keys } from "@/server/redis";

/**
 * Hybrid search over the knowledge base (spec-05).
 *
 * Two legs, because each fails where the other works: the vector leg finds a rule described in
 * different words ("who goes first at a crossroads" → the right-hand rule), the keyword leg finds
 * an exact term or section number the embedding would blur ("§ 7", "promille").
 *
 * Fused with Reciprocal Rank Fusion — `score = Σ 1/(60 + rank)`. No weight to tune, and it is
 * indifferent to the two legs having incomparable score scales, which is the usual way naive
 * hybrid search goes wrong.
 */

const RRF_K = 60;
/** Each leg contributes this many candidates before fusion. */
const LEG_LIMIT = 20;
const QUERY_EMBEDDING_TTL_SEC = 24 * 3600;

interface LegRow {
  id: string;
  ref: string;
  text: string;
  sourceCode: string;
  sourceName: string;
}

/**
 * Embedding the same query twice is a wasted API call — and the admin KB screen re-runs the same
 * few queries constantly. Cached by query hash, invalidated only by expiry.
 */
async function embedQuery(query: string): Promise<number[] | null> {
  const hash = createHash("sha256").update(query.toLowerCase().trim()).digest("hex").slice(0, 32);
  const cacheKey = keys.kbQueryEmbedding(hash);

  const cached = await cacheGet<number[]>(cacheKey);
  if (cached) return cached;

  try {
    const [vector] = await aiEmbed([query]);
    await cacheSet(cacheKey, vector, QUERY_EMBEDDING_TTL_SEC);
    return vector;
  } catch (error) {
    // Degrade to keyword-only rather than failing the search: a slower answer beats no answer.
    logger.warn({ error }, "query embedding failed — keyword-only search");
    return null;
  }
}

export async function search(db: PrismaClient, rawInput: unknown) {
  const input = kbSearchInputSchema.parse(rawInput);
  const vector = await embedQuery(input.query);

  const [semantic, keyword] = await Promise.all([
    vector
      ? db.$queryRaw<LegRow[]>(Prisma.sql`
          SELECT c."id", c."ref", c."text", s."code" AS "sourceCode", s."name" AS "sourceName"
            FROM "KbChunk" c
            JOIN "KbSource" s ON s."id" = c."sourceId"
           WHERE c."isActive" = true AND s."deletedAt" IS NULL AND c."embedding" IS NOT NULL
           ORDER BY c."embedding" <=> ${`[${vector.join(",")}]`}::vector
           LIMIT ${LEG_LIMIT}
        `)
      : Promise.resolve([]),
    db.$queryRaw<LegRow[]>(Prisma.sql`
      SELECT c."id", c."ref", c."text", s."code" AS "sourceCode", s."name" AS "sourceName"
        FROM "KbChunk" c
        JOIN "KbSource" s ON s."id" = c."sourceId"
       WHERE c."isActive" = true AND s."deletedAt" IS NULL
         AND c."textSearch" @@ plainto_tsquery('norwegian', ${input.query})
       ORDER BY ts_rank(c."textSearch", plainto_tsquery('norwegian', ${input.query})) DESC
       LIMIT ${LEG_LIMIT}
    `),
  ]);

  const scores = new Map<string, { row: LegRow; score: number }>();
  for (const leg of [semantic, keyword]) {
    leg.forEach((row, rank) => {
      const existing = scores.get(row.id);
      const contribution = 1 / (RRF_K + rank + 1);
      if (existing) existing.score += contribution;
      else scores.set(row.id, { row, score: contribution });
    });
  }

  const hits = [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, input.limit)
    .map(({ row, score }) => ({
      chunkId: row.id,
      sourceCode: row.sourceCode,
      sourceName: row.sourceName,
      ref: row.ref,
      text: row.text,
      score,
    }));

  return kbSearchResultSchema.parse({ hits });
}

/** Pure fusion, exposed so the ranking rule can be tested without a database or an API key. */
export function fuseRankings(legs: string[][], k = RRF_K): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>();
  for (const leg of legs) {
    leg.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}
