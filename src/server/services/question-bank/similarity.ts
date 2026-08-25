import { Prisma, type PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { logger } from "@/lib/logger";
import { aiEmbed } from "@/server/ai/client";

/**
 * Question similarity (spec-04/06).
 *
 * Two questions can be too alike in two different ways, and they need different answers:
 *
 * - **A repeat** — the same question written twice. Worthless: it wastes a reviewer's time and, if
 *   both are approved, doubles that rule's weight in the pool. Rejected at generation.
 * - **An alternate phrasing** — the same rule asked differently, with different options. Valuable:
 *   two students can each get one, so the pool is not a memorisable fixed list. Kept, but tagged
 *   with a shared `conceptGroupId` so a single student never meets both in one test.
 *
 * The line between them is a cosine threshold over stem embeddings. Both numbers are deliberate
 * and tunable; they are the difference between a varied exam and a repetitive one.
 */

/**
 * At or above this, it is the same question. Calibrated on this bank: pairs at 0.94+ were verbatim
 * re-writes ("Which lights must be turned on during driving?" twice), never distinct rules.
 */
export const REPEAT_THRESHOLD = 0.94;
/**
 * Between the two, it is the same point asked differently — an alternate, not a duplicate.
 *
 * Also calibrated against the real bank rather than guessed. At 0.835–0.94 the pairs genuinely
 * test one rule ("When should low beams be used?" / "When must you use dipped headlights?"). Below
 * ~0.83 they diverge — 0.822 paired a tram stopping at a stop with two cars meeting on a narrow
 * road, which are different rules. Grouping those would shrink the pool for nothing, so the line
 * sits at 0.85 with margin.
 */
export const ALTERNATE_THRESHOLD = 0.85;

export interface SimilarityVerdict {
  kind: "distinct" | "alternate" | "repeat";
  similarity: number;
  matchedItemId?: string;
  conceptGroupId?: string;
}

/** Embeds question stems (both locales together — a rule is the same rule in either language). */
export async function embedStems(stems: Array<{ en: string; nb: string }>): Promise<number[][]> {
  return aiEmbed(stems.map((stem) => `${stem.en}\n${stem.nb}`));
}

function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

/**
 * Compares one candidate against everything already in the bank. Retired questions are included
 * on purpose: re-writing something a reviewer already rejected is exactly the loop to avoid.
 */
export async function classifyAgainstPool(
  db: PrismaClient,
  embedding: number[],
  excludeItemId?: string,
): Promise<SimilarityVerdict> {
  const rows = await db.$queryRaw<
    Array<{ id: string; conceptGroupId: string | null; similarity: number }>
  >(Prisma.sql`
    SELECT "id", "conceptGroupId",
           1 - ("stemEmbedding" <=> ${toVectorLiteral(embedding)}::vector) AS similarity
      FROM "MasterItem"
     WHERE "deletedAt" IS NULL
       AND "stemEmbedding" IS NOT NULL
       ${excludeItemId ? Prisma.sql`AND "id" <> ${excludeItemId}` : Prisma.empty}
     ORDER BY "stemEmbedding" <=> ${toVectorLiteral(embedding)}::vector
     LIMIT 1
  `);

  const best = rows[0];
  if (!best) return { kind: "distinct", similarity: 0 };

  const similarity = Number(best.similarity);
  if (similarity >= REPEAT_THRESHOLD) {
    return { kind: "repeat", similarity, matchedItemId: best.id };
  }
  if (similarity >= ALTERNATE_THRESHOLD) {
    return {
      kind: "alternate",
      similarity,
      matchedItemId: best.id,
      // Join the existing group if the match already belongs to one; otherwise start a group.
      conceptGroupId: best.conceptGroupId ?? randomUUID(),
    };
  }
  return { kind: "distinct", similarity };
}

/** Cosine similarity between two candidates in the same batch (both already normalised by the API). */
export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const magnitude = Math.sqrt(magA) * Math.sqrt(magB);
  return magnitude === 0 ? 0 : dot / magnitude;
}

/** Writes the embedding and concept group — pgvector has no Prisma type, so this is raw SQL. */
export async function storeStemEmbedding(
  db: PrismaClient,
  itemId: string,
  embedding: number[],
  conceptGroupId: string | null,
): Promise<void> {
  await db.$executeRaw`
    UPDATE "MasterItem"
       SET "stemEmbedding" = ${toVectorLiteral(embedding)}::vector,
           "conceptGroupId" = ${conceptGroupId}
     WHERE "id" = ${itemId}
  `;
  logger.debug({ itemId, conceptGroupId }, "stem embedding stored");
}

