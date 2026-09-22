import { describe, expect, it } from "vitest";
import {
  checkGotShorter,
  checkNumbersPreserved,
  checkStructuralIdentity,
  restoreTruncatedReferences,
  type QuestionContent,
} from "./simplify";

const previous: QuestionContent = {
  en: {
    stem: "You are driving on a road with a 50 km/h limit and approach a junction with no signs. Who has priority?",
    options: [
      { key: "a", text: "You do, because you are going straight ahead" },
      { key: "b", text: "Traffic approaching from your right" },
      { key: "c", text: "Traffic approaching from your left" },
    ],
    explanation:
      "With no signs or road markings the rule of the right applies, so you must give way to traffic approaching from your right. See § 7.",
  },
  nb: {
    stem: "Du kjorer pa en veg med fartsgrense 50 km/t og nermer deg et kryss uten skilt. Hvem har forkjorsrett?",
    options: [
      { key: "a", text: "Du, fordi du kjorer rett fram" },
      { key: "b", text: "Trafikk som kommer fra hoyre" },
      { key: "c", text: "Trafikk som kommer fra venstre" },
    ],
    explanation:
      "Uten skilt eller oppmerking gjelder hoyreregelen, sa du har vikeplikt for trafikk fra hoyre. Se § 7.",
  },
};

const shortened: QuestionContent = {
  en: {
    stem: "At an unmarked junction with a 50 km/h limit, who has priority?",
    options: [
      { key: "a", text: "You, going straight ahead" },
      { key: "b", text: "Traffic from your right" },
      { key: "c", text: "Traffic from your left" },
    ],
    explanation: "Unmarked junctions follow the rule of the right. Give way to the right. See § 7.",
  },
  nb: {
    stem: "I et uskiltet kryss med 50 km/t, hvem har forkjorsrett?",
    options: [
      { key: "a", text: "Du, rett fram" },
      { key: "b", text: "Trafikk fra hoyre" },
      { key: "c", text: "Trafikk fra venstre" },
    ],
    explanation: "Uskiltede kryss folger hoyreregelen. Vikeplikt for hoyre. Se § 7.",
  },
};

const clone = (c: QuestionContent): QuestionContent => JSON.parse(JSON.stringify(c));

describe("checkStructuralIdentity", () => {
  it("passes a faithful shortening", () => {
    expect(checkStructuralIdentity(previous, shortened, "b")).toEqual([]);
  });

  it("refuses a renamed option key", () => {
    const bad = clone(shortened);
    bad.en.options[1]!.key = "x";
    expect(checkStructuralIdentity(previous, bad, "b")).toContain("OPTION_KEYS_CHANGED");
  });

  it("refuses a REORDERED option set, not just a renamed one", () => {
    // Sorting before comparing would let this through. The engine serves one shuffled key order
    // to both locales, so a reorder makes the languages grade differently.
    const bad = clone(shortened);
    [bad.en.options[0], bad.en.options[1]] = [bad.en.options[1]!, bad.en.options[0]!];
    expect(checkStructuralIdentity(previous, bad, "b")).toContain("OPTION_KEYS_CHANGED");
  });

  it("refuses a dropped option", () => {
    const bad = clone(shortened);
    bad.en.options.pop();
    expect(checkStructuralIdentity(previous, bad, "b")).toContain("OPTION_COUNT_CHANGED");
  });

  it("refuses losing the correct key entirely", () => {
    const bad = clone(shortened);
    bad.en.options = bad.en.options.map((o) => (o.key === "b" ? { ...o, key: "d" } : o));
    bad.nb.options = bad.nb.options.map((o) => (o.key === "b" ? { ...o, key: "d" } : o));
    expect(checkStructuralIdentity(previous, bad, "b")).toContain("ANSWER_KEY_LOST");
  });

  it("refuses en and nb disagreeing on keys", () => {
    const bad = clone(shortened);
    bad.nb.options[2]!.key = "z";
    expect(checkStructuralIdentity(previous, bad, "b")).toContain("LOCALE_KEY_MISMATCH");
  });
});

describe("checkNumbersPreserved", () => {
  it("passes when every number and section survives", () => {
    expect(checkNumbersPreserved(previous, shortened, "b").findings).toEqual([]);
  });

  it("refuses a changed speed limit — the silent wrong answer", () => {
    const bad = clone(shortened);
    bad.en.stem = bad.en.stem.replace("50 km/h", "60 km/h");
    expect(checkNumbersPreserved(previous, bad, "b").findings).toContain("NUMBER_DRIFT");
  });

  it("refuses a dropped legal reference", () => {
    const bad = clone(shortened);
    bad.en.explanation = "Unmarked junctions follow the rule of the right.";
    expect(checkNumbersPreserved(previous, bad, "b").findings.length).toBeGreaterThan(0);
  });

  it("does not mistake mere shortening for drift", () => {
    const trimmed = clone(shortened);
    trimmed.en.explanation = "Give way to the right. See § 7.";
    trimmed.nb.explanation = "Vikeplikt for hoyre. Se § 7.";
    expect(checkNumbersPreserved(previous, trimmed, "b").findings).toEqual([]);
  });
});

