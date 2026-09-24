import { markdownStructure } from "@/server/services/learn/markdown";
import type { TranslatableEntity } from "@prisma/client";
import { schoolConfig } from "../../../../config/school.config";
import { countWords, wordBudget, type BrevityKind } from "@/lib/brevity";
import {
  isQuestionEntity,
  payloadStrings,
  type QuestionPayload,
  type UnitPayload,
} from "./units";

/**
 * Deterministic translation checks (spec-15) — free, instant, and where most of the safety is.
 *
 * These run before anything reaches a reviewer, let alone a student. A blocking issue parks the
 * translation in NEEDS_REVIEW, which is never served under any approval policy.
 *
 * The one that earns its keep on its own is NUMBER_DRIFT. "50 km/h" becoming "60 km/h" is silent,
 * catastrophic on a driving test, and completely detectable without asking a model anything.
 */

/**
 * Flags that say nothing about the text.
 *
 * `QA_UNAVAILABLE` is emitted wholesale when the back-translation or the embedding call fails —
 * the check could not run, which is not a finding about the translation. `LENGTH_OUTLIER` is
 * advisory by construction: it does not block, and a model asked to "fix" it will pad or trim
 * meaning to hit a ratio.
 *
 * One list, two consumers: auto-repair will not spend a model call on these (`isReQaOnly`), and
 * bulk approve offers them to a reviewer pre-ticked. Both answer the same question — "is this a
 * statement about correctness?" — so there must only ever be one answer to it.
 */
export const NOT_A_QUALITY_FLAG: ReadonlySet<string> = new Set([
  "QA_UNAVAILABLE",
  "LENGTH_OUTLIER",
  // Verbosity is not a statement about correctness, and repair must never chase it: a model told
  // to "make it shorter" trims meaning, which on a legal exam is the worse failure (spec-22).
  "VERBOSE",
]);

export interface TranslationIssue {
  code: string;
  /** Blocking issues stop a translation being served; warnings are shown to the reviewer. */
  blocking: boolean;
  detail?: string;
}

export interface TranslationCheck {
  passed: boolean;
  issues: TranslationIssue[];
}

/** Numbers, including decimals written the Norwegian way (0,2). */
const NUMBER_PATTERN = /\d+(?:[.,]\d+)?/g;
/**
 * Legal references: "§ 7", "§ 7-2", "§ 13.3".
 *
 * The section symbol and its number are the address, and that is what must survive verbatim. The
 * connective word around it ("no.", "item", "paragraph") is ordinary prose and has to be allowed
 * to translate — pinning it would force English words into the middle of every Spanish sentence.
 * The numbers in it are still checked, by NUMBER_DRIFT.
 */
const SECTION_PATTERN = /§\s*\d+(?:[.\-]\d+)*/gu;
/** ICU placeholders in UI messages: {count}, {minutes}. */
const PLACEHOLDER_PATTERN = /\{[a-zA-Z][a-zA-Z0-9]*\}/g;
/** Template slots in question text. */
const SLOT_PATTERN = /\{\{[^}]+\}\}/g;

/**
 * The script a language is written in, for the languages whose script is not Latin.
 *
 * Production served Bengali in Latin letters ("Tumi aage signal dile…") because Bengali was not in
 * this table, so the check never ran for it (spec-21). The name feeds the prompt as well as the
 * gate: the model is told which script to write, and then held to it, per field.
 *
 * For Spanish or Polish "did it change at all" is the only available signal, covered separately.
 */