/**
 * Backfills questions written before embeddings existed, and links the alternates among them.
 * Returns what it found so a one-off cleanup can act on it.
 */
export async function backfillEmbeddings(
  db: PrismaClient,
  batchSize = 32,
): Promise<{ embedded: number; repeats: Array<{ id: string; matchedItemId: string; similarity: number }> }> {
  const pending = await db.$queryRaw<Array<{ id: string; content: unknown }>>(Prisma.sql`
    SELECT "id", "content" FROM "MasterItem"
     WHERE "deletedAt" IS NULL AND "stemEmbedding" IS NULL
     ORDER BY "createdAt" ASC
  `);

  const repeats: Array<{ id: string; matchedItemId: string; similarity: number }> = [];
  let embedded = 0;

  for (let start = 0; start < pending.length; start += batchSize) {
    const batch = pending.slice(start, start + batchSize);
    const stems = batch.map((row) => {
      const content = row.content as { en?: { stem?: string }; nb?: { stem?: string } };
      return { en: content?.en?.stem ?? "", nb: content?.nb?.stem ?? "" };
    });
    const vectors = await embedStems(stems);

    for (const [index, row] of batch.entries()) {
      const verdict = await classifyAgainstPool(db, vectors[index], row.id);
      await storeStemEmbedding(db, row.id, vectors[index], verdict.conceptGroupId ?? null);
      if (verdict.kind === "repeat" && verdict.matchedItemId) {
        repeats.push({
          id: row.id,
          matchedItemId: verdict.matchedItemId,
          similarity: verdict.similarity,
        });
      }
      embedded++;
    }
  }

  return { embedded, repeats };
}

export interface SimilarPair {
  id: string;
  matchedItemId: string;
  similarity: number;
}

/**
 * Every servable question whose nearest neighbour is too close to be a different question.
 *
 * One nearest-neighbour lookup per item rather than an all-pairs comparison: the HNSW index makes
 * each lookup a probe instead of a scan, so this stays usable at bank size. Retired questions are
 * excluded on both sides — retiring one half of a pair is precisely how a repeat gets resolved.
 */
export async function findRepeatPairs(
  db: PrismaClient,
  threshold = REPEAT_THRESHOLD,
): Promise<SimilarPair[]> {
  const rows = await db.$queryRaw<Array<{ id: string; matchedItemId: string; similarity: number }>>(
    Prisma.sql`
      SELECT a."id",
             n."id"       AS "matchedItemId",
             1 - (a."stemEmbedding" <=> n."stemEmbedding") AS "similarity"
        FROM "MasterItem" a
        CROSS JOIN LATERAL (
              SELECT b."id", b."stemEmbedding"
                FROM "MasterItem" b
               WHERE b."deletedAt" IS NULL
                 AND b."stemEmbedding" IS NOT NULL
                 AND b."status" <> 'RETIRED'
                 AND b."id" <> a."id"
               ORDER BY b."stemEmbedding" <=> a."stemEmbedding"
               LIMIT 1
             ) n
       WHERE a."deletedAt" IS NULL
         AND a."stemEmbedding" IS NOT NULL
         AND a."status" <> 'RETIRED'
         AND 1 - (a."stemEmbedding" <=> n."stemEmbedding") >= ${threshold}
       ORDER BY "similarity" DESC
    `,
  );
  // The lookup is symmetric, so each pair surfaces twice; keep one direction.
  const seen = new Set<string>();
  const pairs: SimilarPair[] = [];
  for (const row of rows) {
    const key = [row.id, row.matchedItemId].sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ ...row, similarity: Number(row.similarity) });
  }
  return pairs;
}

/**
 * Every near neighbour of every servable question, above `threshold`, up to `perItem` each.
 * One indexed probe per row, so it stays usable as the bank grows.
 */
