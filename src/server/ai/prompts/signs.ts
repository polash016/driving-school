import type { PromptTemplate } from "./index";

/**
 * Sign registry enrichment (sign test).
 *
 * The theory book gives an English NAME per sign and nothing else — no meaning, no Norwegian, no
 * skiltforskriften code. This prompt fills the first two from the sign graphic itself plus the
 * extracted name, so the sign test can ask what a sign *means* and not merely what it is called.
 *
 * Two things it deliberately does NOT do:
 *   - guess a skiltforskriften code. A plausible-looking wrong code reads as authoritative and
 *     would be copied onward; internal placeholder codes stay until a person supplies the real one.
 *   - invent a rule. The meaning must describe what the sign instructs, not editorialise about
 *     penalties or advice that a driving instructor would have to correct.
 */
export const signMeaningPrompt: PromptTemplate<{
  nameEn: string;
  signClass: string;
  legalExcerpts: string;
}> = {
  id: "signs.meaning",
  version: "1.1.0",
  render: ({ nameEn, signClass, legalExcerpts }) =>
    [
      "You write reference copy for a Norwegian driving-theory platform (Statens vegvesen class B).",
      "You are shown ONE official Norwegian road sign and told what the textbook calls it.",
      `Textbook name (English): "${nameEn}"`,
      `Sign group: ${signClass}`,
      "",
      "Return STRICT JSON matching the schema:",
      "  nameEn    — the sign's standard English name. Keep the textbook name unless it is clearly wrong for the graphic shown.",
      "  nameNb    — the standard Norwegian Bokmål name as used in skiltforskriften (e.g. 'Vikeplikt', 'Farlig sving').",
      "  meaningEn — ONE sentence, AT MOST 12 WORDS, saying what this sign requires the driver to do.",
      "  meaningNb — the same meaning in Norwegian Bokmål, also ONE sentence of at most 12 words. A translation of meaningEn, not a different statement.",
      "",
      "Rules:",
      "- Describe the sign's own instruction. Do not add penalties, fines, advice or history.",
      "- THIS SENTENCE IS SHOWN TO STUDENTS AS AN ANSWER OPTION, beside three other signs' meanings, on a phone. It must be readable at a glance: everyday words, no sub-clause, no semicolon.",
      "- Start with what the driver does, not with the sign. Write 'Give way to traffic from the right', 'You must not overtake here', 'Maximum speed is 50 km/h'. NEVER open with 'This sign indicates that…' or 'This sign means…', and never use the sign's own name in the meaning.",
      "- No padding: no 'please note', no 'be aware that', no restating the sign group.",
      "- Being unambiguous beats being short. If the only honest 12-word sentence would be equally true of another sign in this group, use the words you need to tell them apart.",
      "- Address the driver in the second person ('You must…', 'Du må…') where it reads naturally.",
      "- If the graphic and the textbook name disagree, trust the GRAPHIC and correct the name.",
      "- Norwegian must be Bokmål and idiomatic — this is read by native speakers.",
      "- Never mention a sign number or a legal section.",
      legalExcerpts
        ? `\nRelevant regulation text, if it helps you be precise:\n${legalExcerpts}`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
};
