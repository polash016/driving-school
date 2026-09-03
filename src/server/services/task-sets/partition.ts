import type { ItemType } from "@prisma/client";

/**
 * Bank → balanced slices (spec-16). PURE: no I/O, no clock, no randomness.
 *
 * A slice is a task set's identity, so this function's contract is stricter than "split a list":
 *
 * - every item lands in exactly one slice — the coverage guarantee the database then enforces
 *   through `TaskSetMember.masterItemId` being a primary key;
 * - a slice draws from several topics, because a paper drawn from a single-topic slice would not
 *   be a mock exam;
 * - EVERY slice mirrors the bank's topic mix, not just "more than one topic" — see
 *   `chunkStratified` for why the obvious approach fails on a real, lopsided bank;
 * - a slice whose membership is unchanged KEEPS ITS NUMBER — a student's passed #7 must not
 *   silently become different material on the next rebuild;
 * - a remainder is absorbed into the slices rather than published as a short one, so a "task set"
 *   of nine questions — which would misreport a student's readiness — cannot exist.
 *
 * Determinism matters as much as balance: the same bank must produce the same slices, or number
 * preservation could not be checked and a rebuild would reshuffle everyone's progress.
 */

export interface PartitionItem {
  masterItemId: string;
  /** ROOT topic slug — the distribution level, matching the exam blueprint. */
  topicSlug: string;
  type: ItemType;
  /** 1..5 */
  difficulty: number;
}

export interface SliceComposition {
  topicCounts: Record<string, number>;
  typeCounts: Record<string, number>;
  avgDifficulty: number;
  warnings: string[];
}

export interface PartitionedSlice {
  number: number;
  masterItemIds: string[];
  composition: SliceComposition;
}

export interface PartitionResult {
  slices: PartitionedSlice[];
  /** Items that could not be placed. Non-empty means the caller must fail, not publish. */
  orphaned: string[];
}

export interface PartitionOptions {
  paperSize: number;
  /** poolSize = ceil(paperSize × poolRatio). 1.5 by spec-16. */
  poolRatio: number;
  /** Previous published membership, so unchanged slices keep their numbers. */
  existing?: { number: number; masterItemIds: string[] }[];
}

export function partitionBank(
  items: PartitionItem[],
  options: PartitionOptions,
): PartitionResult {
  if (items.length === 0) return { slices: [], orphaned: [] };

  const poolSize = Math.ceil(options.paperSize * options.poolRatio);
  const chunks = chunkStratified(items, poolSize);

  const slices: PartitionedSlice[] = chunks.map((chunk) => ({
    number: 0,
    masterItemIds: chunk.map((item) => item.masterItemId),
    composition: describe(chunk),
  }));

  assignNumbers(slices, options.existing ?? []);

  return { slices, orphaned: [] };
}

/**
 * Deal every topic across EVERY slice, so each slice mirrors the bank's own topic mix.
 *
 * The naive approach — round-robin one item per topic until the buckets drain — looks balanced and
 * is not: a bank whose largest topic outnumbers the rest (this one has 574 sign questions against
 * 130 of everything else) exhausts the small topics in the first slices and leaves the tail
 * single-topic. Those sets would be sign quizzes wearing a mock exam's name.
 *
 * Instead the slice count is fixed first, then each topic's items are dealt round-robin across all
 * slices, each topic continuing where the previous one stopped. Every slice ends up with a
 * proportional share of every topic, and slice sizes differ by at most one.
 *
 * Sorting by id before dealing is what makes the result independent of the order rows came back
 * from the database — two rebuilds over the same bank must produce byte-identical slices.
 */
function chunkStratified(
  items: PartitionItem[],
  poolSize: number,
): PartitionItem[][] {
  // FLOOR, not ceil: a remainder is absorbed into the existing slices rather than published as a
  // short one. Every slice is therefore at least `poolSize`, and a stub set cannot happen.
  const sliceCount = Math.max(1, Math.floor(items.length / poolSize));

  const byTopic = new Map<string, PartitionItem[]>();
  for (const item of [...items].sort((a, b) =>
    a.masterItemId.localeCompare(b.masterItemId),
  )) {
    const bucket = byTopic.get(item.topicSlug) ?? [];
    bucket.push(item);
    byTopic.set(item.topicSlug, bucket);
  }
  // Easy questions first within a topic, so difficulty spreads across slices rather than stacking
  // the hard ones into the last one.
  for (const bucket of byTopic.values()) {
    bucket.sort(
      (a, b) =>
        a.difficulty - b.difficulty ||
        a.masterItemId.localeCompare(b.masterItemId),
    );
  }

  const chunks: PartitionItem[][] = Array.from(
    { length: sliceCount },
    () => [],
  );
  // One cursor across all topics: topic B picks up where topic A stopped, so a topic smaller than
  // the slice count still lands in different slices each rebuild-neutral pass rather than always
  // in the first few.
  let cursor = 0;
  for (const topic of [...byTopic.keys()].sort()) {
    for (const item of byTopic.get(topic)!) {
      chunks[cursor % sliceCount].push(item);
      cursor += 1;
    }
  }
  return chunks;
}

/**
 * Two passes, so a rebuild is not a reshuffle: a slice whose exact membership survived reclaims
 * its old number first, and only what is genuinely new takes a fresh one.
 */
function assignNumbers(
  slices: PartitionedSlice[],
  existing: { number: number; masterItemIds: string[] }[],
): void {
  const previousByKey = new Map<string, number>();
  for (const slice of existing) {
    previousByKey.set(membershipKey(slice.masterItemIds), slice.number);
  }
  const taken = new Set<number>();

  for (const slice of slices) {
    const kept = previousByKey.get(membershipKey(slice.masterItemIds));
    if (kept !== undefined && !taken.has(kept)) {
      slice.number = kept;
      taken.add(kept);
    }
  }

  let next = 1;
  for (const slice of slices) {
    if (slice.number !== 0) continue;
    while (taken.has(next)) next += 1;
    slice.number = next;
    taken.add(next);
  }

  slices.sort((a, b) => a.number - b.number);
}

function membershipKey(ids: string[]): string {
  return [...ids].sort().join(",");
}

/** What an admin reads before publishing: is this slice actually a fair paper's worth? */
function describe(chunk: PartitionItem[]): SliceComposition {
  const topicCounts: Record<string, number> = {};
  const typeCounts: Record<string, number> = {};
  let difficultyTotal = 0;

  for (const item of chunk) {
    topicCounts[item.topicSlug] = (topicCounts[item.topicSlug] ?? 0) + 1;
    typeCounts[item.type] = (typeCounts[item.type] ?? 0) + 1;
    difficultyTotal += item.difficulty;
  }

  const warnings: string[] = [];
  if ((typeCounts.IMAGE ?? 0) + (typeCounts.SIGN ?? 0) === 0) {
    warnings.push("NO_VISUAL_QUESTIONS");
  }
  if (Object.keys(topicCounts).length < 2) warnings.push("SINGLE_TOPIC");

  return {
    topicCounts,
    typeCounts,
    avgDifficulty: chunk.length === 0 ? 0 : difficultyTotal / chunk.length,
    warnings,
  };
}
