import type { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";

/**
 * Pre-approval quality gate (spec-04b).
 *
 * A pass mark here decides whether a student is allowed to sit the official teoriprøve, so a
 * wrong or ambiguous question is not a cosmetic defect. These checks run before a reviewer can
 * approve, and again at approval time — a question cannot reach a student until they pass.
 *
 * `errors` block approval. `warnings` are shown to the reviewer and do not block: they flag
 * test-writing smells that are usually — but not always — a mistake.
 *
 * Deterministic only. Semantic duplicate detection and bilingual-equivalence judging need
 * embeddings and an AI judge; they arrive with spec-05/06 and stack on top of this.
 */

export interface QualityIssue {
  code: string;
  messageKey: string;
  locale?: "en" | "nb";
  detail?: string;
}

export interface QualityReport {
  errors: QualityIssue[];
  warnings: QualityIssue[];
  passed: boolean;
}

interface CheckableItem {
  id?: string;
  content: unknown;
  correctOptionKey: string | null;
  legalCitations: unknown;
  difficulty?: number;
}

type Side = { stem?: string; options?: { key: string; text: string }[]; explanation?: string };

const MIN_OPTIONS = 3;
const MAX_STEM_LENGTH = 400;
/** A correct answer this much longer than the average distractor gives itself away. */
const LENGTH_TELL_RATIO = 1.6;
const PLACEHOLDER = /\{\{\s*[a-zA-Z][a-zA-Z0-9_]*\s*\}\}/;
/** Option texts that make a question ambiguous to grade and are banned outright. */
const BANNED_OPTION_PATTERNS = [
  /^all of the above$/i,
  /^none of the above$/i,
  /^both a and b$/i,
  /^alle (de )?(ovenfor|over)$/i,
  /^ingen av (disse|alternativene|de over)$/i,
];

/** Normalised stem, used to catch a question that already exists in the approved pool. */
export function stemFingerprint(content: unknown): string {
  const sides = content as { en?: Side; nb?: Side } | null;
  const normalise = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  const joined = [sides?.en?.stem ?? "", sides?.nb?.stem ?? ""].map(normalise).join("|");
  return createHash("sha256").update(joined).digest("hex");
}

export function checkItemQuality(item: CheckableItem): QualityReport {
  const errors: QualityIssue[] = [];
  const warnings: QualityIssue[] = [];
  const content = item.content as { en?: Side; nb?: Side } | null;

  for (const locale of ["en", "nb"] as const) {
    const side = content?.[locale];

    if (!side?.stem?.trim()) {
      errors.push({ code: "STEM_MISSING", messageKey: "admin.quality.stemMissing", locale });
      continue;
    }
    if (PLACEHOLDER.test(side.stem)) {
      errors.push({
        code: "PLACEHOLDER_LEFT",
        messageKey: "admin.quality.placeholderLeft",
        locale,
      });
    }
    if (side.stem.length > MAX_STEM_LENGTH) {
      warnings.push({ code: "STEM_LONG", messageKey: "admin.quality.stemLong", locale });
    }
    if (!side.explanation?.trim()) {
      errors.push({
        code: "EXPLANATION_MISSING",
        messageKey: "admin.quality.explanationMissing",
        locale,
      });
    }

    const options = side.options ?? [];
    if (options.length < MIN_OPTIONS) {
      errors.push({ code: "TOO_FEW_OPTIONS", messageKey: "admin.quality.tooFewOptions", locale });
    }

    const texts = options.map((option) => option.text.trim().toLowerCase());
    if (new Set(texts).size !== texts.length) {
      errors.push({
        code: "DUPLICATE_OPTIONS",
        messageKey: "admin.quality.duplicateOptions",
        locale,
      });
    }
    if (texts.some((text) => text.length === 0)) {
      errors.push({ code: "EMPTY_OPTION", messageKey: "admin.quality.emptyOption", locale });
    }
    for (const option of options) {
      if (BANNED_OPTION_PATTERNS.some((pattern) => pattern.test(option.text.trim()))) {
        errors.push({
          code: "BANNED_OPTION",
          messageKey: "admin.quality.bannedOption",
          locale,
          detail: option.text,
        });
      }
      if (PLACEHOLDER.test(option.text)) {
        errors.push({
          code: "PLACEHOLDER_LEFT",
          messageKey: "admin.quality.placeholderLeft",
          locale,
        });
      }
    }
  }

  // Option keys must be identical across locales — the engine serves one shuffled key order to
  // both, so a mismatch would mean the two languages grade differently.
  const enKeys = (content?.en?.options ?? []).map((option) => option.key).join(",");
  const nbKeys = (content?.nb?.options ?? []).map((option) => option.key).join(",");
  if (enKeys !== nbKeys) {
    errors.push({ code: "KEY_MISMATCH", messageKey: "admin.quality.keyMismatch" });
  }

  if (!item.correctOptionKey) {
    errors.push({ code: "ANSWER_MISSING", messageKey: "admin.quality.answerMissing" });
  } else if (enKeys && !enKeys.split(",").includes(item.correctOptionKey)) {
    errors.push({ code: "ANSWER_UNKNOWN", messageKey: "admin.quality.answerUnknown" });
  }

  const citations = (item.legalCitations ?? []) as { sourceCode?: string; ref?: string }[];
  if (!Array.isArray(citations) || citations.length === 0) {
    // No citation, no question: every answer must be traceable to the rule it comes from.
    errors.push({ code: "CITATION_MISSING", messageKey: "admin.quality.citationMissing" });
  } else if (citations.some((citation) => !citation.sourceCode?.trim() || !citation.ref?.trim())) {
    errors.push({ code: "CITATION_INCOMPLETE", messageKey: "admin.quality.citationIncomplete" });
  }

  // Length tell: if the right answer is markedly longer than the distractors, a test-wise
  // student picks it without knowing the rule.
  for (const locale of ["en", "nb"] as const) {
    const options = content?.[locale]?.options ?? [];
    const correct = options.find((option) => option.key === item.correctOptionKey);
    const distractors = options.filter((option) => option.key !== item.correctOptionKey);
    if (!correct || distractors.length === 0) continue;

    const meanDistractor =
      distractors.reduce((sum, option) => sum + option.text.length, 0) / distractors.length;
    if (meanDistractor > 0 && correct.text.length > meanDistractor * LENGTH_TELL_RATIO) {
      warnings.push({ code: "LENGTH_TELL", messageKey: "admin.quality.lengthTell", locale });
    }
  }

  return { errors, warnings, passed: errors.length === 0 };
}

/**
 * The same checks plus the ones needing the database: an approved question with the same stem
 * already in the pool. Exact-after-normalisation only — semantic near-duplicates need
 * embeddings (spec-05).
 */
export async function checkItemQualityAgainstPool(
  db: PrismaClient,
  item: CheckableItem,
): Promise<QualityReport> {
  const report = checkItemQuality(item);
  const fingerprint = stemFingerprint(item.content);

  const candidates = await db.masterItem.findMany({
    where: {
      deletedAt: null,
      status: { in: ["APPROVED", "IN_REVIEW"] },
      ...(item.id ? { id: { not: item.id } } : {}),
    },
    select: { id: true, content: true },
  });

  const duplicate = candidates.find(
    (candidate) => stemFingerprint(candidate.content) === fingerprint,
  );
  if (duplicate) {
    report.errors.push({
      code: "DUPLICATE_ITEM",
      messageKey: "admin.quality.duplicateItem",
      detail: duplicate.id,
    });
  }

  return { ...report, passed: report.errors.length === 0 };
}
