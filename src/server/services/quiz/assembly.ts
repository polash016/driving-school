import type { ItemType } from "@prisma/client";
import { createRng, shuffle } from "./rng";

/**
 * Assembly (spec-07 layer 3): PURE, deterministic under `seed`.
 * Candidate pools are fetched by the caller (VariantSource port); no I/O here.
 *
 * Guarantees:
 * - a masterItem appears at most once per attempt (variants of one master are
 *   the same concept — repeating it would be a broken exam);
 * - two questions that test the SAME point in different words (same `conceptGroupId`) never
 *   share a paper either: to the student they are the same question asked twice, which is what
 *   makes a test feel cheap. Different students may still each get one of them;
 * - the paper is spread across difficulty bands rather than drifting easy, because a test that
 *   is all level-1 recall does not show whether a candidate is ready to drive;
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
  /** 1..5. Drives the difficulty spread of the paper. */
  difficulty: number;
  /**
   * Set when this question is a re-phrasing of another one. Two candidates sharing a group are
   * alternates: at most one of them may appear in a single attempt.
   */
  conceptGroupId: string | null;
  optionKeys: string[];
}

/**
 * Target share of each difficulty band in a paper.
 *
 * The official teoriprøven is not published as a difficulty blueprint, so this is our own
 * standard: a third straightforward rule-recall, a broad middle applying rules to ordinary
 * situations, a third that needs two rules or an exception. It is a preference, not a quota —
 * a thin pool fills what it can rather than failing to assemble a test.
 */
export const DIFFICULTY_TARGET: Record<DifficultyBand, number> = {
  easy: 0.3,
  medium: 0.4,
  hard: 0.3,
};

export type DifficultyBand = "easy" | "medium" | "hard";

export function bandOf(difficulty: number): DifficultyBand {
  if (difficulty <= 2) return "easy";
  if (difficulty === 3) return "medium";
  return "hard";
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
  /** What the paper actually came out as, per band — evidence, and a signal the pool is thin. */
  difficultyMix: Record<DifficultyBand, number>;
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
  const usedConceptGroups = new Set<string>();
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

  // Band budgets are whole-paper, not per topic: a topic with three questions cannot itself be
  // balanced, but the exam can.
  const bandBudget = allocateBandBudget(totalRequested);

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
      usedConceptGroups,
      bandBudget,
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

  const difficultyMix: Record<DifficultyBand, number> = {
    easy: 0,
    medium: 0,
    hard: 0,
  };
  for (const candidate of selected)
    difficultyMix[bandOf(candidate.difficulty)]++;

  return {
    questions,
    shortfall: totalRequested - questions.length,
    difficultyMix,
    warnings,
  };
}

/** Whole numbers of questions per band, largest-remainder so the parts sum to the total. */
function allocateBandBudget(total: number): Map<DifficultyBand, number> {
  const bands: DifficultyBand[] = ["easy", "medium", "hard"];
  const exact = bands.map((band) => ({
    band,
    exact: total * DIFFICULTY_TARGET[band],
  }));
  const budget = new Map<DifficultyBand, number>(
    exact.map((entry) => [entry.band, Math.floor(entry.exact)]),
  );
  let assigned = [...budget.values()].reduce((a, b) => a + b, 0);
  for (const entry of [...exact].sort(
    (a, b) => (b.exact % 1) - (a.exact % 1),
  )) {
    if (assigned >= total) break;
    budget.set(entry.band, (budget.get(entry.band) ?? 0) + 1);
    assigned++;
  }
  return budget;
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
  usedConceptGroups: Set<string>;
  bandBudget: Map<DifficultyBand, number>;
  warnings: string[];
  topicSlug: string;
}): VariantCandidate[] {
  const {
    rng,
    seenHashes,
    usedMasterIds,
    usedConceptGroups,
    bandBudget,
    warnings,
    topicSlug,
  } = ctx;

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

  const eligible = (c: VariantCandidate): boolean => {
    if (usedMasterIds.has(c.masterItemId)) return false;
    // A re-phrasing of something already on this paper is, to the student, the same question.
    if (c.conceptGroupId && usedConceptGroups.has(c.conceptGroupId))
      return false;
    return true;
  };

  const take = (from: VariantCandidate[], n: number): number => {
    let taken = 0;
    while (taken < n) {
      // Prefer a band the paper still owes questions to; within a band the pool order (a seeded
      // shuffle) decides, so the choice stays deterministic under `seed`.
      let choice: VariantCandidate | undefined;
      let bestNeed = -Infinity;
      for (const c of from) {
        if (!eligible(c)) continue;
        const need = bandBudget.get(bandOf(c.difficulty)) ?? 0;
        if (need > bestNeed) {
          bestNeed = need;
          choice = c;
          if (need > 0) break; // an owed band is good enough; no need to scan further
        }
      }
      if (!choice) break;

      usedMasterIds.add(choice.masterItemId);
      if (choice.conceptGroupId) usedConceptGroups.add(choice.conceptGroupId);
      const band = bandOf(choice.difficulty);
      bandBudget.set(band, Math.max(0, (bandBudget.get(band) ?? 0) - 1));
      picked.push(choice);
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
    const reused =
      take(tiers.seenOther, rest - filled) +
      take(tiers.seenImage, rest - filled);
    if (reused > 0)
      warnings.push(
        `${topicSlug}: pool thin — reused ${reused} seen variant(s)`,
      );
    filled += reused;
  }
  if (picked.length < ctx.count) {
    warnings.push(
      `${topicSlug}: pool exhausted — ${picked.length}/${ctx.count} assembled`,
    );
  }
  return picked;
}
