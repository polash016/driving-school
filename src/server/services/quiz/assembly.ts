import type { ItemType } from "@prisma/client";
import { createRng, shuffle } from "./rng";

/**
 * Assembly (spec-07 layer 3): PURE, deterministic under `seed`.
 * Candidate pools are fetched by the caller (VariantSource port); no I/O here.
 *
 * Guarantees:
 * - a masterItem appears at most once per attempt (variants of one master are
 *   the same concept — repeating it would be a broken exam);
 * - variants whose contentHash the user saw within the window are excluded
 *   first, with explicit warnings when the pool forces reuse;
 * - image-type share targets `imageRatio` via largest-remainder allocation;
 * - final question order and every option order are seeded shuffles.
 */

export interface VariantCandidate {
  variantId: string;
  masterItemId: string;
  contentHash: string;
  type: ItemType;
  /** ROOT (distribution) topic slug — used for breakdowns. */
  topicSlug: string;
  /** The master item's own (possibly sub-)topic id — denormalized onto the question row. */
  topicId: string;
  optionKeys: string[];
}

export interface AssembledQuestion {
  position: number;
  variantId: string;
  masterItemId: string;
  contentHash: string;
  topicSlug: string;
  topicId: string;
  optionOrder: string[];
}

export interface AssemblyResult {
  questions: AssembledQuestion[];
  /** requested − assembled; >0 means the pool could not fill the blueprint. */
  shortfall: number;
  warnings: string[];
}

export function assembleQuiz(input: {
  seed: string;
  /** topicSlug → question count (blueprint or derived distribution). */
  distribution: Record<string, number>;
  /** Target share of IMAGE questions across the whole quiz, 0..1. */
  imageRatio: number;
  candidatesByTopic: Record<string, VariantCandidate[]>;
  seenHashes: ReadonlySet<string>;
}): AssemblyResult {
  const rng = createRng(input.seed);
  const warnings: string[] = [];
  const usedMasterIds = new Set<string>();
  const selected: VariantCandidate[] = [];

  const topics = Object.keys(input.distribution).sort(); // deterministic topic order
  const totalRequested = topics.reduce(
    (sum, t) => sum + input.distribution[t],
    0,
  );
  const imageQuota = allocateImageQuota(
    topics.map((t) => ({ slug: t, count: input.distribution[t] })),
    input.imageRatio,
    totalRequested,
  );

  for (const topicSlug of topics) {
    const count = input.distribution[topicSlug];
    const pool = input.candidatesByTopic[topicSlug] ?? [];
    const wantImages = imageQuota.get(topicSlug) ?? 0;

    const picked = pickForTopic({
      rng,
      pool,
      count,
      wantImages,
      seenHashes: input.seenHashes,
      usedMasterIds,
      warnings,
      topicSlug,
    });
    selected.push(...picked);
  }

  const ordered = shuffle(rng, selected);
  const questions = ordered.map((candidate, i) => ({
    position: i + 1,
    variantId: candidate.variantId,
    masterItemId: candidate.masterItemId,
    contentHash: candidate.contentHash,
    topicSlug: candidate.topicSlug,
    topicId: candidate.topicId,
    optionOrder: shuffle(rng, candidate.optionKeys),
  }));

  return {
    questions,
    shortfall: totalRequested - questions.length,
    warnings,
  };
}

/** Largest-remainder distribution of the total image quota across topics. */
function allocateImageQuota(
  topics: Array<{ slug: string; count: number }>,
  imageRatio: number,
  totalRequested: number,
): Map<string, number> {
  const targetImages = Math.round(totalRequested * imageRatio);
  const exact = topics.map((t) => ({
    slug: t.slug,
    exact: t.count === 0 ? 0 : (t.count / totalRequested) * targetImages,
    cap: t.count,
  }));
  const quota = new Map<string, number>(
    exact.map((e) => [e.slug, Math.min(Math.floor(e.exact), e.cap)]),
  );
  let assigned = [...quota.values()].reduce((a, b) => a + b, 0);
  const byRemainder = [...exact].sort(
    (a, b) => (b.exact % 1) - (a.exact % 1) || a.slug.localeCompare(b.slug),
  );
  for (const e of byRemainder) {
    if (assigned >= targetImages) break;
    const current = quota.get(e.slug) ?? 0;
    if (current < e.cap) {
      quota.set(e.slug, current + 1);
      assigned++;
    }
  }
  return quota;
}

function pickForTopic(ctx: {
  rng: () => number;
  pool: VariantCandidate[];
  count: number;
  wantImages: number;
  seenHashes: ReadonlySet<string>;
  usedMasterIds: Set<string>;
  warnings: string[];
  topicSlug: string;
}): VariantCandidate[] {
  const { rng, seenHashes, usedMasterIds, warnings, topicSlug } = ctx;

  // Deterministic base order, then seeded shuffle so ties break randomly-but-reproducibly.
  const poolShuffled = shuffle(
    rng,
    [...ctx.pool].sort((a, b) => a.variantId.localeCompare(b.variantId)),
  );

  // Preference tiers: unseen images / unseen non-images / seen images / seen non-images.
  const tiers = {
    unseenImage: [] as VariantCandidate[],
    unseenOther: [] as VariantCandidate[],
    seenImage: [] as VariantCandidate[],
    seenOther: [] as VariantCandidate[],
  };
  for (const c of poolShuffled) {
    const seen = seenHashes.has(c.contentHash);
    const image = c.type === "IMAGE";
    if (!seen && image) tiers.unseenImage.push(c);
    else if (!seen) tiers.unseenOther.push(c);
    else if (image) tiers.seenImage.push(c);
    else tiers.seenOther.push(c);
  }

  const picked: VariantCandidate[] = [];
  const take = (from: VariantCandidate[], n: number): number => {
    let taken = 0;
    for (const c of from) {
      if (taken >= n) break;
      if (usedMasterIds.has(c.masterItemId)) continue;
      usedMasterIds.add(c.masterItemId);
      picked.push(c);
      taken++;
    }
    return taken;
  };

  // 1) image quota from unseen images, topping up from seen images if forced
  let images = take(tiers.unseenImage, ctx.wantImages);
  if (images < ctx.wantImages) {
    const reused = take(tiers.seenImage, ctx.wantImages - images);
    if (reused > 0)
      warnings.push(`${topicSlug}: reused ${reused} seen image variant(s)`);
    images += reused;
  }
  if (images < ctx.wantImages) {
    warnings.push(
      `${topicSlug}: image quota short by ${ctx.wantImages - images}, filling with text`,
    );
  }

  // 2) rest from unseen non-images, then any unseen images beyond quota, then seen
  const rest = ctx.count - picked.length;
  let filled = take(tiers.unseenOther, rest);
  filled += take(tiers.unseenImage, rest - filled);
  if (filled < rest) {
    const reused = take(tiers.seenOther, rest - filled) +
      take(tiers.seenImage, rest - filled);
    if (reused > 0)
      warnings.push(`${topicSlug}: pool thin — reused ${reused} seen variant(s)`);
    filled += reused;
  }
  if (picked.length < ctx.count) {
    warnings.push(
      `${topicSlug}: pool exhausted — ${picked.length}/${ctx.count} assembled`,
    );
  }
  return picked;
}
