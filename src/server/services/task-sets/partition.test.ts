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

  it("makes every slice at least one pool deep", () => {
    // FLOOR sizing: 300 items at pool 68 is 4 slices of 75, not 4 of 68 plus a 28-question stub.
    const result = partitionBank(bank(300), OPTIONS);
    expect(result.slices).toHaveLength(4);
    for (const slice of result.slices) {
      expect(slice.masterItemIds.length).toBeGreaterThanOrEqual(68);
    }
  });

  it("absorbs the remainder rather than publishing a short slice", () => {
    // 146 at pool 68 → 2 slices of 73. A 10-question "mock exam" would misreport readiness.
    const result = partitionBank(bank(146), OPTIONS);
    expect(result.slices).toHaveLength(2);
    expect(result.slices.map((s) => s.masterItemIds.length)).toEqual([73, 73]);
  });

  it("keeps slice sizes within one of each other", () => {
    const result = partitionBank(bank(205), OPTIONS);
    const sizes = result.slices.map((s) => s.masterItemIds.length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
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
    expect(result.slices.map((s) => s.number)).toEqual([1, 2, 3, 4]);
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

  /**
   * Regression: the real bank is 574 sign questions against 130 of everything else. A round-robin
   * that drains buckets exhausts the small topics in the first slices and leaves the tail
   * single-topic — sign quizzes wearing a mock exam's name. Every slice must mirror the mix.
   */
  it("spreads a dominant topic across every slice instead of exhausting the small ones", () => {
    const lopsided: PartitionItem[] = [
      ...Array.from({ length: 574 }, (_, i) => ({
        masterItemId: `sign${String(i).padStart(4, "0")}`,
        topicSlug: "signs",
        type: "SIGN" as const,
        difficulty: (i % 5) + 1,
      })),
      ...Array.from({ length: 130 }, (_, i) => ({
        masterItemId: `text${String(i).padStart(4, "0")}`,
        topicSlug: ["yield", "vehicle", "speed", "law"][i % 4],
        type: "TEXT" as const,
        difficulty: (i % 5) + 1,
      })),
    ];

    const result = partitionBank(lopsided, OPTIONS);

    expect(result.slices.length).toBeGreaterThan(1);
    for (const slice of result.slices) {
      // No slice may be a single-topic set…
      expect(Object.keys(slice.composition.topicCounts).length).toBeGreaterThan(1);
      expect(slice.composition.warnings).not.toContain("SINGLE_TOPIC");
      // …and each must carry a real share of the non-dominant material.
      const nonSign = slice.masterItemIds.length - (slice.composition.topicCounts.signs ?? 0);
      expect(nonSign).toBeGreaterThan(5);
    }
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
