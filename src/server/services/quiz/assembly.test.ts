import { describe, expect, it } from "vitest";
import { assembleQuiz, type VariantCandidate } from "./assembly";

function makePool(
  topicSlug: string,
  masters: number,
  variantsPerMaster: number,
  type: VariantCandidate["type"] = "TEXT",
  options: {
    conceptGroupId?: (master: number) => string | null;
    difficulty?: (master: number) => number;
  } = {},
): VariantCandidate[] {
  const out: VariantCandidate[] = [];
  for (let m = 0; m < masters; m++) {
    for (let v = 0; v < variantsPerMaster; v++) {
      out.push({
        variantId: `${topicSlug}-m${m}-v${v}`,
        masterItemId: `${topicSlug}-m${m}`,
        contentHash: `hash-${topicSlug}-m${m}-v${v}`,
        type,
        topicSlug,
        topicId: `${topicSlug}-id`,
        difficulty: options.difficulty?.(m) ?? (m % 5) + 1,
        conceptGroupId: options.conceptGroupId?.(m) ?? null,
        optionKeys: ["a", "b", "c", "d"],
      });
    }
  }
  return out;
}

const richInput = () => ({
  seed: "seed-A",
  distribution: { r1: 3, r2: 3 },
  imageRatio: 0,
  candidatesByTopic: {
    r1: makePool("r1", 20, 3),
    r2: makePool("r2", 20, 3),
  },
  seenHashes: new Set<string>(),
});

