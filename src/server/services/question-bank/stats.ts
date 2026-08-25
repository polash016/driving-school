import { Prisma, type PrismaClient } from "@prisma/client";
import {
  accuracyStatsInputSchema,
  accuracyStatsSchema,
  type AccuracyStats,
} from "@/server/contracts/question-bank";
import { logger } from "@/lib/logger";
import { cacheGet, cacheSet, keys, redis } from "@/server/redis";

/**
 * How good is the AI? (spec-04 amendment)
 *
 * Acceptance rate = APPROVED / (APPROVED + RETIRED) over **AI-authored** items that reached a
 * terminal state — human-authored items have no acceptance rate to measure. Rejected items are
 * retired rather than deleted, so the denominator survives.
 *
 * Served by MasterItem(createdBy, status, reviewedAt).
 */

const CACHE_TTL_SEC = 300;

/**
 * Reads and writes share this counter: a write bumps it, so the next read computes a fresh
 * aggregate instead of serving a stale one. A Redis outage degrades to "always compute".
 */
async function statsVersion(): Promise<number> {
  try {
    const raw = await redis.get(keys.qbStatsVersion());
    return raw ? Number(raw) : 1;
  } catch (error) {
    logger.warn({ error }, "stats version read failed — computing uncached");
    return 0;
  }
}

/** Called by every write path in this service group (transition, upsert, import). */
export async function invalidateAccuracyStats(): Promise<void> {
  try {
    await redis.incr(keys.qbStatsVersion());
  } catch (error) {
    logger.warn({ error }, "stats version bump failed");
  }
}

interface Row {
  key: string | null;
  label: string | null;
  reviewed: bigint;
  approved: bigint;
  medianhours: number | null;
}

export async function accuracyStats(
  db: PrismaClient,
  rawInput: unknown = {},
): Promise<AccuracyStats> {
  const input = accuracyStatsInputSchema.parse(rawInput);
  const version = await statsVersion();
  const cacheKey = keys.qbStats(version, input.groupBy, input.sinceDays);

  if (version > 0) {
    const cached = await cacheGet<AccuracyStats>(cacheKey);
    if (cached) return accuracyStatsSchema.parse(cached);
  }

  const since = new Date(Date.now() - input.sinceDays * 86_400_000);

  // The grouping key differs; everything else about the query does not.
  const groupExpr =
    input.groupBy === "model"
      ? Prisma.sql`coalesce(m."modelVersion", 'unknown')`
      : input.groupBy === "prompt"
        ? Prisma.sql`coalesce(m."promptVersion", 'unknown')`
        : Prisma.sql`t."slug"`;
  const labelExpr =
    input.groupBy === "topic"
      ? Prisma.sql`coalesce(t."name"->>'en', t."slug")`
      : groupExpr;

  const rows = await db.$queryRaw<Row[]>(Prisma.sql`
    SELECT ${groupExpr} AS key,
           ${labelExpr} AS label,
           count(*)::bigint AS reviewed,
           count(*) FILTER (WHERE m."status" = 'APPROVED')::bigint AS approved,
           percentile_cont(0.5) WITHIN GROUP (
             ORDER BY EXTRACT(EPOCH FROM (m."reviewedAt" - m."createdAt")) / 3600
           ) AS medianhours
      FROM "MasterItem" m
      JOIN "Topic" t ON t."id" = m."topicId"
     WHERE m."deletedAt" IS NULL
       AND m."createdBy" = 'AI'
       AND m."status" IN ('APPROVED', 'RETIRED')
       AND m."reviewedAt" >= ${since}
     GROUP BY 1, 2
     ORDER BY reviewed DESC
     LIMIT 50
  `);

  const reasons = await db.masterItem.groupBy({
    by: ["reviewReason"],
    where: {
      deletedAt: null,
      createdBy: "AI",
      status: "RETIRED",
      reviewedAt: { gte: since },
      reviewReason: { not: null },
    },
    _count: { _all: true },
  });

  const totals = await db.masterItem.groupBy({
    by: ["status"],
    where: { deletedAt: null, createdBy: "AI" },
    _count: { _all: true },
  });
  const totalBy = (status: string) =>
    totals.find((row) => row.status === status)?._count._all ?? 0;

  const stats = accuracyStatsSchema.parse({
    groupBy: input.groupBy,
    sinceDays: input.sinceDays,
    rows: rows.map((row) => {
      const reviewed = Number(row.reviewed);
      const approved = Number(row.approved);
      return {
        key: row.key ?? "unknown",
        label: row.label ?? row.key ?? "unknown",
        reviewed,
        approved,
        rate: reviewed === 0 ? 0 : approved / reviewed,
        medianHoursToReview:
          row.medianhours === null
            ? null
            : Math.max(0, Number(row.medianhours)),
      };
    }),
    reasons: reasons
      .map((row) => ({ reason: row.reviewReason!, count: row._count._all }))
      .sort((a, b) => b.count - a.count),
    totals: {
      total: totals.reduce((sum, row) => sum + row._count._all, 0),
      draft: totalBy("DRAFT"),
      inReview: totalBy("IN_REVIEW"),
      approved: totalBy("APPROVED"),
      retired: totalBy("RETIRED"),
      needsReview: totalBy("NEEDS_REVIEW"),
    },
  });

  // Invalidated by: invalidateAccuracyStats() from every write path (version bump).
  if (version > 0) await cacheSet(cacheKey, stats, CACHE_TTL_SEC);
  return stats;
}
