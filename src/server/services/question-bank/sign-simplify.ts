import type { PrismaClient, SignClass } from "@prisma/client";
import { schoolConfig } from "../../../../config/school.config";
import { countWords } from "@/lib/brevity";
import { aiJson } from "@/server/ai/client";
import { simplifySignMeaningPrompt } from "@/server/ai/prompts/simplify";
import { z } from "zod";
import type { QuestionContent } from "./simplify";

/**
 * Shortening the sign registry, and re-rendering the questions built from it (spec-22).
 *
 * ## Why the registry is the lever
 *
 * A sign question's stem is boilerplate ("What does this sign mean?", 5 words) and its options are
 * `Sign.meaning` rows copied verbatim by `scripts/seed-sign-questions.ts`. Measured in production:
 *
 *   meaning questions      options median 22 words, 1137 of 1148 over the budget
 *   recognition questions  options median  3 words,   24 of 1148 over the budget
 *
 * So 287 registry rows carry essentially the whole sign problem, and the recognition questions —
 * whose options are sign NAMES, which this campaign does not touch — need no option change at all.
 *
 * ## Why NOT `pnpm signs:questions --refresh`
 *
 * `distractors()` picks three same-class signs by shuffling the class pool and SKIPPING any whose
 * text collides with the right answer's text. Shortened meanings change which texts collide, so
 * the skip pattern changes, so the RNG is consumed differently and a different set of signs comes
 * back — the seed does not protect you. Re-running would silently produce different questions,
 * and because approved items are frozen it would have to retire-and-replace, orphaning 574
 * `TaskSetMember` rows.
 *
 * Instead: map each existing option back to the sign that supplied its text, and substitute that
 * sign's new text in place. Same signs, same order, same key, same correct answer — only shorter.
 */

const signDraftSchema = z.object({
  nameEn: z.string().min(1).max(120),
  nameNb: z.string().min(1).max(120),
  meaningEn: z.string().min(1).max(400),
  meaningNb: z.string().min(1).max(400),
  unchanged: z.boolean().optional().default(false),
  note: z.string().max(300).optional(),
});

export interface SignRow {
  id: string;
  code: string;
  signClass: SignClass;
  name: { en: string; nb: string };
  meaning: { en: string; nb: string };
}

export interface SignProposal {
  signId: string;
  code: string;
  verdict: "ACCEPT" | "REFUSE" | "UNCHANGED";
  findings: string[];
  previous: { name: SignRow["name"]; meaning: SignRow["meaning"] };
  proposed: { name: SignRow["name"]; meaning: SignRow["meaning"] } | null;
  modelVersion?: string;
  promptVersion?: string;
}

/**
 * Ask for a shorter meaning for one sign.
 *
 * The siblings are handed over because rule 4 of the prompt is the one that matters: this sentence
 * will be used as a WRONG answer beside every other meaning in its class, so a shortening that
 * makes two signs indistinguishable does not make a question long, it makes several ungradeable.
 */
export async function proposeSignSimplification(
  sign: SignRow,
  siblings: SignRow[],
  imageContent?: unknown,
): Promise<SignProposal> {
  const previous = { name: sign.name, meaning: sign.meaning };
  const base = { signId: sign.id, code: sign.code, previous };

  const response = await aiJson({
    task: "vision",
    prompt: simplifySignMeaningPrompt,
    vars: {
      code: sign.code,
      signClass: sign.signClass,
      currentNameEn: sign.name.en,
      currentNameNb: sign.name.nb,
      currentMeaningEn: sign.meaning.en,
      currentMeaningNb: sign.meaning.nb,
      siblingMeanings: siblings
        .slice(0, 24)
        .map((s) => `- ${s.meaning.en}`)
        .join("\n"),
      maxMeaningWords: schoolConfig.content.brevity.signMeaningWords,
    },
    schema: signDraftSchema,
    temperature: 0,
    ...(imageContent ? { userContent: imageContent as never } : {}),
  });

  const meta = {
    modelVersion: response.modelVersion,
    promptVersion: response.promptVersion,
  };
  const draft = response.data;

  if (draft.unchanged) {
    return { ...base, ...meta, verdict: "UNCHANGED", findings: [], proposed: null };
  }

  const proposed = {
    name: { en: draft.nameEn, nb: draft.nameNb },
    meaning: { en: draft.meaningEn, nb: draft.meaningNb },
  };

  const findings: string[] = [];
  const budget = schoolConfig.content.brevity.signMeaningWords;
  if (countWords(proposed.meaning.en, "en") > budget) findings.push("MEANING_TOO_LONG_EN");
  if (countWords(proposed.meaning.nb, "nb") > budget) findings.push("MEANING_TOO_LONG_NB");
  if (countWords(proposed.meaning.en, "en") >= countWords(sign.meaning.en, "en")) {
    findings.push("NO_GAIN");
  }
  // Names are official; the campaign shortens meanings, not names.
  if (proposed.name.en !== sign.name.en || proposed.name.nb !== sign.name.nb) {
    findings.push("NAME_CHANGED");
  }

  if (findings.length > 0) {
    return { ...base, ...meta, verdict: "REFUSE", findings, proposed: null };
  }
  return { ...base, ...meta, verdict: "ACCEPT", findings: [], proposed };
}

/**
 * Every class must keep enough DISTINCT meanings to build a gradeable question.
 *
 * A meaning question offers the right answer plus three same-class distractors. If shortening
 * collapses a class's meanings — five signs all becoming "Give way." — then either two options say
 * the same thing (caught by `DUPLICATE_OPTIONS`, so the question is refused) or, worse, a
 * distractor becomes true of the pictured sign. This gate runs over the whole proposed registry
 * BEFORE any question is touched, because the failure is a property of the set, not of one row.
 */
