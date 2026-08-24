import { describe, expect, it } from "vitest";
import { assembleQuiz, type VariantCandidate } from "./assembly";

function makePool(
  topicSlug: string,
  masters: number,
  variantsPerMaster: number,
  type: VariantCandidate["type"] = "TEXT",
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
        r1: [...makePool("r1", 10, 1, "TEXT"), ...makePool("r1x", 10, 1, "IMAGE").map((c) => ({ ...c, topicSlug: "r1", topicId: "r1-id" }))],
        r2: [...makePool("r2", 10, 1, "TEXT"), ...makePool("r2x", 10, 1, "IMAGE").map((c) => ({ ...c, topicSlug: "r2", topicId: "r2-id" }))],
      },
      seenHashes: new Set<string>(),
    };
    const { questions } = assembleQuiz(mixed);
    expect(questions.filter((q) => q.variantId.includes("x")).length).toBe(4); // 10 × 0.4
  });

  it("option order is a permutation of the candidate's keys", () => {
    const { questions } = assembleQuiz(richInput());
    for (const q of questions) {
      expect([...q.optionOrder].sort()).toEqual(["a", "b", "c", "d"]);
    }
  });
});
