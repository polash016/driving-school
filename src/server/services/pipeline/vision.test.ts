import { describe, expect, it } from "vitest";
import {
  agreedSigns,
  cropRect,
  discriminationCandidates,
  normaliseBbox,
} from "./vision";

/**
 * The parts of the extraction that decide whether a sign survives. Tested without spending a
 * vision call, because these rules — not the model — are what stop a confident hallucination.
 */
const bbox = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

describe("agreedSigns", () => {
  it("keeps a sign two of three readings agree on", () => {
    const kept = agreedSigns([
      [{ code: "202", confidence: 0.9 }],
      [{ code: "202", confidence: 0.7 }],
      [],
    ]);
    expect(kept.map((s) => s.code)).toEqual(["202"]);
    expect(kept[0].agreement).toBe(2);
  });

  it("drops a sign only one reading saw — the shape a hallucination takes", () => {
    // And it drops it however sure the model claimed to be: on this deployment's own model a wrong
    // identification came back at 0.95, so confidence cannot be the thing that decides.
    expect(
      agreedSigns([[{ code: "362", confidence: 0.99 }], [], []]).map(
        (s) => s.code,
      ),
    ).toEqual([]);
  });

  it("does not let one reading out-vote itself by repeating a sign", () => {
    expect(
      agreedSigns([
        [
          { code: "204", confidence: 0.9 },
          { code: "204", confidence: 0.9 },
        ],
        [],
        [],
      ]),
    ).toEqual([]);
  });

  it("averages confidence for display and carries the first reported box", () => {
    const [sign] = agreedSigns([
      [{ code: "100", confidence: 1, bbox: bbox(0.1, 0.1, 0.2, 0.2) }],
      [{ code: "100", confidence: 0.5 }],
      [{ code: "100", confidence: 0.6 }],
    ]);
    expect(sign.confidence).toBeCloseTo(0.7, 5);
    expect(sign.bbox).toEqual(bbox(0.1, 0.1, 0.2, 0.2));
  });

  it("honours a stricter quorum", () => {
    const passes = [
      [{ code: "302", confidence: 1 }],
      [{ code: "302", confidence: 1 }],
      [],
    ];
    expect(agreedSigns(passes, 2)).toHaveLength(1);
    expect(agreedSigns(passes, 3)).toHaveLength(0);
  });
});

describe("cropRect", () => {
  it("pads the reported box generously, because the boxes are approximate", () => {
    // Measured against known sign positions, one box was ~10% of image width out — enough that a
    // tight crop sliced the sign in half, which is what makes discrimination answer "none".
    // 40% of a 0.2-wide box on a 1000px image = 80px added per side.
    const rect = cropRect(bbox(0.4, 0.4, 0.2, 0.2), 1000, 1000);
    expect(rect).toEqual({ left: 320, top: 320, width: 360, height: 360 });
  });

  it("clamps to the image rather than asking sharp for pixels that do not exist", () => {
    const rect = cropRect(bbox(0, 0, 1, 1), 800, 600)!;
    expect(rect).toEqual({ left: 0, top: 0, width: 800, height: 600 });
  });

  it("refuses a region too small to tell one sign from another", () => {
    expect(cropRect(bbox(0.5, 0.5, 0.01, 0.01), 1000, 1000)).toBeNull();
  });
});

describe("normaliseBbox", () => {
  it("reads the [y, x, h, w] array a model actually returns", () => {
    // Verified against a scene with known sign positions: y-first fits with about a third of the
    // error of x-first, and ymin/ymax orderings come out inverted.
    expect(normaliseBbox([0.264, 0.687, 0.179, 0.23])).toEqual({
      x: 0.687,
      y: 0.264,
      w: 0.23,
      h: 0.179,
    });
  });

  it("rescales the 0-1000 grid the same model sometimes uses instead", () => {
    // Same model, same picture, minutes apart — so the scale has to be detected, not assumed.
    expect(normaliseBbox([[264, 687, 179, 230]])).toEqual({
      x: 0.687,
      y: 0.264,
      w: 0.23,
      h: 0.179,
    });
  });

  it("treats a full-frame fractional box as fractions, not thousandths", () => {
    expect(normaliseBbox([0, 0, 1, 1])).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it("unwraps the extra nesting Gemini adds", () => {
    expect(normaliseBbox([[0.1, 0.2, 0.3, 0.4]])).toEqual({
      x: 0.2,
      y: 0.1,
      w: 0.4,
      h: 0.3,
    });
  });

  it("leaves the requested object form alone", () => {
    const box = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
    expect(normaliseBbox(box)).toEqual(box);
  });

  it("passes anything else through for the schema to reject", () => {
    expect(normaliseBbox([1, 2, 3])).toEqual([1, 2, 3]);
    expect(normaliseBbox("nonsense")).toBe("nonsense");
  });
});

describe("discriminationCandidates", () => {
  const registry = [
    {
      code: "A1",
      name: "a1",
      signClass: "FARE" as const,
      svgPath: "/signs/A1.png",
    },
    {
      code: "A2",
      name: "a2",
      signClass: "FARE" as const,
      svgPath: "/signs/A2.png",
    },
    {
      code: "A3",
      name: "a3",
      signClass: "FARE" as const,
      svgPath: "/signs/A3.png",
    },
    {
      code: "A4",
      name: "a4",
      signClass: "FARE" as const,
      svgPath: "/signs/A4.png",
    },
    {
      code: "A5",
      name: "a5",
      signClass: "FARE" as const,
      svgPath: "/signs/A5.png",
    },
    {
      code: "B1",
      name: "b1",
      signClass: "FORBUD" as const,
      svgPath: "/signs/B1.png",
    },
  ];
  const claimed = registry[0];

  it("draws distractors from the claimed sign's OWN class", () => {
    // Within-class confusion is the failure this pass exists to catch; a sign from another class
    // is distinguishable on shape and colour alone and would make the check trivially passable.
    const picked = discriminationCandidates(claimed, registry, "seed");
    expect(picked.every((sign) => sign.signClass === "FARE")).toBe(true);
    expect(picked.map((s) => s.code)).toContain("A1");
    expect(picked).toHaveLength(5);
  });

  it("is deterministic for a seed but does not always put the answer first", () => {
    const a = discriminationCandidates(claimed, registry, "x").map(
      (s) => s.code,
    );
    expect(
      discriminationCandidates(claimed, registry, "x").map((s) => s.code),
    ).toEqual(a);

    const positions = new Set(
      ["s1", "s2", "s3", "s4", "s5", "s6"].map((seed) =>
        discriminationCandidates(claimed, registry, seed).findIndex(
          (s) => s.code === "A1",
        ),
      ),
    );
    expect(positions.size).toBeGreaterThan(1);
  });

  it("copes with a class too small to fill the candidate list", () => {
    const tiny = [claimed, registry[5]];
    expect(
      discriminationCandidates(claimed, tiny, "seed").map((s) => s.code),
    ).toEqual(["A1"]);
  });
});