describe("checkGotShorter", () => {
  it("reports a genuine shortening", () => {
    const result = checkGotShorter(previous, shortened);
    expect(result.shorter).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it("refuses a stem that grew", () => {
    const bad = clone(shortened);
    bad.en.stem = `${previous.en.stem} And what else must you consider before proceeding?`;
    expect(checkGotShorter(previous, bad).findings).toContain("STEM_GREW_EN");
  });

  it("refuses an option that grew", () => {
    const bad = clone(shortened);
    bad.en.options[0]!.text = "You do, because you happen to be going straight ahead today";
    expect(checkGotShorter(previous, bad).findings).toContain("OPTION_GREW_EN");
  });

  it("reports no gain when nothing moved", () => {
    const result = checkGotShorter(previous, clone(previous));
    expect(result.shorter).toBe(false);
    expect(result.findings).toEqual([]);
  });
});

/**
 * The number and reference cases seen on the real production bank (spec-22 full dry run).
 * Each string here is a `checks.drift` detail copied from a refused proposal.
 */
describe("number drift, as production actually produced it", () => {
  const q = (stem: string, explanation: string): QuestionContent => ({
    en: {
      stem,
      options: [
        { key: "a", text: "Yes" },
        { key: "b", text: "No" },
        { key: "c", text: "Sometimes" },
      ],
      explanation,
    },
    nb: {
      stem: "Kort?",
      options: [
        { key: "a", text: "Ja" },
        { key: "b", text: "Nei" },
        { key: "c", text: "Av og til" },
      ],
      explanation: "Kort forklaring.",
    },
  });

  it("REFUSES a changed speed limit — 80 became 50", () => {
    const before = q("The limit is 80 km/h. May you pass?", "See § 13 nr. 1.");
    const after = q("Limit 50 km/h. May you pass?", "See § 13 nr. 1.");
    const result = checkNumbersPreserved(before, after, "a");
    expect(result.findings).toContain("NUMBER_DRIFT");
    expect(result.details.join(" ")).toContain("lost [80]");
  });

  it("ALLOWS a repeated figure being said fewer times", () => {
    // "40 ... 40 ... 40" -> "40 ... 40" changed no value; the multiset check called this drift and
    // would have rejected a correct rewrite for the crime of being shorter.
    const before = q("At 40 km/h and 60 km/h, is 40 the limit?", "Both 40 and 60 apply. See § 4.");
    const after = q("At 40 and 60 km/h, which applies?", "40 and 60 apply. See § 4.");
    expect(checkNumbersPreserved(before, after, "a").findings).not.toContain("NUMBER_DRIFT");
  });

  it("REFUSES an invented number", () => {
    const before = q("Is there a limit?", "See § 7.");
    const after = q("Is the limit 90 km/h?", "See § 7.");
    const result = checkNumbersPreserved(before, after, "a");
    expect(result.findings).toContain("NUMBER_DRIFT");
    expect(result.details.join(" ")).toContain("invented [90]");
  });
});

describe("restoreTruncatedReferences", () => {
  const q = (explanation: string): QuestionContent => ({
    en: {
      stem: "Stem?",
      options: [{ key: "a", text: "A" }, { key: "b", text: "B" }, { key: "c", text: "C" }],
      explanation,
    },
    nb: {
      stem: "Stem?",
      options: [{ key: "a", text: "A" }, { key: "b", text: "B" }, { key: "c", text: "C" }],
      explanation: "Se § 15 nr. 5.",
    },
  });

  it("puts back the 'nr.' part the model dropped — the dominant production refusal", () => {
    const restored = restoreTruncatedReferences(q("Rule. See § 15 nr. 5."), q("Rule. See § 15."));
    expect(restored.en.explanation).toBe("Rule. See § 15 nr. 5.");
  });

  it("restores a hyphenated subsection too", () => {
    const restored = restoreTruncatedReferences(q("Rule. See § 13-3."), q("Rule. See § 13."));
    expect(restored.en.explanation).toBe("Rule. See § 13-3.");
  });

  it("leaves a complete reference alone", () => {
    const restored = restoreTruncatedReferences(q("Rule. See § 15 nr. 5."), q("Short. See § 15 nr. 5."));
    expect(restored.en.explanation).toBe("Short. See § 15 nr. 5.");
  });

  it("never invents a reference the original did not carry", () => {
    const restored = restoreTruncatedReferences(q("Rule, no reference at all."), q("Short. See § 9."));
    expect(restored.en.explanation).toBe("Short. See § 9.");
  });

  it("does not touch the stem or the options", () => {
    const before = q("Rule. See § 15 nr. 5.");
    const after = q("Rule. See § 15.");
    const restored = restoreTruncatedReferences(before, after);
    expect(restored.en.stem).toBe(after.en.stem);
    expect(restored.en.options).toEqual(after.en.options);
  });
});

describe("restoreTruncatedReferences — the reference dropped entirely", () => {
  const q = (explanation: string): QuestionContent => ({
    en: {
      stem: "Stem?",
      options: [{ key: "a", text: "A" }, { key: "b", text: "B" }, { key: "c", text: "C" }],
      explanation,
    },
    nb: {
      stem: "Stem?",
      options: [{ key: "a", text: "A" }, { key: "b", text: "B" }, { key: "c", text: "C" }],
      explanation: "Se § 15 nr. 5.",
    },
  });

  it("appends the reference when the model cut it out completely", () => {
    // The dominant remaining refusal: the whole citation is gone, so there is no bare section to
    // extend and the lost subsection number reads as number drift.
    const restored = restoreTruncatedReferences(
      q("Rule applies. See § 15 nr. 5."),
      q("Rule applies. Others are wrong."),
    );
    expect(restored.en.explanation).toBe("Rule applies. Others are wrong. § 15 nr. 5.");
  });

  it("does not double up the full stop", () => {
    const restored = restoreTruncatedReferences(q("R. See § 9 nr. 2."), q("Short."));
    expect(restored.en.explanation).not.toMatch(/\.\s*\.$/);
  });

  it("still appends nothing when the original had no reference", () => {
    const restored = restoreTruncatedReferences(q("No reference here."), q("Short."));
    expect(restored.en.explanation).toBe("Short.");
  });
});
