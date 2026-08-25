import type { Prisma, PrismaClient, RejectionSource } from "@prisma/client";
import { logger } from "@/lib/logger";

/**
 * The rejection ledger — what the AI is not allowed to write again.
 *
 * Every refusal is kept: the quality gate's, the duplicate check's, and a reviewer's. Before the
 * next generation run the recent refusals for that topic are handed back to the model as worked
 * examples ("this stem was rejected, here is why"), which is the only feedback loop that makes a
 * model better at *this school's* standards rather than at questions in general.
 *
 * Rejections are never deleted. A shrinking teaching set would let old mistakes come back.
 */

/** How many past refusals a prompt carries. Enough to teach, small enough to leave room for law. */
const LESSON_LIMIT = 12;
/** A stem longer than this is trimmed in the prompt — the mistake is visible in the opening clause. */
const LESSON_STEM_CHARS = 160;

export interface RecordRejectionInput {
  source: RejectionSource;
  stemEn: string;
  stemNb?: string | null;
  reasonCodes: string[];
  note?: string | null;
  topicId?: string | null;
  batchId?: string | null;
  masterItemId?: string | null;
  modelVersion?: string | null;
  promptVersion?: string | null;
  createdById?: string | null;
}

/**
 * Write one refusal to the ledger. Deliberately non-throwing: losing a teaching example must never
 * fail the review click or the generation run that produced it.
 */
export async function recordRejection(
  db: PrismaClient | Prisma.TransactionClient,
  input: RecordRejectionInput,
): Promise<void> {
  try {
    await db.generationRejection.create({
      data: {
        source: input.source,
        stemEn: input.stemEn.slice(0, 400),
        stemNb: input.stemNb?.slice(0, 400) ?? null,
        reasonCodes: input.reasonCodes,
        note: input.note?.trim() ? input.note.trim().slice(0, 1000) : null,
        topicId: input.topicId ?? null,
        batchId: input.batchId ?? null,
        masterItemId: input.masterItemId ?? null,
        modelVersion: input.modelVersion ?? null,
        promptVersion: input.promptVersion ?? null,
        createdById: input.createdById ?? null,
      },
      select: { id: true },
    });
  } catch (error) {
    logger.warn(
      { source: input.source, error },
      "rejection ledger write failed",
    );
  }
}

/** Human-readable gloss per reason code — what the model should take from it. */
const LESSON_BY_CODE: Record<string, string> = {
  MISSING_CITATION: "it did not cite the law it was testing",
  DUPLICATE_IN_BATCH: "it repeated another question from the same run",
  DUPLICATE_OF_EXISTING: "that question had already been written",
  DUPLICATE_STEM: "that question had already been written",
  NO_CORRECT_OPTION: "no option was actually correct",
  MULTIPLE_CORRECT: "more than one option could be defended as correct",
  TOO_FEW_OPTIONS: "it had fewer than three usable options",
  DUPLICATE_OPTION: "two options said the same thing",
  EMPTY_OPTION: "an option was empty",
  BANNED_OPTION: "it used 'all of the above' or similar",
  MISSING_LOCALE: "one language was missing or incomplete",
  PLACEHOLDER_TEXT: "it still contained placeholder text",
  WRONG_ANSWER: "the answer marked correct was wrong",
  AMBIGUOUS_DISTRACTOR: "a wrong option was arguably also correct",
  CITATION_MISMATCH: "the citation did not support the question",
  DUPLICATE: "it repeated a question already in the bank",
  LANGUAGE_QUALITY:
    "the Norwegian or English was poor or the two did not match",
  IMAGE_MISMATCH: "it described something the image does not show",
  OUT_OF_SCOPE: "it was outside what a Class B learner is examined on",
  OTHER: "a reviewer rejected it",
};

function glossFor(codes: string[]): string {
  const glosses = codes.map((code) => LESSON_BY_CODE[code]).filter(Boolean);
  return glosses.length > 0 ? glosses.join("; ") : "it was rejected on review";
}

export interface RejectionLessons {
  /** Prompt-ready block. Empty string when nothing has been rejected yet. */
  block: string;
  /** Reason codes ordered by how often they have cost us a question. */
  topReasons: Array<{ code: string; count: number }>;
  used: number;
}

/**
 * Build the "do not write these again" section of a generation prompt.
 *
 * Reviewer refusals come first — a human saying why a question was wrong is the strongest signal
 * available, and their free-text note (when they left one) is quoted verbatim.
 *
 * Query plan: `GenerationRejection_topicId_createdAt_idx` (topicId, createdAt DESC) serves both
 * branches; the count aggregate scans the same index range.
 */
export async function buildRejectionLessons(
  db: PrismaClient,
  topicId: string | null,
): Promise<RejectionLessons> {
  const where: Prisma.GenerationRejectionWhereInput = topicId
    ? { topicId }
    : {};

  const [reviewer, machine, grouped] = await Promise.all([
    db.generationRejection.findMany({
      where: { ...where, source: "REVIEWER" },
      orderBy: { createdAt: "desc" },
      take: LESSON_LIMIT,
      select: { stemEn: true, reasonCodes: true, note: true },
    }),
    db.generationRejection.findMany({
      where: { ...where, source: { in: ["GATE", "DUPLICATE"] } },
      orderBy: { createdAt: "desc" },
      take: LESSON_LIMIT,
      select: { stemEn: true, reasonCodes: true, note: true },
    }),
    db.generationRejection.groupBy({
      by: ["reasonCodes"],
      where,
      _count: { _all: true },
      orderBy: { _count: { reasonCodes: "desc" } },
      take: 20,
    }),
  ]);

  const counts = new Map<string, number>();
  for (const row of grouped) {
    for (const code of row.reasonCodes) {
      counts.set(code, (counts.get(code) ?? 0) + row._count._all);
    }
  }
  const topReasons = [...counts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // Reviewers first, then the gate, capped so the law still dominates the prompt.
  const rows = [...reviewer, ...machine].slice(0, LESSON_LIMIT);
  if (rows.length === 0) {
    return { block: "", topReasons, used: 0 };
  }

  const lines = rows.map((row, index) => {
    const stem = row.stemEn.slice(0, LESSON_STEM_CHARS);
    const note = row.note ? ` Reviewer: "${row.note.slice(0, 200)}"` : "";
    return `${index + 1}. "${stem}" — rejected because ${glossFor(row.reasonCodes)}.${note}`;
  });

  const summary =
    topReasons.length > 0
      ? `Most frequent reasons so far: ${topReasons
          .map((reason) => `${reason.code} (${reason.count})`)
          .join(", ")}. Avoid these above all.`
      : "";

  return {
    block: [
      "LEARN FROM THESE REJECTIONS — real questions that were refused for this school.",
      "Do not write anything resembling them, and do not repeat the mistake they were rejected for:",
      ...lines,
      summary,
    ]
      .filter(Boolean)
      .join("\n"),
    topReasons,
    used: rows.length,
  };
}
