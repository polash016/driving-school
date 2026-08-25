import type { TranslatableEntity } from "@prisma/client";
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
/** Legal references: "§ 7", "§ 13 nr. 3", "§ 7-2". */
const SECTION_PATTERN = /§\s*[\d\p{L}.\-\s]*\d/gu;
/** ICU placeholders in UI messages: {count}, {minutes}. */
const PLACEHOLDER_PATTERN = /\{[a-zA-Z][a-zA-Z0-9]*\}/g;
/** Template slots in question text. */
const SLOT_PATTERN = /\{\{[^}]+\}\}/g;

/**
 * Unicode ranges that prove a translation is actually in the target script.
 *
 * Only for scripts that differ from Latin — for Spanish or Polish "did it change at all" is the
 * only available signal, and that is covered separately.
 */
const SCRIPT_RANGES: Record<string, RegExp> = {
  ar: /[؀-ۿ]/,
  fa: /[؀-ۿ]/,
  ur: /[؀-ۿ]/,
  ru: /[Ѐ-ӿ]/,
  uk: /[Ѐ-ӿ]/,
  el: /[Ͱ-Ͽ]/,
  he: /[֐-׿]/,
  hi: /[ऀ-ॿ]/,
  th: /[฀-๿]/,
  zh: /[一-鿿]/,
  ja: /[぀-ヿ一-鿿]/,
  ko: /[가-힯]/,
};

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

function collect(text: string, pattern: RegExp): string[] {
  return (text.match(pattern) ?? []).map((match) => match.replace(/\s+/g, " ").trim());
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
  if (translatedTexts.length === 0 || translatedTexts.some((text) => text.trim().length === 0)) {
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
    if (input.correctOptionKey && !translatedKeys.includes(input.correctOptionKey)) {
      issues.push({ code: "ANSWER_KEY_LOST", blocking: true, detail: input.correctOptionKey });
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
      issues.push({ code, blocking: true, detail: `${before.join(", ")} to ${after.join(", ")}` });
    }
  }

  // 6. Did anything actually get translated? A model that echoes its input is a silent failure.
  const untouched = sourceTexts.length > 0 && sourceTexts.join(" ") === translatedTexts.join(" ");
  const scriptCheck = SCRIPT_RANGES[input.locale.split("-")[0]];
  const wrongScript =
    scriptCheck !== undefined && !translatedTexts.some((text) => scriptCheck.test(text));
  if (untouched || wrongScript) {
    issues.push({
      code: "UNTRANSLATED",
      blocking: true,
      detail: wrongScript ? "no character in the target script" : "identical to the source",
    });
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

  return { passed: !issues.some((issue) => issue.blocking), issues };
}

export function blockingCodes(check: TranslationCheck): string[] {
  return check.issues.filter((issue) => issue.blocking).map((issue) => issue.code);
}

export function allCodes(check: TranslationCheck): string[] {
  return check.issues.map((issue) => issue.code);
}
