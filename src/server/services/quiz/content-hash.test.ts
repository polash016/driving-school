import { describe, expect, it } from "vitest";
import { computeContentHash } from "./content-hash";

const content = {
  en: {
    stem: "What is the speed limit?",
    options: [
      { key: "a", text: "50" },
      { key: "b", text: "60" },
    ],
  },
  nb: {
    stem: "Hva er fartsgrensen?",
    options: [
      { key: "a", text: "50" },
      { key: "b", text: "60" },
    ],
  },
};

describe("contentHash", () => {
  it("is stable regardless of option array order (presentation-independent)", () => {
    const reordered = {
      en: { ...content.en, options: [...content.en.options].reverse() },
      nb: { ...content.nb, options: [...content.nb.options].reverse() },
    };
    expect(computeContentHash("m1", content)).toBe(
      computeContentHash("m1", reordered),
    );
  });

  it("changes when any text changes", () => {
    const changed = {
      ...content,
      en: { ...content.en, stem: "What is the general speed limit?" },
    };
    expect(computeContentHash("m1", content)).not.toBe(
      computeContentHash("m1", changed),
    );
  });

  it("changes across master items (same surface text, different concept)", () => {
    expect(computeContentHash("m1", content)).not.toBe(
      computeContentHash("m2", content),
    );
  });
});