export async function findSimilarPairs(
  db: PrismaClient,
  threshold: number,
  perItem = 5,
): Promise<SimilarPair[]> {
  const rows = await db.$queryRaw<Array<{ id: string; matchedItemId: string; similarity: number }>>(
    Prisma.sql`
      SELECT a."id",
             n."id"       AS "matchedItemId",
             1 - (a."stemEmbedding" <=> n."stemEmbedding") AS "similarity"
        FROM "MasterItem" a
        CROSS JOIN LATERAL (
              SELECT b."id", b."stemEmbedding"
                FROM "MasterItem" b
               WHERE b."deletedAt" IS NULL
                 AND b."stemEmbedding" IS NOT NULL
                 AND b."status" <> 'RETIRED'
                 AND b."id" <> a."id"
               ORDER BY b."stemEmbedding" <=> a."stemEmbedding"
               LIMIT ${perItem}
             ) n
       WHERE a."deletedAt" IS NULL
         AND a."stemEmbedding" IS NOT NULL
         AND a."status" <> 'RETIRED'
         AND 1 - (a."stemEmbedding" <=> n."stemEmbedding") >= ${threshold}
    `,
  );
  const seen = new Set<string>();
  const pairs: SimilarPair[] = [];
  for (const row of rows) {
    const key = [row.id, row.matchedItemId].sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ ...row, similarity: Number(row.similarity) });
  }
  return pairs.sort((a, b) => b.similarity - a.similarity);
}

/**
 * Re-derives concept groups across the whole bank: questions that ask the same thing in different
 * words share a group id, and are therefore never served to one student together.
 *
 * Clustering is **complete linkage** — a question joins a group only if it is close to EVERY
 * member, not just to one of them. Single linkage was tried first and chained badly: "yield to the
 * right" and "turning left yields to oncoming traffic" ended up in one nine-question group through
 * a run of intermediate phrasings, and those are different rules. Over-merging is the expensive
 * mistake here, because a merged group contributes exactly one question to any exam.
 *
 * Needed as a pass of its own because a group assigned at write time only saw the questions that
 * existed then — and removing a repeat can make its neighbour the new nearest match.
 */
export async function regroupAlternates(db: PrismaClient): Promise<{ groups: number; items: number }> {
  const pairs = (await findSimilarPairs(db, ALTERNATE_THRESHOLD)).filter(
    (pair) => pair.similarity < REPEAT_THRESHOLD,
  );

  // Similarity oracle. A pair absent from the top-K edge list is, by construction, below the
  // threshold — which is exactly the answer complete linkage needs from it.
  const edge = new Map<string, number>();
  const keyOf = (a: string, b: string) => [a, b].sort().join("|");
  for (const pair of pairs) edge.set(keyOf(pair.id, pair.matchedItemId), pair.similarity);

  const clusterOf = new Map<string, string[]>();
  const clusterFor = (id: string): string[] => clusterOf.get(id) ?? [id];

  // Strongest pairs first, so the tightest questions decide the shape of a group.
  for (const pair of pairs) {
    const a = clusterFor(pair.id);
    const b = clusterFor(pair.matchedItemId);
    if (a === b) continue;
    const linked = a.every((x) => b.every((y) => (edge.get(keyOf(x, y)) ?? 0) >= ALTERNATE_THRESHOLD));
    if (!linked) continue;
    const merged = [...a, ...b];
    for (const id of merged) clusterOf.set(id, merged);
  }

  // Members of one cluster all point at the same array; key by its sorted members to dedupe.
  const clusters = new Map<string, string[]>();
  for (const members of clusterOf.values()) {
    if (members.length < 2) continue;
    clusters.set([...members].sort().join("|"), members);
  }

  let items = 0;
  const grouped: string[] = [];
  // Two clusters must never end up with the same id — that would silently re-merge them in the
  // database, which is how an over-merged group survives a re-grouping pass.
  const claimed = new Set<string>();
  for (const ids of clusters.values()) {
    // Reuse an existing group id where the cluster already had one, so links stay stable.
    const existing = await db.masterItem.findFirst({
      where: { id: { in: ids }, conceptGroupId: { not: null } },
      select: { conceptGroupId: true },
    });
    const reusable =
      existing?.conceptGroupId && !claimed.has(existing.conceptGroupId)
        ? existing.conceptGroupId
        : null;
    const groupId = reusable ?? randomUUID();
    claimed.add(groupId);
    const updated = await db.masterItem.updateMany({
      where: { id: { in: ids } },
      data: { conceptGroupId: groupId },
    });
    items += updated.count;
    grouped.push(...ids);
  }

  // Anything no longer near anything else must lose its group, or it blocks a sibling for nothing.
  await db.masterItem.updateMany({
    where: { conceptGroupId: { not: null }, id: { notIn: grouped.length > 0 ? grouped : ["-"] } },
    data: { conceptGroupId: null },
  });

  return { groups: clusters.size, items };
}