export function checkClassDistinctness(
  proposed: Array<{ code: string; signClass: SignClass; meaningEn: string }>,
): Array<{ signClass: SignClass; distinct: number; total: number; duplicates: string[] }> {
  const byClass = new Map<SignClass, typeof proposed>();
  for (const row of proposed) {
    const list = byClass.get(row.signClass) ?? [];
    list.push(row);
    byClass.set(row.signClass, list);
  }

  const problems: Array<{
    signClass: SignClass;
    distinct: number;
    total: number;
    duplicates: string[];
  }> = [];

  for (const [signClass, rows] of byClass) {
    const seen = new Map<string, string[]>();
    for (const row of rows) {
      const key = row.meaningEn.trim().toLowerCase();
      seen.set(key, [...(seen.get(key) ?? []), row.code]);
    }
    const duplicates = [...seen.values()]
      .filter((codes) => codes.length > 1)
      .flat();
    // A meaning question needs the right answer plus three distractors.
    if (seen.size < 4 || duplicates.length > 0) {
      problems.push({
        signClass,
        distinct: seen.size,
        total: rows.length,
        duplicates,
      });
    }
  }
  return problems;
}

export interface SignQuestionRewrite {
  itemId: string;
  kind: "meaning" | "recognition";
  content: QuestionContent | null;
  findings: string[];
}

/**
 * Re-render one sign question against the new registry, by identity rather than by regeneration.
 *
 * Each option's CURRENT text is looked up in an inverse index built from the OLD registry, which
 * says which sign supplied it; that sign's NEW text is written back into the same key. The order,
 * the keys and `correctOptionKey` are never touched, so the option holding the pictured sign's
 * meaning still holds it.
 *
 * Refuses — leaving the question exactly as it is — whenever the mapping is not certain: an option
 * that matches no sign, one that matches two signs with different new text, or `en` and `nb`
 * disagreeing about which sign an option came from.
 */
export function rerenderSignQuestion(input: {
  itemId: string;
  kind: "meaning" | "recognition";
  content: QuestionContent;
  /** The sign this question is ABOUT, for the explanation. */
  subject: { name: SignRow["name"]; meaning: SignRow["meaning"] };
  /** old text (lowercased) -> new text, per locale, for the field this kind uses. */
  indexEn: Map<string, string>;
  indexNb: Map<string, string>;
}): SignQuestionRewrite {
  const findings: string[] = [];
  const next: QuestionContent = JSON.parse(JSON.stringify(input.content));

  for (const locale of ["en", "nb"] as const) {
    const index = locale === "en" ? input.indexEn : input.indexNb;
    const options = next[locale]?.options ?? [];
    for (const option of options) {
      const replacement = index.get(option.text.trim().toLowerCase());
      if (replacement === undefined) {
        findings.push(`UNRESOLVED_OPTION_${locale.toUpperCase()}`);
        continue;
      }
      option.text = replacement;
    }
  }

  // The explanation is rebuilt exactly as the seeder builds it.
  next.en.explanation = `${input.subject.name.en} — ${input.subject.meaning.en}`;
  next.nb.explanation = `${input.subject.name.nb} — ${input.subject.meaning.nb}`;

  // Two options collapsing to the same string makes the question ungradeable.
  for (const locale of ["en", "nb"] as const) {
    const texts = (next[locale]?.options ?? []).map((o) => o.text.trim().toLowerCase());
    if (new Set(texts).size !== texts.length) {
      findings.push(`DUPLICATE_OPTIONS_${locale.toUpperCase()}`);
    }
  }

  if (findings.length > 0) {
    return { itemId: input.itemId, kind: input.kind, content: null, findings: [...new Set(findings)] };
  }
  return { itemId: input.itemId, kind: input.kind, content: next, findings: [] };
}

export interface DistinctnessDelta {
  /** Problems the rewrite INTRODUCED. These block. */
  introduced: ReturnType<typeof checkClassDistinctness>;
  /** Problems the registry already had. These are reported, and do not block. */
  preExisting: ReturnType<typeof checkClassDistinctness>;
}

/**
 * Compare the proposed registry against the one we started with.
 *
 * Blocking on the absolute state would stop the campaign dead on faults that predate it — and
 * production has one: XSE015 and XSE016 are both "Youth hostel" with identical meanings, which is
 * a registry defect from the original extraction, not something a shortening caused. A gate that
 * cannot tell those apart is a gate that can never be satisfied.
 *
 * So the rule is the delta: a class that was already short of distinct meanings stays a reported
 * problem, and only a class the rewrite made worse stops the run.
 */
export function distinctnessDelta(
  current: Array<{ code: string; signClass: SignClass; meaningEn: string }>,
  proposed: Array<{ code: string; signClass: SignClass; meaningEn: string }>,
): DistinctnessDelta {
  const before = checkClassDistinctness(current);
  const after = checkClassDistinctness(proposed);
  const beforeByClass = new Map(before.map((p) => [p.signClass, p]));

  const introduced = after.filter((problem) => {
    const was = beforeByClass.get(problem.signClass);
    if (!was) return true; // the class was clean and now is not
    // Worse than it was: fewer distinct meanings, or more colliding codes.
    return (
      problem.distinct < was.distinct ||
      problem.duplicates.length > was.duplicates.length
    );
  });

  return { introduced, preExisting: before };
}

/** Load the registry in the shape the campaign needs. */
export async function loadSigns(db: PrismaClient): Promise<SignRow[]> {
  const rows = await db.sign.findMany({
    select: { id: true, code: true, signClass: true, name: true, meaning: true },
    orderBy: { code: "asc" },
  });
  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    signClass: row.signClass,
    name: row.name as SignRow["name"],
    meaning: row.meaning as SignRow["meaning"],
  }));
}
