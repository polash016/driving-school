import { describe, expect, it } from "vitest";
import {
  checkGotShorter,
  checkNumbersPreserved,
  checkStructuralIdentity,
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
