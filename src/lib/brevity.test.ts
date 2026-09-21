import { describe, expect, it } from "vitest";
import {
  brevityBudgetSentence,
  CEILING_RATIO,
  countSentences,
  countWords,
  scriptWordFactor,
  withinBudget,
  wordBudget,
  type BrevityTargets,
} from "./brevity";

const TARGETS: BrevityTargets = {
  stemWords: 15,
  optionWords: 8,
  explanationWords: 24,
  explanationSentences: 2,
  signMeaningWords: 12,
};

/**
 * The same sentence in eight scripts. These numbers are a MEASUREMENT of this runtime's ICU, not
 * an opinion — if one changes, the factor table in `brevity.ts` needs re-tuning, and this test is
 * what forces that to be a deliberate act rather than a silent drift.
 */
const SAME_SENTENCE: Array<[string, string, number]> = [
  ["en", "You must stop before the pedestrian crossing.", 7],
  ["nb", "Du må stoppe før gangfeltet.", 5],
  ["ar", "يجب أن تتوقف قبل ممر المشاة.", 6],
  ["bn", "পথচারী পারাপারের আগে আপনাকে থামতে হবে।", 6],
  ["ko", "보행자 횡단보도 앞에서 정차해야 합니다.", 5],
  ["th", "คุณต้องหยุดรถก่อนทางม้าลาย", 6],
  ["zh", "你必须在人行横道前停车", 8],
  ["ja", "歩行者横断歩道の前では必ず停止しなければなりません", 16],
];

describe("countWords", () => {
  it.each(SAME_SENTENCE)("counts %s at %i words", (locale, text, expected) => {
    expect(countWords(text, locale)).toBe(expected);
  });

  it("segments a space-less script rather than returning 1", () => {
    // The whole reason this module does not use split(/\s+/).
    expect(countWords("คุณต้องหยุดรถก่อนทางม้าลาย", "th")).toBeGreaterThan(3);
    expect("คุณต้องหยุดรถก่อนทางม้าลาย".split(/\s+/)).toHaveLength(1);
  });

  it("treats a Norwegian compound as one word, not as its length", () => {
    // A character budget would score this 18; a reader scores it 1.
    expect(countWords("vikepliktsskiltet", "nb")).toBe(1);
  });

  it("does not count punctuation", () => {
    expect(countWords("Stop! Give way.", "en")).toBe(3);
    expect(countWords("— you must stop —", "en")).toBe(3);
  });

  it("scores a compound unit as its parts, consistently", () => {
    // ICU treats "/" as a separator, so "km/h" is two word-like segments. That inflates a text
    // carrying units by a word or so. Left as-is rather than special-cased: it is consistent
    // across every locale, it errs toward brevity, and a unit table would be a second thing to
    // keep true. Recorded here so the behaviour is a decision and not a surprise.
    expect(countWords("50 km/h", "en")).toBe(3);
  });

  it("returns 0 for empty and whitespace input", () => {
    expect(countWords("", "en")).toBe(0);
    expect(countWords("   \n ", "en")).toBe(0);
  });

  it("does not throw on a malformed locale tag", () => {
    expect(() => countWords("You must stop.", "not a locale")).not.toThrow();
    expect(countWords("You must stop.", "not a locale")).toBe(3);
  });

  it("handles combining marks and emoji without crashing", () => {
    expect(() => countWords("আপনাকে 🚗 থামতে", "bn")).not.toThrow();
  });
});

describe("countSentences", () => {
  it("counts Latin terminators", () => {
    expect(countSentences("You must stop. Give way to the right.")).toBe(2);
    expect(countSentences("Really? Yes! Stop.")).toBe(3);
  });

  it("counts non-Latin terminators", () => {
    expect(countSentences("必ず停止する。右から来る車に道を譲る。")).toBe(2);
    expect(countSentences("আপনাকে থামতে হবে। ডান দিক থেকে আসা গাড়িকে পথ দিন।")).toBe(2);
  });

  it("does not treat an ellipsis as a terminator", () => {
    expect(countSentences("You must stop… then go")).toBe(1);
  });

  it("returns 1 for a script with no terminator — the reason words are enforced instead", () => {
    expect(countSentences("คุณต้องหยุดรถก่อนทางม้าลาย")).toBe(1);
  });

  it("returns 0 only for empty input", () => {
    expect(countSentences("  ")).toBe(0);
  });
});

describe("wordBudget", () => {
  it("returns the plain target for a 1.0-factor locale", () => {
    expect(wordBudget({ kind: "stem", locale: "en", targets: TARGETS })).toBe(15);
    expect(wordBudget({ kind: "option", locale: "nb", targets: TARGETS })).toBe(8);
    expect(wordBudget({ kind: "explanation", locale: "es", targets: TARGETS })).toBe(24);
  });

  it("gives a sign meaning its own, larger budget than an option", () => {
    const option = wordBudget({ kind: "option", locale: "en", targets: TARGETS });
    const sign = wordBudget({ kind: "signMeaning", locale: "en", targets: TARGETS });
    expect(sign).toBe(12);
    expect(sign).toBeGreaterThan(option);
  });

  it("scales by script factor", () => {
    expect(scriptWordFactor("ja")).toBe(2);
    expect(scriptWordFactor("en")).toBe(1);
    expect(wordBudget({ kind: "stem", locale: "ja", targets: TARGETS })).toBe(30);
  });

  it("applies the ceiling only in ceiling mode", () => {
    expect(
      wordBudget({ kind: "stem", locale: "en", targets: TARGETS, mode: "ceiling" }),
    ).toBe(Math.ceil(15 * CEILING_RATIO));
    expect(
      wordBudget({ kind: "option", locale: "en", targets: TARGETS, mode: "ceiling" }),
    ).toBe(Math.ceil(8 * CEILING_RATIO));
  });

  it("gives a translation slack over the source budget", () => {
    const source = wordBudget({ kind: "stem", locale: "de", targets: TARGETS });
    const translated = wordBudget({
      kind: "stem",
      locale: "de",
      targets: TARGETS,
      translation: true,
    });
    expect(translated).toBeGreaterThan(source);
    expect(translated).toBe(20);
  });

  it("treats a region subtag as its base language", () => {
    expect(wordBudget({ kind: "stem", locale: "ja-JP", targets: TARGETS })).toBe(30);
    expect(wordBudget({ kind: "stem", locale: "es-MX", targets: TARGETS })).toBe(15);
  });
});

describe("withinBudget", () => {
  it("passes at the boundary and fails one word past it", () => {
    const fifteen = Array.from({ length: 15 }, () => "word").join(" ");
    const sixteen = `${fifteen} word`;
    const at = { kind: "stem" as const, locale: "en", targets: TARGETS };
    expect(withinBudget(fifteen, at)).toBe(true);
    expect(withinBudget(sixteen, at)).toBe(false);
  });
});

describe("brevityBudgetSentence", () => {
  it("states the target language's own numbers", () => {
    // German gets slack but no script factor: 15*1.3, 8*1.3, 24*1.3.
    expect(brevityBudgetSentence("de", TARGETS, "German")).toBe(
      "For German that means about 20 words in a question, 11 in an option and 32 in an explanation.",
    );
  });

  it("scales for a morpheme-segmented script", () => {
    expect(brevityBudgetSentence("ja", TARGETS, "Japanese")).toContain("39 words in a question");
  });
});
