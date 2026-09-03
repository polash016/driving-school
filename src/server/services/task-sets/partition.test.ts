import { describe, expect, it } from "vitest";
import { partitionBank, type PartitionItem } from "./partition";

function bank(
  count: number,
  topics = ["signs", "yield", "vehicle"],
): PartitionItem[] {
  return Array.from({ length: count }, (_, i) => ({
    masterItemId: `m${String(i).padStart(4, "0")}`,
    topicSlug: topics[i % topics.length],
    type: i % 7 === 0 ? "IMAGE" : i % 5 === 0 ? "SIGN" : "TEXT",
    difficulty: (i % 5) + 1,
  }));
}

const OPTIONS = { paperSize: 45, poolRatio: 1.5 };

describe("partitionBank", () => {
  it("places every item in exactly one slice", () => {
    const result = partitionBank(bank(300), OPTIONS);
    const placed = result.slices.flatMap((s) => s.masterItemIds);
    expect(placed).toHaveLength(300);
    expect(new Set(placed).size).toBe(300);
    expect(result.orphaned).toEqual([]);
  });

  it("sizes full slices at ceil(paperSize * poolRatio)", () => {
    const result = partitionBank(bank(300), OPTIONS);
    expect(result.slices[0].masterItemIds).toHaveLength(68);
  });

  it("merges a remainder smaller than half a paper into the previous slice", () => {
    // 68 + 68 + 10 → the 10 fold back: a 10-question "mock exam" misreports readiness.
    const result = partitionBank(bank(146), OPTIONS);
    expect(result.slices).toHaveLength(2);
    expect(result.slices[1].masterItemIds).toHaveLength(78);
  });

  it("keeps a remainder of half a paper or more as its own slice", () => {
    const result = partitionBank(bank(160), OPTIONS);
    expect(result.slices).toHaveLength(3);
    expect(result.slices[2].masterItemIds).toHaveLength(24);
  });

  it("spreads topics rather than filling a slice from one topic", () => {
    const result = partitionBank(bank(300), OPTIONS);
    for (const slice of result.slices) {
      expect(
        Object.keys(slice.composition.topicCounts).length,
      ).toBeGreaterThan(1);
    }
  });

  it("numbers slices from 1 upwards with no gaps", () => {
    const result = partitionBank(bank(300), OPTIONS);
    expect(result.slices.map((s) => s.number)).toEqual([1, 2, 3, 4, 5]);
  });

  it("preserves the number of a slice whose membership is unchanged", () => {
    const items = bank(136);
    const first = partitionBank(items, OPTIONS);
    const second = partitionBank(items, {
      ...OPTIONS,
      existing: first.slices.map((s) => ({
        number: s.number,
        masterItemIds: s.masterItemIds,
      })),
    });
    expect(second.slices.map((s) => s.number)).toEqual(
      first.slices.map((s) => s.number),
    );
    expect(second.slices[0].masterItemIds).toEqual(
      first.slices[0].masterItemIds,
    );
  });

  it("is deterministic: the same bank produces the same slices", () => {
    const items = bank(200);
    const a = partitionBank(items, OPTIONS);
    const b = partitionBank([...items].reverse(), OPTIONS);
    expect(b.slices.map((s) => s.masterItemIds)).toEqual(
      a.slices.map((s) => s.masterItemIds),
    );
  });

  it("warns when a slice holds no image or sign questions", () => {
    const textOnly: PartitionItem[] = Array.from({ length: 68 }, (_, i) => ({
      masterItemId: `t${String(i).padStart(4, "0")}`,
      topicSlug: i % 2 ? "signs" : "yield",
      type: "TEXT",
      difficulty: 3,
    }));
    const result = partitionBank(textOnly, OPTIONS);
    expect(result.slices[0].composition.warnings).toContain(
      "NO_VISUAL_QUESTIONS",
    );
  });

  it("warns when a slice draws from a single topic", () => {
    const oneTopic: PartitionItem[] = Array.from({ length: 60 }, (_, i) => ({
      masterItemId: `s${String(i).padStart(4, "0")}`,
      topicSlug: "signs",
      type: "SIGN",
      difficulty: 3,
    }));
    const result = partitionBank(oneTopic, OPTIONS);
    expect(result.slices[0].composition.warnings).toContain("SINGLE_TOPIC");
  });

  it("records composition counts and average difficulty", () => {
    const result = partitionBank(bank(68), OPTIONS);
    const { composition } = result.slices[0];
    const topicTotal = Object.values(composition.topicCounts).reduce(
      (a, b) => a + b,
      0,
    );
    expect(topicTotal).toBe(68);
    expect(composition.avgDifficulty).toBeGreaterThan(0);
    expect(composition.avgDifficulty).toBeLessThanOrEqual(5);
  });

  it("returns an empty result for an empty bank rather than throwing", () => {
    expect(partitionBank([], OPTIONS)).toEqual({ slices: [], orphaned: [] });
  });

  it("keeps a bank smaller than one pool as a single slice", () => {
    const result = partitionBank(bank(12), OPTIONS);
    expect(result.slices).toHaveLength(1);
    expect(result.slices[0].masterItemIds).toHaveLength(12);
    expect(result.slices[0].number).toBe(1);
  });
});