const SCRIPT_RANGES: Record<string, { name: string; test: RegExp }> = {
  ar: { name: "Arabic", test: /[؀-ۿ]/ },
  fa: { name: "Arabic", test: /[؀-ۿ]/ },
  ur: { name: "Arabic", test: /[؀-ۿ]/ },
  ru: { name: "Cyrillic", test: /[Ѐ-ӿ]/ },
  uk: { name: "Cyrillic", test: /[Ѐ-ӿ]/ },
  el: { name: "Greek", test: /[Ͱ-Ͽ]/ },
  he: { name: "Hebrew", test: /[֐-׿]/ },
  hi: { name: "Devanagari", test: /[ऀ-ॿ]/ },
  mr: { name: "Devanagari", test: /[ऀ-ॿ]/ },
  ne: { name: "Devanagari", test: /[ऀ-ॿ]/ },
  bn: { name: "Bengali", test: /[ঀ-৿]/ },
  pa: { name: "Gurmukhi", test: /[਀-੿]/ },
  gu: { name: "Gujarati", test: /[઀-૿]/ },
  ta: { name: "Tamil", test: /[஀-௿]/ },
  te: { name: "Telugu", test: /[ఀ-౿]/ },
  kn: { name: "Kannada", test: /[ಀ-೿]/ },
  ml: { name: "Malayalam", test: /[ഀ-ൿ]/ },
  si: { name: "Sinhala", test: /[඀-෿]/ },
  th: { name: "Thai", test: /[฀-๿]/ },
  my: { name: "Myanmar", test: /[က-႟]/ },
  km: { name: "Khmer", test: /[ក-៿]/ },
  am: { name: "Ethiopic", test: /[ሀ-፿]/ },
  ti: { name: "Ethiopic", test: /[ሀ-፿]/ },
  ka: { name: "Georgian", test: /[Ⴀ-ჿ]/ },
  hy: { name: "Armenian", test: /[԰-֏]/ },
  zh: { name: "Han (Chinese)", test: /[一-鿿]/ },
  ja: { name: "Japanese", test: /[぀-ヿ一-鿿]/ },
  ko: { name: "Hangul", test: /[가-힯]/ },
};

/** The script a locale must be written in, or undefined for a Latin-script language. */
export function targetScript(
  locale: string,
): { name: string; test: RegExp } | undefined {
  return SCRIPT_RANGES[locale.split("-")[0]];
}

/**
 * Locales whose script costs 2–3× the tokens per character; the runner starts them at half a batch.
 *
 * Derived from `SCRIPT_RANGES` rather than listed again: the two questions ("is this script
 * checkable?" and "is this script expensive?") have the same answer for every language we serve,
 * and a second list would drift the first time one is added.
 */
export function isNonLatinScript(locale: string): boolean {
  return targetScript(locale) !== undefined;
}

/**
 * True when some word of `text` mixes a letter of the target script with a letter of another
 * non-Latin script. Words are runs of letters and combining marks, so a vowel sign stays attached
 * to its consonant; a foreign letter INSIDE such a run is a keyboard-layout or model glitch, never
 * a translation choice.
 */
export function hasMixedScriptWord(text: string, target: RegExp): boolean {
  const single = new RegExp(target.source, "u");
  for (const word of text.split(/[^\p{L}\p{M}]+/u)) {
    if (!single.test(word)) continue;
    for (const ch of word) {
      if (!/\p{L}/u.test(ch)) continue;
      if (single.test(ch)) continue;
      if (/\p{Script=Latin}/u.test(ch)) continue;
      return true;
    }
  }
  return false;
}

/** Letters a text carries once its placeholders and slots are set aside. */
function letterCount(text: string): number {
  return text
    .replace(PLACEHOLDER_PATTERN, " ")
    .replace(SLOT_PATTERN, " ")
    .replace(/[^\p{L}]+/gu, "").length;
}

/**
 * The fields of a unit, paired source-to-translation and named the way a reviewer names them:
 * `stem`, `option b`, `explanation`, `name`, `text`. Options pair by key, never by position.
 */
function fieldPairs(
  source: UnitPayload,
  translated: UnitPayload,
): Array<{ field: string; from: string; to: string }> {
  const pairs: Array<{ field: string; from: string; to: string }> = [];
  const from = source as unknown as Record<string, unknown>;
  const to = translated as unknown as Record<string, unknown>;
  for (const key of Object.keys(from)) {
    if (key === "options") {
      const sourceOptions = (from.options ?? []) as Array<{
        key: string;
        text: string;
      }>;
      const translatedOptions = (to.options ?? []) as Array<{
        key: string;
        text: string;
      }>;
      for (const option of sourceOptions) {
        const match = translatedOptions.find((o) => o.key === option.key);
        if (match && typeof match.text === "string")
          pairs.push({
            field: `option ${option.key}`,
            from: option.text,
            to: match.text,
          });
      }
    } else if (typeof from[key] === "string" && typeof to[key] === "string") {
      pairs.push({ field: key, from: from[key], to: to[key] });
    }
  }
  return pairs;
}

