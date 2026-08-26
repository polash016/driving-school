import { describe, expect, it } from "vitest";
import { mergeName, mergeQuestion, servableStatuses } from "./resolve";
import { hashUnit, memoryHash, payloadStrings } from "./units";
import { blockingCodes, checkTranslation } from "./validation";
import type { QuestionPayload } from "./units";

/**
 * The translation pipeline's safety properties (spec-15).
 *
 * Every case here is a way a translated exam could go wrong quietly — which is the only way it
 * ever would, since nobody reviewing in English can see a mistranslation.
 */

const source: QuestionPayload = {
  stem: "The sign says 80 km/h and the road is wet. What speed should you drive?",
  options: [
    { key: "a", text: "80 km/h, the signposted limit" },
    { key: "b", text: "A speed adapted to the conditions, below the limit" },
    { key: "c", text: "Exactly 60 km/h" },
  ],
  explanation:
    "Under trafikkreglene § 11 no. 1 you must adapt your speed to the conditions.",
};

const good: QuestionPayload = {
  stem: "La señal indica 80 km/h y la carretera está mojada. ¿Qué velocidad debes llevar?",
  options: [
    { key: "a", text: "80 km/h, tal como indica la señal" },
    {
      key: "b",
      text: "Una velocidad adaptada a las condiciones, por debajo del límite",
    },
    { key: "c", text: "Exactamente 60 km/h" },
  ],
  explanation:
    "Según trafikkreglene § 11 no. 1 debes adaptar la velocidad a las condiciones.",
};

function check(translated: QuestionPayload, locale = "es") {
  return checkTranslation({
    entity: "MASTER_ITEM",
    locale,
    source,
    translated,
    correctOptionKey: "b",
  });
}

describe("the deterministic translation gate", () => {
  it("passes a faithful translation", () => {
    expect(check(good).passed).toBe(true);
  });

  it("refuses a changed speed limit — the error that would mark a right answer wrong", () => {
    const drifted = {
      ...good,
      options: good.options.map((option) =>
        option.key === "a"
          ? { ...option, text: "60 km/h, tal como indica la señal" }
          : option,
      ),
    };
    expect(blockingCodes(check(drifted))).toContain("NUMBER_DRIFT");
  });

  it("refuses a renamed option key — the keys are how the languages stay gradable together", () => {
    const renamed = {
      ...good,
      options: good.options.map((option) =>
        option.key === "c" ? { ...option, key: "d" } : option,
      ),
    };
    const result = check(renamed);
    expect(blockingCodes(result)).toContain("KEY_MISMATCH");
    expect(result.passed).toBe(false);
  });

  it("refuses a dropped option", () => {
    const dropped = { ...good, options: good.options.slice(0, 2) };
    expect(blockingCodes(check(dropped))).toContain("OPTION_COUNT");
  });

  it("refuses a translation that lost the option the answer key points at", () => {
    const lost = {
      ...good,
      options: good.options.map((option) =>
        option.key === "b" ? { ...option, key: "z" } : option,
      ),
    };
    expect(blockingCodes(check(lost))).toContain("ANSWER_KEY_LOST");
  });

  it("refuses a translated legal reference — a § is an address, not prose", () => {
    const mangled = {
      ...good,
      explanation:
        "Según las reglas de tráfico artículo 11 número 1 debes adaptar la velocidad.",
    };
    expect(blockingCodes(check(mangled))).toContain("CITATION_DRIFT");
  });

  it("refuses output that is just the input echoed back", () => {
    expect(blockingCodes(check(source))).toContain("UNTRANSLATED");
  });

  it("refuses Latin text for a language that does not use it", () => {
    // A model that answers in English for an Arabic request is a silent, total failure.
    expect(
      blockingCodes(
        checkTranslation({
          entity: "MASTER_ITEM",
          locale: "ar",
          source,
          translated: good,
        }),
      ),
    ).toContain("UNTRANSLATED");
  });

  it("refuses a dropped ICU placeholder — that is a crash, not a typo", () => {
    const result = checkTranslation({
      entity: "UI_MESSAGE",
      locale: "es",
      source: { text: "Question {current} of {total}" },
      translated: { text: "Pregunta {current} de" },
    });
    expect(blockingCodes(result)).toContain("PLACEHOLDER_LOST");
  });

  it("does not cry untranslated over a string with nothing to translate", () => {
    // "{count} min" is correctly identical in Spanish. A check that flags correct work is worse
    // than no check, because reviewers learn to ignore it.
    const result = checkTranslation({
      entity: "UI_MESSAGE",
      locale: "es",
      source: { text: "{count} min" },
      translated: { text: "{count} min" },
    });
    expect(result.passed).toBe(true);
    expect(blockingCodes(result)).not.toContain("UNTRANSLATED");
  });

  it("still catches a real echo, where there was plenty to translate", () => {
    const result = checkTranslation({
      entity: "UI_MESSAGE",
      locale: "es",
      source: { text: "Your driving school will send you an invitation." },
      translated: { text: "Your driving school will send you an invitation." },
    });
    expect(blockingCodes(result)).toContain("UNTRANSLATED");
  });

  it("accepts a placeholder that moved within the sentence", () => {
    const result = checkTranslation({
      entity: "UI_MESSAGE",
      locale: "es",
      source: { text: "{count} waiting" },
      translated: { text: "En espera: {count}" },
    });
    expect(result.passed).toBe(true);
  });

  it("warns, but does not block, when a translation has clearly lost content", () => {
    // Whole-unit length, not per-field: a stem trimmed while the options stay full is normal,
    // a unit that came back a fifth of its size has dropped something.
    const result = checkTranslation({
      entity: "UI_MESSAGE",
      locale: "es",
      source: {
        text: "Your driving school will send you an invitation so you can get started with practice.",
      },
      translated: { text: "Empieza." },
    });
    expect(result.issues.some((issue) => issue.code === "LENGTH_OUTLIER")).toBe(
      true,
    );
    expect(
      result.issues.find((issue) => issue.code === "LENGTH_OUTLIER")?.blocking,
    ).toBe(false);
    expect(result.passed).toBe(true);
  });
});

