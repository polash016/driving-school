import { describe, expect, it } from "vitest";
import { blockingCodes, checkTranslation, NOT_A_QUALITY_FLAG } from "@/server/services/i18n/validation";
import { isReQaOnly } from "@/server/services/i18n/repair";

const source = {
  stem: "You are on a priority road. Must you give way to traffic from the right?",
  options: [
    { key: "a", text: "Yes, always" },
    { key: "b", text: "No" },
    { key: "c", text: "Only in a town" },
  ],
  explanation: "A priority road means the crossing traffic gives way to you.",
};

const de = (mult: number) => ({
  stem: Array.from({ length: Math.round(14 * mult) }, () => "Wort").join(" ") + "?",
  options: source.options.map((o) => ({ key: o.key, text: o.text })),
  explanation: source.explanation,
});

describe("VERBOSE (spec-22)", () => {
  it("does not fire on a German translation half again as long as the source", () => {
    const check = checkTranslation({ entity: "MASTER_ITEM", locale: "de", source, translated: de(1.4) });
    expect(check.issues.map((i) => i.code)).not.toContain("VERBOSE");
  });

  it("fires well past the budget, and never blocks", () => {
    const check = checkTranslation({ entity: "MASTER_ITEM", locale: "de", source, translated: de(3) });
    const verbose = check.issues.find((i) => i.code === "VERBOSE");
    expect(verbose).toBeDefined();
    expect(verbose?.blocking).toBe(false);
    expect(blockingCodes(check)).not.toContain("VERBOSE");
    expect(check.passed).toBe(true);
  });

  it("is never chased by auto-repair", () => {
    expect(NOT_A_QUALITY_FLAG.has("VERBOSE")).toBe(true);
    expect(isReQaOnly(["VERBOSE"])).toBe(true);
  });

  it("gives a morpheme-segmented script its script factor", () => {
    // 30 Japanese "words" is inside ja's budget (15 x 2.0 x 1.3 x 1.4) but far past en's.
    const ja = { ...source, stem: Array.from({ length: 30 }, () => "停").join("") };
    const check = checkTranslation({ entity: "MASTER_ITEM", locale: "ja", source, translated: ja });
    expect(check.issues.map((i) => i.code)).not.toContain("VERBOSE");
  });
});