function multiset(values: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const value of values) out.set(value, (out.get(value) ?? 0) + 1);
  return out;
}

function sameMultiset(a: string[], b: string[]): boolean {
  const left = multiset(a);
  const right = multiset(b);
  if (left.size !== right.size) return false;
  for (const [key, count] of left) if (right.get(key) !== count) return false;
  return true;
}

/**
 * The zero of every decimal-digit block a translation may use. ৮০ km/h IS 80 km/h to a Bengali
 * reader; comparing glyphs instead of values flagged 75 correct Bangla rows as NUMBER_DRIFT
 * (spec-21). Values are compared, glyphs are the language's own business.
 */
const DIGIT_ZEROS = [
  0x0660, // Arabic-Indic
  0x06f0, // Extended Arabic-Indic (Persian, Urdu)
  0x07c0, // NKo
  0x0966, // Devanagari
  0x09e6, // Bengali
  0x0a66, // Gurmukhi
  0x0ae6, // Gujarati
  0x0b66, // Oriya
  0x0be6, // Tamil
  0x0c66, // Telugu
  0x0ce6, // Kannada
  0x0d66, // Malayalam
  0x0de6, // Sinhala Lith
  0x0e50, // Thai
  0x0ed0, // Lao
  0x0f20, // Tibetan
  0x1040, // Myanmar
  0x1090, // Myanmar Shan
  0x17e0, // Khmer
  0x1810, // Mongolian
  0xff10, // Fullwidth
];

/** Every native decimal digit rewritten as its ASCII value; everything else untouched. */
function asciiDigits(text: string): string {
  return text.replace(/\p{Nd}/gu, (digit) => {
    const point = digit.codePointAt(0) ?? 0;
    for (const zero of DIGIT_ZEROS) {
      if (point >= zero && point <= zero + 9) return String(point - zero);
    }
    return digit;
  });
}

function collect(text: string, pattern: RegExp): string[] {
  return (asciiDigits(text).match(pattern) ?? []).map((match) =>
    match.replace(/\s+/g, " ").trim(),
  );
}

function allOf(payload: UnitPayload, pattern: RegExp): string[] {
  return payloadStrings(payload).flatMap((text) => collect(text, pattern));
}

/**
 * Compare a translation against its source.
 *
 * `locale` is used only for the script check — everything else is language-agnostic on purpose, so
 * adding a language never means writing new validation code.
 */
