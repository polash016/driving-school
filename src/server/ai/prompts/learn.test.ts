import { describe, expect, it } from "vitest";
import { learnDraftPrompt } from "./learn";

describe("learn.draft-document prompt", () => {
  it("is pinned at 1.0.0 and carries the rules the validator relies on", () => {
    expect(learnDraftPrompt.id).toBe("learn.draft-document");
    expect(learnDraftPrompt.version).toBe("1.0.0");
    const text = learnDraftPrompt.render({
      topicNameEn: "Right of way",
      topicNameNb: "Vikeplikt",
      kindLabel: "a chapter of the book \"Theory\"",
      siblingTitles: "- Roundabouts",
      brief: "focus on unmarked junctions",
      targetWords: 700,
      kbExcerpts: "[trafikkreglene § 7]\nText",
      feedback: "",
    });
    expect(text).toContain("same number of H2 and H3 lines");
    expect(text).toContain("(trafikkreglene § 7 nr. 2)");
    expect(text).toContain("No images, no links, no HTML");
    expect(text).toContain("about 700 words");
    expect(text).toContain("Roundabouts");
    expect(text).toContain("unmarked junctions");
    expect(text).not.toContain("PREVIOUS ATTEMPT");
  });

  it("hands a refusal back to the model on retry", () => {
    const text = learnDraftPrompt.render({
      topicNameEn: "x", topicNameNb: "y", kindLabel: "an article", siblingTitles: "", brief: "", targetWords: 500, kbExcerpts: "", feedback: "English had 5 H2 sections, Norwegian 6.",
    });
    expect(text).toContain("YOUR PREVIOUS ATTEMPT WAS REFUSED: English had 5 H2 sections, Norwegian 6.");
  });
});