describe("serving a translation", () => {
  it("uses translated text but keeps the source's keys and their order", () => {
    const merged = mergeQuestion(source, good);
    expect(merged.options.map((option) => option.key)).toEqual(["a", "b", "c"]);
    expect(merged.options[1].text).toContain("adaptada");
    expect(merged.stem).toContain("velocidad");
  });

  it("renders a missing option in English rather than throwing", () => {
    // This is the case that used to 500 a live exam page. One English option is survivable;
    // a crashed exam is not.
    const partial = {
      ...good,
      options: good.options.filter((option) => option.key !== "c"),
    };
    const merged = mergeQuestion(source, partial);
    expect(merged.options.map((option) => option.key)).toEqual(["a", "b", "c"]);
    expect(merged.options[2].text).toBe("Exactly 60 km/h");
  });

  it("falls through to the source entirely when there is no translation", () => {
    expect(mergeQuestion(source, undefined)).toEqual(source);
  });

  it("ignores blank translated text instead of showing an empty option", () => {
    const blank = { ...good, stem: "   ", options: [{ key: "a", text: "" }] };
    const merged = mergeQuestion(source, blank);
    expect(merged.stem).toBe(source.stem);
    expect(merged.options[0].text).toBe(source.options[0].text);
  });

  it("serves machine translations only where the language allows it", () => {
    expect(servableStatuses(true)).toEqual(["APPROVED"]);
    expect(servableStatuses(false)).toEqual(["APPROVED", "MACHINE"]);
    // Neither policy ever serves something a check flagged or a reviewer refused.
    expect(servableStatuses(false)).not.toContain("NEEDS_REVIEW");
    expect(servableStatuses(false)).not.toContain("REJECTED");
  });

  it("falls back for a name-shaped unit", () => {
    expect(mergeName("Right of way", { name: "Prioridad de paso" })).toBe(
      "Prioridad de paso",
    );
    expect(mergeName("Right of way", undefined)).toBe("Right of way");
    expect(mergeName("Right of way", { name: "  " })).toBe("Right of way");
  });
});

describe("staleness and reuse", () => {
  const unit = {
    entity: "TOPIC" as const,
    en: { name: "Right of way" },
    nb: { name: "Vikeplikt" },
  };

  it("is stable across key order, so nothing looks stale for no reason", () => {
    const reordered = {
      entity: "TOPIC" as const,
      nb: { name: "Vikeplikt" },
      en: { name: "Right of way" },
    };
    expect(hashUnit(unit, 1)).toBe(hashUnit(reordered, 1));
  });

  it("changes when the source text changes", () => {
    expect(hashUnit({ ...unit, en: { name: "Priority" } }, 1)).not.toBe(
      hashUnit(unit, 1),
    );
  });

  it("changes when the glossary changes — new terminology means re-translating", () => {
    expect(hashUnit(unit, 2)).not.toBe(hashUnit(unit, 1));
  });

  it("keys memory on the source alone, so the same English is reused wherever it appears", () => {
    const here = memoryHash("TOPIC", { name: "Right of way" }, 1);
    const there = memoryHash("TOPIC", { name: "Right of way" }, 1);
    expect(here).toBe(there);
    // …but not across contexts: the same words mean different things in different places.
    expect(memoryHash("SIGN", { name: "Right of way" }, 1)).not.toBe(here);
  });
});

describe("payload strings", () => {
  it("collects every translatable string, including option text", () => {
    expect(payloadStrings(source)).toHaveLength(5);
    expect(payloadStrings({ text: "hello" })).toEqual(["hello"]);
  });
});
