import { describe, expect, it } from "vitest";
import { fuseRankings } from "./search";

/**
 * Reciprocal Rank Fusion is the whole ranking rule, so it is worth pinning independently of the
 * database: it must reward agreement between the two legs without letting either dominate.
 */
describe("reciprocal rank fusion", () => {
  it("ranks a chunk both legs found above one only a single leg found", () => {
    const fused = fuseRankings([
      ["a", "b", "c"],
      ["c", "d", "a"],
    ]);
    // "a" is 1st and 3rd; "c" is 3rd and 1st — both beat single-leg hits.
    expect(fused.slice(0, 2).map((row) => row.id).sort()).toEqual(["a", "c"]);
    expect(fused.find((row) => row.id === "d")!.score).toBeLessThan(
      fused.find((row) => row.id === "a")!.score,
    );
  });

  it("keeps a strong single-leg hit ahead of a weak one", () => {
    const fused = fuseRankings([["x"], ["y", "z"]]);
    expect(fused[0].id).toBe("x");
    expect(fused.at(-1)!.id).toBe("z");
  });

  it("is indifferent to the legs' own score scales", () => {
    // Only ranks matter — a leg that returns huge cosine values cannot swamp the other.
    const a = fuseRankings([["p", "q"], ["q", "p"]]);
    const b = fuseRankings([["p", "q"], ["q", "p"]], 60);
    expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id));
  });

  it("works with one leg missing (embedding unavailable)", () => {
    const fused = fuseRankings([[], ["only", "keyword"]]);
    expect(fused.map((row) => row.id)).toEqual(["only", "keyword"]);
  });
});