export function checkTranslation(input: {
  entity: TranslatableEntity;
  locale: string;
  source: UnitPayload;
  translated: UnitPayload;
  correctOptionKey?: string;
}): TranslationCheck {
  const issues: TranslationIssue[] = [];
  const { source, translated } = input;

  const sourceTexts = payloadStrings(source);
  const translatedTexts = payloadStrings(translated);

  // 1. Nothing may be empty. A blank stem is not a translation.
  if (
    translatedTexts.length === 0 ||
    translatedTexts.some((text) => text.trim().length === 0)
  ) {
    issues.push({ code: "EMPTY_FIELD", blocking: true });
  }

  // 2. Question structure: the option keys ARE the cross-locale join, and the engine serves one
  //    shuffled key order to every language. A changed key set means the languages grade
  //    differently, which is the worst outcome available here.
  if (isQuestionEntity(input.entity)) {
    const sourceOptions = (source as QuestionPayload).options ?? [];
    const translatedOptions = (translated as QuestionPayload).options ?? [];
    const sourceKeys = sourceOptions.map((option) => option.key).sort();
    const translatedKeys = translatedOptions.map((option) => option.key).sort();

    if (sourceKeys.length !== translatedKeys.length) {
      issues.push({
        code: "OPTION_COUNT",
        blocking: true,
        detail: `${sourceKeys.length} to ${translatedKeys.length}`,
      });
    }
    if (sourceKeys.join(",") !== translatedKeys.join(",")) {
      issues.push({
        code: "KEY_MISMATCH",
        blocking: true,
        detail: `${sourceKeys.join(",")} to ${translatedKeys.join(",")}`,
      });
    }
    if (
      input.correctOptionKey &&
      !translatedKeys.includes(input.correctOptionKey)
    ) {
      issues.push({
        code: "ANSWER_KEY_LOST",
        blocking: true,
        detail: input.correctOptionKey,
      });
    }
    if (!(translated as QuestionPayload).stem?.trim()) {
      issues.push({ code: "STEM_MISSING", blocking: true });
    }
  }

  // 3. Numbers must survive exactly. A speed limit, a blood-alcohol figure or a distance that
  //    changes in translation is a wrong answer wearing the right clothes.
  const sourceNumbers = allOf(source, NUMBER_PATTERN);
  const translatedNumbers = allOf(translated, NUMBER_PATTERN);
  if (!sameMultiset(sourceNumbers, translatedNumbers)) {
    issues.push({
      code: "NUMBER_DRIFT",
      blocking: true,
      detail: `${sourceNumbers.join(", ")} to ${translatedNumbers.join(", ")}`,
    });
  }

  // 4. A § reference is a legal address, not prose. It is quoted, never translated.
  const sourceSections = allOf(source, SECTION_PATTERN);
  const translatedSections = allOf(translated, SECTION_PATTERN);
  if (!sameMultiset(sourceSections, translatedSections)) {
    issues.push({
      code: "CITATION_DRIFT",
      blocking: true,
      detail: `${sourceSections.join(", ")} to ${translatedSections.join(", ")}`,
    });
  }

  // 5. ICU placeholders and template slots must survive byte-for-byte: a dropped {count} is a
  //    crash in front of a student, not a typo.
  for (const [pattern, code] of [
    [PLACEHOLDER_PATTERN, "PLACEHOLDER_LOST"],
    [SLOT_PATTERN, "SLOT_LOST"],
  ] as const) {
    const before = allOf(source, pattern);
    const after = allOf(translated, pattern);
    if (!sameMultiset(before, after)) {
      issues.push({
        code,
        blocking: true,
        detail: `${before.join(", ")} to ${after.join(", ")}`,
      });
    }
  }

  // 6. Did anything actually get translated? A model that echoes its input is a silent failure.
  // Except when there is nothing TO translate. "{count} min" is correctly identical in Spanish,
  // and flagging it taught nobody anything — so the check only applies once the source carries
  // enough letters, outside its placeholders, to have a translation at all.
  const translatable = sourceTexts
    .join(" ")
    .replace(PLACEHOLDER_PATTERN, " ")
    .replace(SLOT_PATTERN, " ")
    .replace(/[^\p{L}]+/gu, "");
  const worthChecking = translatable.length >= 4;

  const untouched =
    sourceTexts.length > 0 &&
    sourceTexts.join(" ") === translatedTexts.join(" ");
  if (worthChecking && untouched) {
    issues.push({
      code: "UNTRANSLATED",
      blocking: true,
      detail: "identical to the source",
    });
  }

  // 6b. The script, per field (spec-21). One Bengali word must not save a romanised question, so
  //     every field is held to it on its own — except a field whose source has nothing to
  //     translate: "50 km/h" has no script to be in. Latin INSIDE a field is fine (a number, a
  //     unit, a §, the bracketed original of a name); what is required is the target script's
  //     presence, not Latin's absence.
  const script = targetScript(input.locale);
  if (script) {
    const wrongFields = fieldPairs(source, translated)
      .filter(({ from, to }) => letterCount(from) >= 4 && !script.test.test(to))
      .map(({ field }) => field);
    if (wrongFields.length > 0) {
      issues.push({
        code: "SCRIPT_MISMATCH",
        blocking: true,
        detail: wrongFields.join(", "),
      });
    }
  }

  // 6c. A letter of a foreign non-Latin script INSIDE a word of the target script. Production
  //     served "ঢوকার" — an Arabic waw in the middle of a Bengali word — and 6b passed the field
  //     because it does contain Bengali. Latin inside a word is still allowed (a unit, a code); it
  //     is the other alphabets that never belong mid-word.
  if (script) {
    const mixedFields = fieldPairs(source, translated)
      .filter(({ to }) => hasMixedScriptWord(to, script.test))
      .map(({ field }) => field);
    if (mixedFields.length > 0) {
      issues.push({
        code: "MIXED_SCRIPT_WORD",
        blocking: true,
        detail: mixedFields.join(", "),
      });
    }
  }

  // 6d. Markdown skeleton (spec-23). A translated section must keep every heading, list, table,
  //     image and link of its source: a lost heading breaks the chapter's structure, a changed
  //     image path points at nothing, and a translated link is a link to nowhere.
  if (input.entity === "LEARN_SECTION") {
    const from = markdownStructure(String((source as { text?: string }).text ?? ""));
    const to = markdownStructure(String((translated as { text?: string }).text ?? ""));
    if (from.h2 !== to.h2 || from.h3 !== to.h3) {
      issues.push({ code: "MD_HEADINGS", blocking: true, detail: `${from.h2}/${from.h3} to ${to.h2}/${to.h3}` });
    }
    if (!sameMultiset(from.images, to.images)) {
      issues.push({ code: "MD_IMAGES", blocking: true, detail: `${from.images.length} to ${to.images.length}` });
    }
    if (!sameMultiset(from.links, to.links)) {
      issues.push({ code: "MD_LINKS", blocking: true, detail: `${from.links.length} to ${to.links.length}` });
    }
    if (from.tableRows !== to.tableRows) {
      issues.push({ code: "MD_TABLE", blocking: true, detail: `${from.tableRows} to ${to.tableRows}` });
    }
    if (to.codeFences > from.codeFences) {
      issues.push({ code: "MD_CODE", blocking: true });
    }
    if (to.htmlTags > from.htmlTags) {
      issues.push({ code: "MD_HTML", blocking: true });
    }
    if (from.listItems > 0 && Math.abs(from.listItems - to.listItems) / from.listItems > 0.2) {
      issues.push({ code: "MD_LIST", blocking: false, detail: `${from.listItems} to ${to.listItems}` });
    }
  }

  // 7. Length sanity — a warning, not a block. Scripts differ in density, so this only catches a
  //    translation that has clearly lost or invented content.
  const sourceLength = sourceTexts.join(" ").length;
  const translatedLength = translatedTexts.join(" ").length;
  if (sourceLength > 40) {
    const ratio = translatedLength / sourceLength;
    if (ratio < 0.4 || ratio > 3) {
      issues.push({
        code: "LENGTH_OUTLIER",
        blocking: false,
        detail: `${Math.round(ratio * 100)}% of the source length`,
      });
    }
  }

  // 8. Brevity, per field, against the TARGET language's own budget (spec-22).
  //
  //    Non-blocking by construction. A blocking flag routes the unit to NEEDS_REVIEW, which
  //    `partitionBlockers` counts as FLAGGED — so a shortness blocker would stop German, Tamil or
  //    Arabic publishing for the crime of being themselves. It is also in NOT_A_QUALITY_FLAG, so
  //    auto-repair never spends a model call trying to shorten a faithful translation.
  // SIGN is included here although `isQuestionEntity` excludes it: a sign's meaning is the option
  // text of 574 sign questions, so it carries a word budget even though it is not a question.
  if (isQuestionEntity(input.entity) || input.entity === "SIGN") {
    const targets = schoolConfig.content.brevity;
    const optionKind: BrevityKind =
      input.entity === "SIGN" ? "signMeaning" : "option";
    const verbose = fieldPairs(source, translated).filter(({ field, to }) => {
      const kind: BrevityKind = field.startsWith("option")
        ? optionKind
        : field === "stem"
          ? "stem"
          : field === "explanation"
            ? "explanation"
            : "stem";
      if (!["stem", "explanation"].includes(field) && !field.startsWith("option"))
        return false;
      const max = wordBudget({
        kind,
        locale: input.locale,
        targets,
        mode: "ceiling",
        translation: true,
      });
      return countWords(to, input.locale) > max;
    });
    if (verbose.length > 0) {
      issues.push({
        code: "VERBOSE",
        blocking: false,
        detail: verbose
          .map(
            ({ field, to }) => `${field} ${countWords(to, input.locale)} words`,
          )
          .join(", "),
      });
    }
  }

  return { passed: !issues.some((issue) => issue.blocking), issues };
}


export function blockingCodes(check: TranslationCheck): string[] {
  return check.issues
    .filter((issue) => issue.blocking)
    .map((issue) => issue.code);
}

export function allCodes(check: TranslationCheck): string[] {
  return check.issues.map((issue) => issue.code);
}
