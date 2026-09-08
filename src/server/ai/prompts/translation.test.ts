import { describe, expect, it } from "vitest";
import { translateRepairPrompt } from "./translation";

describe("translation.repair prompt", () => {
  it("states each unit's previous attempt and the exact problems to fix", () => {
    const text = translateRepairPrompt.render({
      targetLanguage: "Spanish",
      targetCode: "es",
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
