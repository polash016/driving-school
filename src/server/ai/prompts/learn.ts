import type { PromptTemplate } from "./index";

/**
 * Drafting a study chapter from the ingested law text (spec-23).
 *
 * The rules are the same ones the question prompts obey — say only what the excerpts say, keep
 * every number, cite in prose — plus two that matter for a chapter: the same H2/H3 skeleton in
 * both languages (that is what lets a chapter travel as aligned translation units), and plain
 * A2/B1 prose, because the reader is a learner on a phone, not a lawyer.
 */
export const learnDraftPrompt: PromptTemplate<{
  topicNameEn: string;
  topicNameNb: string;
  kindLabel: string;
  siblingTitles: string;
  brief: string;
  targetWords: number;
  kbExcerpts: string;
  feedback: string;
}> = {
  id: "learn.draft-document",
  version: "1.0.0",
  render: ({ topicNameEn, topicNameNb, kindLabel, siblingTitles, brief, targetWords, kbExcerpts, feedback }) =>
    [
      `You are writing ${kindLabel} for learners preparing for the Norwegian class B driving theory test. Topic: "${topicNameEn}" (Norwegian: "${topicNameNb}").`,
      "",
      "GROUNDING — the only source of truth is the EXCERPTS below, taken from the regulations this school has ingested:",
      "- State a rule only if an excerpt states it. Never add a rule, a number, a fine, a distance or an exception from memory.",
      "- Every number, unit and legal reference is copied exactly: 50 km/h stays 50 km/h, § 7 nr. 2 stays § 7 nr. 2.",
      "- Each section that states a rule ends its key sentence with the reference in prose, in brackets, e.g. (trafikkreglene § 7 nr. 2). The same references appear, identically, in both languages.",
      "- If the excerpts do not cover the topic well enough to write honestly, set `issue` to say why and keep the body short rather than inventing.",
      "",
      "STRUCTURE — identical in both languages, this is checked mechanically:",
      "- 4 to 8 sections, each starting with an H2 line (`## `). Sub-points may use H3 (`### `). The same number of H2 and H3 lines in English and Norwegian, in the same order.",
      "- Enumerations as bullet lists (`- `). A final section `## Key points` (Norwegian: `## Det viktigste`) with 3 to 5 bullets.",
      "- No images, no links, no HTML, no code, no tables, no H1 (the title is a separate field).",
      "",
      "VOICE — CEFR A2/B1: short sentences, one idea each, second person ('you must'), present tense, everyday words. Keep the official terms the test uses ('vikeplikt', 'forkjørsvei', 'skiltforskriften') and explain them once in plain words.",
      `LENGTH — about ${targetWords} words per language (between ${Math.round(targetWords * 0.7)} and ${Math.round(targetWords * 1.3)}).`,
      "",
      "NORWEGIAN (nb) is not a translation of your English — it is the other half of the same chapter, read by native speakers: idiomatic Bokmål at the same reading level, the same structure, the same references.",
      "",
      siblingTitles ? `Do not duplicate what these existing documents on the topic already cover:\n${siblingTitles}` : "",
      brief ? `The editor asks for: ${brief}` : "",
      feedback ? `YOUR PREVIOUS ATTEMPT WAS REFUSED: ${feedback} Fix exactly that.` : "",
      "",
      "EXCERPTS:",
      kbExcerpts,
      "",
      "Return ONLY a JSON object:",
      '{"title":{"en":"…","nb":"…"},"summary":{"en":"one or two sentences","nb":"…"},"body":{"en":"markdown","nb":"markdown"},"citations":[{"sourceCode":"trafikkreglene","ref":"§ 7 nr. 2","supports":"which claim this backs"}],"issue":"optional — why the material was insufficient"}',
      "`citations` lists every reference used in the body, with the sourceCode exactly as it appears in the excerpt headers.",
    ]
      .filter((line) => line !== "")
      .join("\n"),
};
