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
 * - a slice whose membership is unchanged KEEPS ITS NUMBER — a student's passed #7 must not
 *   silently become different material on the next rebuild;
 * - a remainder under half a paper folds into the previous slice instead of being published as a
 *   stub that would misreport a student's readiness.
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
  const chunks = chunkInterleaved(items, poolSize, options.paperSize);

  const slices: PartitionedSlice[] = chunks.map((chunk) => ({
    number: 0,
    masterItemIds: chunk.map((item) => item.masterItemId),
    composition: describe(chunk),
  }));

  assignNumbers(slices, options.existing ?? []);

  return { slices, orphaned: [] };
}

/**
 * Round-robin over topic buckets so no slice fills from one topic, then cut into pools.
 *
 * Sorting by id before bucketing is what makes the result independent of the order rows came back
 * from the database — two rebuilds over the same bank must produce byte-identical slices.
 */
function chunkInterleaved(
  items: PartitionItem[],
  poolSize: number,
  paperSize: number,
): PartitionItem[][] {
  const byTopic = new Map<string, PartitionItem[]>();
  for (const item of [...items].sort((a, b) =>
    a.masterItemId.localeCompare(b.masterItemId),
  )) {
    const bucket = byTopic.get(item.topicSlug) ?? [];
    bucket.push(item);
    byTopic.set(item.topicSlug, bucket);
  }
  // Easy questions first within a topic, so difficulty spreads evenly across slices rather than
  // stacking the hard ones into the last one.
  for (const bucket of byTopic.values()) {
    bucket.sort(
      (a, b) =>
        a.difficulty - b.difficulty ||
        a.masterItemId.localeCompare(b.masterItemId),
    );
  }

  const topics = [...byTopic.keys()].sort();
  const interleaved: PartitionItem[] = [];
  let drained = false;
  while (!drained) {
    drained = true;
    for (const topic of topics) {
      const next = byTopic.get(topic)!.shift();
      if (next) {
        interleaved.push(next);
        drained = false;
      }
    }
  }

  const chunks: PartitionItem[][] = [];
  for (let i = 0; i < interleaved.length; i += poolSize) {
    chunks.push(interleaved.slice(i, i + poolSize));
  }

  // A stub set is worse than a fat one: fold a short tail back into its predecessor.
  if (chunks.length > 1) {
    const tail = chunks[chunks.length - 1];
    if (tail.length < paperSize / 2) {
      chunks[chunks.length - 2].push(...tail);
      chunks.pop();
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
