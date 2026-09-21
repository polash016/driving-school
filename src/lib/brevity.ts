/**
 * How long is this text, in a way that means the same thing in every script (spec-22).
 *
 * The naive measure — `text.split(/\s+/)` — is not merely inaccurate outside Latin script, it is
 * undefined: Thai, Chinese, Japanese, Khmer and Lao do not put spaces between words, so a 40-word
 * Thai sentence measures as 1. The alternative usually reached for, a character budget, is worse
 * in the other direction: Norwegian and German compound (`vikepliktsskiltet`, 18 characters, one
 * word), so a character budget punishes exactly the short, correct phrasing this module exists to
 * encourage.
 *
 * So: segment with ICU (`Intl.Segmenter`), which knows where the words are in all of them, and
 * then correct for the one script where ICU's answer is not the one a reader would give.
 *
 * Measured on this project's runtime (node 24, full ICU) — the numbers the test pins:
 *
 *   en  7   You must stop before the pedestrian crossing.
 *   nb  5   Du må stoppe før gangfeltet.
 *   ar  6   يجب أن تتوقف قبل ممر المشاة.
 *   bn  6   পথচারী পারাপারের আগে আপনাকে থামতে হবে।
 *   ko  5   보행자 횡단보도 앞에서 정차해야 합니다.
 *   th  6   คุณต้องหยุดรถก่อนทางม้าลาย          ← no spaces, segmented by dictionary
 *   zh  8   你必须在人行横道前停车
 *   ja 16   歩行者横断歩道の前では必ず停止しなければなりません  ← morphemes, not words
 *
 * Every script lands where a reader would put it except Japanese, which ICU segments into
 * morphemes (`し` / `なけれ` / `ば` are three segments of one verb ending). Hence one factor that
 * carries real weight and a few that barely move.
 */

export type BrevityKind = "stem" | "option" | "explanation" | "signMeaning";

/** The budget targets, as they come from `schoolConfig.content.brevity`. */
export interface BrevityTargets {
  stemWords: number;
  optionWords: number;
  explanationWords: number;
  explanationSentences: number;
  signMeaningWords: number;
}

/**
 * Word-budget multiplier per script.
 *
 * Only `ja` is a correction for a real disagreement between ICU and a reader. `zh`/`ko`/`th` are
 * within measurement noise of 1.0 and are listed at their measured values rather than rounded to
 * 1.0, so that re-tuning them later is an edit to data and not a rediscovery of why they are here.
 */
const SCRIPT_WORD_FACTOR: Readonly<Record<string, number>> = {
  ja: 2.0,
  zh: 1.25,
  ko: 1.2,
  th: 1.15,
  km: 1.15,
  lo: 1.15,
  my: 1.15,
};

/**
 * Generation refuses a candidate only past target × this.
 *
 * The band between the target and the ceiling is where a rule that genuinely needs one more clause
 * lives. A single threshold would have to either block correct questions or teach the model
 * nothing; two thresholds let the prompt ask for 15 while the gate refuses only at 21.
 */
export const CEILING_RATIO = 1.4;

/**
 * Extra room a translation gets before it is called verbose.
 *
 * German, Tamil and Arabic are honestly longer than English for the same meaning. Without this a
 * shortness flag would fire on a correct translation for being in its own language.
 */
export const TRANSLATION_SLACK = 1.3;

/** Sentence terminators across the scripts this platform serves. `…` is deliberately absent. */
const SENTENCE_TERMINATORS = /[.!?。！？؟।॥]+/u;

/** Fallback tokeniser for a runtime built without full ICU. Latin-ish, but never throws. */
const WORD_FALLBACK = /[\p{L}\p{N}][\p{L}\p{N}\p{M}'’\-]*/gu;

function primarySubtag(locale: string): string {
  return locale.split("-")[0]!.toLowerCase();
}

/** The multiplier for a locale's script. 1.0 for everything not in the table. */
export function scriptWordFactor(locale: string): number {
  return SCRIPT_WORD_FACTOR[primarySubtag(locale)] ?? 1;
}

/**
 * Words in `text`, as a reader of `locale` would count them.
 *
 * `isWordLike` is what excludes punctuation and the spaces themselves; it is also what keeps
 * "50 km/h" at two words rather than five.
 */
export function countWords(text: string, locale = "en"): number {
  const trimmed = text?.trim();
  if (!trimmed) return 0;

  if (typeof Intl?.Segmenter === "function") {
    try {
      const segmenter = new Intl.Segmenter(locale, { granularity: "word" });
      let count = 0;
      for (const segment of segmenter.segment(trimmed)) {
        if (segment.isWordLike) count++;
      }
      return count;
    } catch {
      // An unknown locale tag must not take the gate down with it — fall through.
    }
  }
  return trimmed.match(WORD_FALLBACK)?.length ?? 0;
}

/**
 * Sentences in `text`.
 *
 * Advisory only, and only ever applied to en/nb. A script with no terminator at all (Thai) returns
 * 1 for any non-empty text, which is correct as a floor and useless as a limit — which is exactly
 * why the enforced explanation budget is words and this is not.
 */
export function countSentences(text: string): number {
  const trimmed = text?.trim();
  if (!trimmed) return 0;
  const parts = trimmed
    .split(SENTENCE_TERMINATORS)
    .map((part) => part.trim())
    .filter(Boolean);
  return Math.max(1, parts.length);
}

/**
 * The budget for one field, in words, for one locale.
 *
 * `mode: "ceiling"` is the generation refusal line; `"target"` is what the prompt asks for and
 * what the approval gate warns at. `translation: true` adds the slack a target language is owed.
 */
export function wordBudget(input: {
  kind: BrevityKind;
  locale: string;
  targets: BrevityTargets;
  mode?: "target" | "ceiling";
  translation?: boolean;
}): number {
  const { kind, locale, targets, mode = "target", translation = false } = input;
  const base =
    kind === "stem"
      ? targets.stemWords
      : kind === "option"
        ? targets.optionWords
        : kind === "signMeaning"
          ? targets.signMeaningWords
          : targets.explanationWords;

  const scaled =
    base *
    scriptWordFactor(locale) *
    (translation ? TRANSLATION_SLACK : 1) *
    (mode === "ceiling" ? CEILING_RATIO : 1);
  return Math.ceil(scaled);
}

/** True when `text` fits the budget for that field and locale. */
export function withinBudget(
  text: string,
  input: Parameters<typeof wordBudget>[0],
): boolean {
  return countWords(text, input.locale) <= wordBudget(input);
}

/**
 * One sentence naming the budget, for a prompt.
 *
 * The point is that prompt and gate cannot state different numbers: both render from the same
 * config through the same function, so editing the config moves both or neither.
 */
export function brevityBudgetSentence(
  locale: string,
  targets: BrevityTargets,
  languageName?: string,
): string {
  const stem = wordBudget({ kind: "stem", locale, targets, translation: true });
  const option = wordBudget({
    kind: "option",
    locale,
    targets,
    translation: true,
  });
  const explanation = wordBudget({
    kind: "explanation",
    locale,
    targets,
    translation: true,
  });
  const subject = languageName ?? locale;
  return `For ${subject} that means about ${stem} words in a question, ${option} in an option and ${explanation} in an explanation.`;
}
