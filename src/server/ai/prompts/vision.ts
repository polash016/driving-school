import type { PromptTemplate } from "./index";

/**
 * Vision prompts for the image pipeline (spec-06, mode 2).
 *
 * These are shaped by a measurement, not a guess. Probing the configured model on registry sign
 * graphics — the easiest possible case, clean and isolated on white — gave:
 *
 *   open recall ("name this sign")            2 / 7 usable
 *   closed vocabulary ("choose from the 287") 6 / 7
 *   self-reported confidence on the one miss  0.95, and wrong
 *
 * So: identification is always a CHOICE from the registry, never a description; and the model's
 * own confidence is recorded for a human to look at but is never used as a gate. Agreement across
 * repeated runs does that job instead. A real roadside photograph is harder than the probe, which
 * is the whole reason the second, discriminating pass below exists.
 */

/**
 * Pass 1 — what is in this picture, with sign identity constrained to the registry.
 *
 * Deliberately does NOT ask for applicable rules. Those come from the knowledge base, retrieved by
 * the sign codes this pass returns, so that a question is grounded in the regulation's own words
 * rather than the model's memory of them.
 */
export const sceneDetectionPrompt: PromptTemplate<{
  signCatalogue: string;
}> = {
  id: "vision.scene-detection",
  version: "1.0.0",
  render: ({ signCatalogue }) =>
    [
      "You are reading a Norwegian road-traffic photograph for a driving-theory platform.",
      "",
      "Return STRICT JSON matching the schema:",
      "  signs         — every official traffic sign you can see. `code` MUST be copied verbatim from the catalogue below; never invent a code, never describe a sign in words. Include `bbox` as fractions of the image (x, y from the top-left, w, h), as tightly around the sign face as you can.",
      "  roadMarkings  — painted markings (lane lines, give-way triangles, stop line, pedestrian crossing…).",
      "  actors        — other road users and where they are ('cyclist on the right', 'oncoming car turning left').",
      "  conditions    — lighting, weather, roadType.",
      "  situationSummary — one neutral sentence describing the scene. Describe only what is visible. Do NOT state what the driver must do, and do NOT mention any rule, penalty or section number.",
      "",
      "Rules:",
      "- If you cannot tell which of two similar signs it is, still pick the closer one and set a low confidence. A later step re-checks every sign against the actual graphic, so a wrong guess here is caught; a silently omitted sign is not.",
      "- A sign you can see only partially still counts — give it a bbox.",
      "- Do not list a sign that is not physically in the picture.",
      "",
      "SIGN CATALOGUE (code · name):",
      signCatalogue,
    ].join("\n"),
};

/**
 * Pass 2 — the discriminating check, and the one that earns its cost.
 *
 * Pass 1's failure mode is confusing a sign with a near neighbour in its own class, at high
 * confidence. So the detected region is cropped out and shown beside the actual graphics of a
 * handful of same-class candidates: a side-by-side discrimination, which models do far better than
 * recall, and which can answer "none of these" — the option that turns a hallucinated sign into a
 * dropped one.
 */
export const signDiscriminationPrompt: PromptTemplate<{
  candidates: { code: string; name: string }[];
}> = {
  id: "vision.sign-discrimination",
  version: "1.0.0",
  render: ({ candidates }) =>
    [
      "The FIRST image is a region cropped from a Norwegian road photograph. The images after it are official sign graphics, in the order listed below.",
      "",
      "Decide which listed sign, if any, the cropped region actually shows.",
      "",
      "Return STRICT JSON { code, reason } where:",
      "  code   — the matching sign's code copied verbatim, or exactly \"NONE\" if the crop shows none of them.",
      "  reason — one short sentence naming the visual detail you matched on (shape, colour, symbol, number).",
      "",
      "Answer NONE whenever the crop is too blurred, too small, cut off, or is not a traffic sign at all.",
      "Being wrong here puts a false rule in front of a learner driver, so NONE is the right answer far more often than a guess is.",
      "",
      "CANDIDATES, in the order the images appear:",
      ...candidates.map((candidate, index) => `  ${index + 1}. ${candidate.code} · ${candidate.name}`),
    ].join("\n"),
};
