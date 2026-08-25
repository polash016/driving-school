import { describe, expect, it } from "vitest";
import { createRng, nextInt, shuffle } from "./rng";

describe("seeded rng", () => {
  it("is deterministic for the same seed", () => {
    const a = createRng("seed-1");
    const b = createRng("seed-1");
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it("diverges for different seeds", () => {
    const a = createRng("seed-1");
    const b = createRng("seed-2");
    expect([a(), a(), a()]).not.toEqual([b(), b(), b()]);
  });

  it("nextInt stays in range", () => {
    const rng = createRng("range");
    for (let i = 0; i < 1000; i++) {
      const v = nextInt(rng, 7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
    }
  });

  it("shuffle returns a permutation and never mutates the input", () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const frozen = Object.freeze([...input]);
    const out = shuffle(createRng("perm"), frozen);
    expect([...out].sort((a, b) => a - b)).toEqual(input);
    expect(frozen).toEqual(input);
  });

  it("shuffle is deterministic per seed and differs across seeds", () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    expect(shuffle(createRng("s1"), items)).toEqual(
      shuffle(createRng("s1"), items),
    );
    expect(shuffle(createRng("s1"), items)).not.toEqual(
      shuffle(createRng("s2"), items),
    );
  });
});
