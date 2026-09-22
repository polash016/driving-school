import { describe, expect, it } from "vitest";
import { schoolConfig } from "../../../../config/school.config";
import { imageQuestionPrompt, theoryGenerationPrompt } from "./index";
import { signMeaningPrompt } from "./signs";
import { translateRepairPrompt, translateUnitsPrompt } from "./translation";
import { simplifyQuestionPrompt } from "./simplify";

const theoryVars = {
  topicName: "Priority rules",
  kbExcerpts: "§ 7 …",
  candidateCount: 5,
  avoidStems: "",
  difficultyBrief: "",
  rejectionLessons: "",
};

const imageVars = {
  situationSummary: "A junction.",
  signList: "",
  sceneFacts: "",
  kbExcerpts: "§ 7 …",
  candidateCount: 3,
  avoidStems: "",
  difficultyBrief: "",
  rejectionLessons: "",
};

const translateVars = {
  targetLanguage: "Bengali",
  targetCode: "bn",
  targetScript: "Bengali",
  styleNote: "",
  glossaryBlock: "",
  rejectedBlock: "",
  unitsJson: "[]",
  lengthBudget: "For Bengali that means about 20 words in a question.",
};

/**
 * These pins are the mechanism that keeps the project's "bump the version on ANY wording change"
 * rule enforceable now that a config value can reach prompt text. Editing `content.brevity` or a
 * brevity rule breaks this file, which forces the bump to be a deliberate act.
 */
describe("prompt versions are pinned", () => {
  it.each([
    [theoryGenerationPrompt, "generation.theory-questions", "1.3.0"],
    [imageQuestionPrompt, "generation.image-questions", "1.1.0"],
    [signMeaningPrompt, "signs.meaning", "1.1.0"],
    [translateUnitsPrompt, "translation.units", "1.2.0"],
    [translateRepairPrompt, "translation.repair", "1.2.0"],
    [simplifyQuestionPrompt, "rewrite.simplify-question", "1.1.0"],
  ])("%#: id and version", (prompt, id, version) => {
    expect(prompt.id).toBe(id);
    expect(prompt.version).toBe(version);
  });
});

describe("generation prompts state the brevity budget", () => {
  const { stemWords, optionWords, signMeaningWords } =
    schoolConfig.content.brevity;

  it("theory prompt states the literal numbers the gate enforces", () => {
    const text = theoryGenerationPrompt.render(theoryVars);
    expect(text).toContain(`at most ${stemWords} words`);
    expect(text).toContain(`at most ${optionWords} words`);
    expect(text).toContain("SHORT AND EASY");
    expect(text).toMatch(/active voice/i);
    // The Norwegian half must be held to the same limit, or nb runs long while en complies.
    expect(text).toMatch(/Norwegian grammar is not a licence to run long/);
  });

  it("image prompt states the same numbers", () => {
    const text = imageQuestionPrompt.render(imageVars);
    expect(text).toContain(`at most ${stemWords} words`);
    expect(text).toContain(`at most ${optionWords} words`);
  });

  it("sign prompt uses the SIGN budget, not the option budget", () => {
    const text = signMeaningPrompt.render({
      nameEn: "Give way",
      signClass: "VIKEPLIKT_OG_FORKJORS",
      legalExcerpts: "",
    });
    expect(text).toContain(`AT MOST ${signMeaningWords} WORDS`);
    expect(text).toContain("ANSWER OPTION");
    // The stock preamble is 99% of the current registry's waste.
    expect(text).toContain("This sign indicates that");
    expect(text).toMatch(/NEVER open with/);
  });
});

describe("translation prompts carry the budget without inviting cuts", () => {
  it("units prompt renders the supplied budget sentence", () => {
    const text = translateUnitsPrompt.render(translateVars);
    expect(text).toContain(translateVars.lengthBudget);
    expect(text).toContain("NEVER LONGER THAN IT HAS TO BE");
    // Load-bearing: brevity must never become a licence to drop meaning.
    expect(text).toContain("cutting meaning to hit a number is not");
    // The spec-21 script rule must survive the edit.
    expect(text).toContain("Never romanise");
  });

  it("repair prompt carries the budget and the same guard", () => {
    const repairVars = { ...translateVars };
    const text = translateRepairPrompt.render(repairVars);
    expect(text).toContain(repairVars.lengthBudget);
    expect(text).toContain("Never shorten by dropping meaning");
  });
});