describe("assembleQuiz", () => {
  it("same seed → byte-identical assembly (variants, order, option orders)", () => {
    const a = assembleQuiz(richInput());
    const b = assembleQuiz(richInput());
    expect(a).toEqual(b);
  });

  it("different seeds → different variants/order/option orders (two users same second)", () => {
    const a = assembleQuiz(richInput());
    const b = assembleQuiz({ ...richInput(), seed: "seed-B" });
    expect(a.questions.map((q) => q.variantId)).not.toEqual(
      b.questions.map((q) => q.variantId),
    );
    expect(a.questions.map((q) => q.optionOrder)).not.toEqual(
      b.questions.map((q) => q.optionOrder),
    );
  });

  it("fills the blueprint exactly and respects the distribution", () => {
    const { questions, shortfall } = assembleQuiz(richInput());
    expect(shortfall).toBe(0);
    expect(questions).toHaveLength(6);
    expect(questions.filter((q) => q.topicSlug === "r1")).toHaveLength(3);
    expect(questions.filter((q) => q.topicSlug === "r2")).toHaveLength(3);
    // positions are 1..N after the global shuffle
    expect(questions.map((q) => q.position)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("never uses the same master item twice, even across variants", () => {
    const { questions } = assembleQuiz(richInput());
    const masters = questions.map((q) => q.masterItemId);
    expect(new Set(masters).size).toBe(masters.length);
  });

  it("excludes seen hashes when the pool allows it", () => {
    const input = richInput();
    const firstRun = assembleQuiz(input);
    const seen = new Set(firstRun.questions.map((q) => q.contentHash));
    const second = assembleQuiz({ ...input, seed: "seed-C", seenHashes: seen });
    for (const q of second.questions) {
      expect(seen.has(q.contentHash)).toBe(false);
    }
    expect(second.warnings).toHaveLength(0);
  });

  it("falls back to seen variants WITH a warning when the pool is thin", () => {
    const thin = {
      seed: "seed-D",
      distribution: { r1: 3 },
      imageRatio: 0,
      candidatesByTopic: { r1: makePool("r1", 3, 1) },
      seenHashes: new Set(["hash-r1-m0-v0", "hash-r1-m1-v0", "hash-r1-m2-v0"]),
    };
    const result = assembleQuiz(thin);
    expect(result.questions).toHaveLength(3); // still fills — reuse over failure
    expect(result.warnings.some((w) => w.includes("reused"))).toBe(true);
  });

  it("reports shortfall when the pool is exhausted", () => {
    const result = assembleQuiz({
      seed: "s",
      distribution: { r1: 5 },
      imageRatio: 0,
      candidatesByTopic: { r1: makePool("r1", 2, 2) }, // only 2 distinct masters
      seenHashes: new Set(),
    });
    expect(result.questions).toHaveLength(2);
    expect(result.shortfall).toBe(3);
    expect(result.warnings.some((w) => w.includes("exhausted"))).toBe(true);
  });

  it("hits the image ratio when the pool has both types", () => {
    const mixed = {
      seed: "seed-E",
      distribution: { r1: 5, r2: 5 },
      imageRatio: 0.4,
      candidatesByTopic: {
        r1: [
          ...makePool("r1", 10, 1, "TEXT"),
          ...makePool("r1x", 10, 1, "IMAGE").map((c) => ({
            ...c,
            topicSlug: "r1",
            topicId: "r1-id",
          })),
        ],
        r2: [
          ...makePool("r2", 10, 1, "TEXT"),
          ...makePool("r2x", 10, 1, "IMAGE").map((c) => ({
            ...c,
            topicSlug: "r2",
            topicId: "r2-id",
          })),
        ],
      },
      seenHashes: new Set<string>(),
    };
    const { questions } = assembleQuiz(mixed);
    expect(questions.filter((q) => q.variantId.includes("x")).length).toBe(4); // 10 × 0.4
  });

  it("never puts two phrasings of the same point on one paper", () => {
    // Ten masters, all alternates of each other: exactly one may be served.
    const pool = makePool("r1", 10, 1, "TEXT", {
      conceptGroupId: () => "group-speed",
    });
    const { questions, shortfall } = assembleQuiz({
      seed: "seed-concept",
      distribution: { r1: 5 },
      imageRatio: 0,
      candidatesByTopic: { r1: pool },
      seenHashes: new Set<string>(),
    });
    expect(questions).toHaveLength(1);
    expect(shortfall).toBe(4);
  });

  it("alternates of different points still fill a paper", () => {
    const pool = makePool("r1", 10, 1, "TEXT", {
      conceptGroupId: (master) => `group-${master}`,
    });
    const { questions } = assembleQuiz({
      seed: "seed-concept-2",
      distribution: { r1: 5 },
      imageRatio: 0,
      candidatesByTopic: { r1: pool },
      seenHashes: new Set<string>(),
    });
    expect(questions).toHaveLength(5);
    expect(new Set(questions.map((q) => q.masterItemId)).size).toBe(5);
  });

  it("spreads the paper across difficulty bands instead of drifting easy", () => {
    // 30 masters per band, so the target mix is reachable and any drift is the picker's own.
    const easy = makePool("r1", 30, 1, "TEXT", { difficulty: () => 1 });
    const medium = makePool("r1m", 30, 1, "TEXT", { difficulty: () => 3 }).map(
      (c) => ({
        ...c,
        topicSlug: "r1",
        topicId: "r1-id",
      }),
    );
    const hard = makePool("r1h", 30, 1, "TEXT", { difficulty: () => 5 }).map(
      (c) => ({
        ...c,
        topicSlug: "r1",
        topicId: "r1-id",
      }),
    );
    const { questions, difficultyMix } = assembleQuiz({
      seed: "seed-difficulty",
      distribution: { r1: 45 },
      imageRatio: 0,
      candidatesByTopic: { r1: [...easy, ...medium, ...hard] },
      seenHashes: new Set<string>(),
    });
    expect(questions).toHaveLength(45);
    // 45 × (0.3 / 0.4 / 0.3) — exact, because the pool can supply every band.
    expect(difficultyMix).toEqual({ easy: 14, medium: 18, hard: 13 });
  });

  it("a pool with only easy questions still assembles a full paper", () => {
    const { questions, difficultyMix, shortfall } = assembleQuiz({
      seed: "seed-difficulty-thin",
      distribution: { r1: 10 },
      imageRatio: 0,
      candidatesByTopic: {
        r1: makePool("r1", 20, 1, "TEXT", { difficulty: () => 1 }),
      },
      seenHashes: new Set<string>(),
    });
    expect(questions).toHaveLength(10);
    expect(shortfall).toBe(0);
    expect(difficultyMix).toEqual({ easy: 10, medium: 0, hard: 0 });
  });

  it("option order is a permutation of the candidate's keys", () => {
    const { questions } = assembleQuiz(richInput());
    for (const q of questions) {
      expect([...q.optionOrder].sort()).toEqual(["a", "b", "c", "d"]);
    }
  });
});
