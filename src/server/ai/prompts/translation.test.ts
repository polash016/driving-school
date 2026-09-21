import { describe, expect, it } from "vitest";
import { translateRepairPrompt, translateUnitsPrompt } from "./translation";

describe("translation.repair prompt", () => {
  it("states each unit's previous attempt and the exact problems to fix", () => {
    const text = translateRepairPrompt.render({
      targetLanguage: "Spanish",
      targetCode: "es",
      lengthBudget: "For Spanish that means about 20 words in a question, 11 in an option and 32 in an explanation.",
      targetScript: null,
      styleNote: "",
      glossaryBlock: "",
      unitsJson: JSON.stringify([
        {
          id: "q1",
          kind: "MASTER_ITEM",
          correctOptionKey: "b",
          en: { stem: "Limit is 80 km/h" },
          nb: { stem: "Grensen er 80 km/t" },
          previous: { stem: "El límite es 50 km/h" },
          problems: [{ code: "NUMBER_DRIFT", detail: "80 to 50" }],
          reviewerNote: null,
        },
      ]),
    });
    expect(text).toContain("NUMBER_DRIFT");
    expect(text).toContain("80 to 50");
    expect(text).toContain("El límite es 50 km/h");
    expect(text).toMatch(/fix every listed problem/i);
    expect(translateRepairPrompt.id).toBe("translation.repair");
  });
});

/**
 * Spec-21: production served Bengali in Latin letters. Neither prompt had ever said which script
 * to write in; both do now, and the gate refuses what they forbid.
 */
describe("the script rule (spec-21)", () => {
  it("both prompts tell the model to write in the language's own script, never romanised", () => {
    const units = translateUnitsPrompt.render({
      targetLanguage: "Bengali (বাংলা)",
      targetCode: "bn",
      lengthBudget: "For Spanish that means about 20 words in a question, 11 in an option and 32 in an explanation.",
      targetScript: "Bengali",
      styleNote: "",
      glossaryBlock: "",
      rejectedBlock: "",
      unitsJson: "[]",
    });
    expect(units).toMatch(/Bengali script/);
    expect(units).toMatch(/never romani[sz]e/i);

    const repair = translateRepairPrompt.render({
      targetLanguage: "Bengali",
      targetCode: "bn",
      lengthBudget: "For Spanish that means about 20 words in a question, 11 in an option and 32 in an explanation.",
      targetScript: "Bengali",
      styleNote: "",
      glossaryBlock: "",
      unitsJson: "[]",
    });
    expect(repair).toMatch(/Bengali script/);
    expect(repair).toMatch(/never romani[sz]e/i);
  });

  it("asks a Latin-script language for its own orthography instead, and both prompts are 1.2.0", () => {
    const units = translateUnitsPrompt.render({
      targetLanguage: "Spanish (Español)",
      targetCode: "es",
      lengthBudget: "For Spanish that means about 20 words in a question, 11 in an option and 32 in an explanation.",
      targetScript: null,
      styleNote: "",
      glossaryBlock: "",
      rejectedBlock: "",
      unitsJson: "[]",
    });
    expect(units).toMatch(/own orthography/i);
    expect(units).not.toMatch(/script\./);
    // 1.2.0 since spec-22 added the length budget (rule 10 / rule 7).
    expect(translateUnitsPrompt.version).toBe("1.2.0");
    expect(translateRepairPrompt.version).toBe("1.2.0");
  });
});
