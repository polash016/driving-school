import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { AiPipelineError, NotFoundError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { aiJson } from "@/server/ai/client";
import { theoryGenerationPrompt } from "@/server/ai/prompts";
import { AUDIT, auditLog } from "@/server/audit";
import type { SessionUser } from "@/server/authz";
import { pickBilingualText } from "@/lib/i18n-content";
import { search } from "@/server/services/kb/search";
import { checkItemQuality } from "@/server/services/question-bank/validation";
import {
  buildRejectionLessons,
  recordRejection,
} from "@/server/services/question-bank/rejections";
import {
  classifyAgainstPool,
  cosine,
  embedStems,
  REPEAT_THRESHOLD,
  storeStemEmbedding,
} from "@/server/services/question-bank/similarity";

/**
 * AI question generation, no image required (spec-05/06).
 *
 * The shape of the thing: retrieve the law for a topic → ask the model for candidates grounded in
 * exactly those excerpts → run every candidate through the same quality gate a human-written
 * question must pass → save the survivors as DRAFTs in a set, for review.
 *
 * Nothing here reaches a student. Generated questions land in the review queue like any other
 * draft, and an AI-authored question needs two reviewers before it goes live (spec-04b).
 */

const MIN_EXCERPTS = 3;

const optionSchema = z.object({
  key: z.string().min(1).max(2),
  text: z.string().min(1).max(300),
});

const localizedSchema = z.object({
  stem: z.string().min(10).max(400),
  options: z.array(optionSchema).min(3).max(4),
  explanation: z.string().min(10).max(1000),
});

/** The model must answer in exactly this shape; anything else fails at the gateway. */
const candidateSchema = z.object({
  en: localizedSchema,
  nb: localizedSchema,
  correctOptionKey: z.string().min(1).max(2),
  difficulty: z.number().int().min(1).max(5),
  citations: z
    .array(z.object({ sourceCode: z.string().min(1), ref: z.string().min(1) }))
    .min(1),
  /** What this question actually tests — makes the model commit to one point per question. */
  testsPoint: z.string().min(3).max(200).optional(),
});

/**
 * Models vary on whether they wrap a list: some answer `{questions: [...]}`, some a bare array.
 * Both are accepted and normalised — rejecting a good batch over its envelope would be silly.
 */
const generationResponseSchema = z.union([
  z.object({ questions: z.array(candidateSchema).min(1).max(10) }),
  z
    .array(candidateSchema)
    .min(1)
    .max(10)
    .transform((questions) => ({ questions })),
]);

export interface GenerationOutcome {
  batchId: string;
  requested: number;
  returned: number;
  accepted: number;
  /** Candidates the model repeated — from this batch or from something already written. */
  duplicates: number;
  /** Kept as an alternate phrasing of an existing question (never served together). */
  alternates: number;
  rejected: Array<{ stem: string; reasons: string[] }>;
}

/**
 * A test that is all easy questions rehearses nothing. The brief asks for a spread and the batch
 * is checked against it — the model reliably drifts to level 1–2 when left alone (measured: 21
 * level-1, 45 level-2, 3 level-3, none above, across 69 questions).
 */
function difficultyBriefFor(count: number): string {
  const easy = Math.max(1, Math.round(count * 0.3));
  const hard = Math.max(1, Math.round(count * 0.3));
  const medium = Math.max(0, count - easy - hard);
  return [
    "DIFFICULTY — spread them deliberately, do not write everything at the same level:",
    `- about ${easy} at difficulty 1–2: a single rule, stated plainly.`,
    `- about ${medium} at difficulty 3: the rule applied to an ordinary situation.`,
    `- about ${hard} at difficulty 4–5: two rules interacting, an exception, or a situation where the obvious answer is wrong.`,
    "Set the `difficulty` field honestly — it decides who sees the question.",
  ].join("\n");
}

export async function generateTheoryQuestions(
  db: PrismaClient,
  actor: SessionUser,
  input: { topicId: string; count: number; licenseClassId?: string | null },
): Promise<GenerationOutcome> {
  const topic = await db.topic.findFirst({
    where: { id: input.topicId, deletedAt: null },
    select: { id: true, slug: true, name: true },
  });
  if (!topic) throw new NotFoundError({ topicId: input.topicId });

  const topicName = pickBilingualText(topic.name, "en") || topic.slug;

  // Retrieve the law first. No excerpts, no generation — a question nobody can trace to a rule is
  // exactly what this platform must not produce.
  const retrieval = await search(db, {
    query: `${topicName} regler krav plikt`,
    limit: 8,
  });
  if (retrieval.hits.length < MIN_EXCERPTS) {
    throw new AiPipelineError({
      topicId: topic.id,
      found: retrieval.hits.length,
      reason: "not enough knowledge-base material for this topic",
    });
  }

  const existing = await db.masterItem.findMany({
    where: { topicId: topic.id, deletedAt: null },
    select: { content: true },
    take: 25,
    orderBy: { createdAt: "desc" },
  });
  const avoidStems = existing
    .map((item) => (item.content as { en?: { stem?: string } })?.en?.stem)
    .filter((stem): stem is string => Boolean(stem))
    .map((stem) => `- ${stem}`)
    .join("\n");

  // What has already been refused on this topic — the model is shown its own past mistakes.
  const lessons = await buildRejectionLessons(db, topic.id);

  const kbExcerpts = retrieval.hits
    .map((hit) => `[${hit.sourceCode} ${hit.ref}]\n${hit.text}`)
    .join("\n\n");

  const batch = await db.generationBatch.create({
    data: {
      kind: "THEORY",
      status: "RUNNING",
      topicId: topic.id,
      licenseClassId: input.licenseClassId ?? null,
      requestedCount: input.count,
      createdById: actor.id,
      notes: `${topicName} · ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
    },
    select: { id: true },
  });

  let result;
  try {
    result = await aiJson({
      task: "generation",
      prompt: theoryGenerationPrompt,
      vars: {
        topicName,
        kbExcerpts,
        candidateCount: input.count,
        avoidStems,
        difficultyBrief: difficultyBriefFor(input.count),
        rejectionLessons: lessons.block,
      },
      schema: generationResponseSchema,
      temperature: 0.7,
      maxTokens: 8192,
    });
  } catch (error) {
    await db.generationBatch.update({
      where: { id: batch.id },
      data: { status: "FAILED", notes: `${topicName} — generation failed` },
      select: { id: true },
    });
    throw error;
  }

  const rejected: GenerationOutcome["rejected"] = [];
  let accepted = 0;
  let duplicates = 0;
  let alternates = 0;

  /** Report the refusal to the caller and file it as a lesson for the next run. */
  const refuse = async (
    candidate: { en: { stem: string }; nb: { stem: string } },
    reasons: string[],
    source: "GATE" | "DUPLICATE",
  ) => {
    rejected.push({ stem: candidate.en.stem.slice(0, 120), reasons });
    await recordRejection(db, {
      source,
      stemEn: candidate.en.stem,
      stemNb: candidate.nb.stem,
      reasonCodes: reasons,
      topicId: topic.id,
      batchId: batch.id,
      modelVersion: result.modelVersion,
      promptVersion: result.promptVersion,
      createdById: actor.id,
    });
  };

  // Embed every candidate once, then compare against both this batch and the whole bank.
  const embeddings = await embedStems(
    result.data.questions.map((candidate) => ({
      en: candidate.en.stem,
      nb: candidate.nb.stem,
    })),
  );
  const keptEmbeddings: number[][] = [];

  for (const [index, candidate] of result.data.questions.entries()) {
    const content = {
      en: {
        stem: candidate.en.stem,
        options: candidate.en.options,
        explanation: candidate.en.explanation,
      },
      nb: {
        stem: candidate.nb.stem,
        options: candidate.nb.options,
        explanation: candidate.nb.explanation,
      },
    };

    // The same gate a human-written question faces — the model does not get an easier standard.
    const quality = checkItemQuality({
      content,
      correctOptionKey: candidate.correctOptionKey,
      legalCitations: candidate.citations,
    });
    if (!quality.passed) {
      await refuse(
        candidate,
        quality.errors.map((issue) => issue.code),
        "GATE",
      );
      continue;
    }

    // Repeated within this batch? The model does this constantly when asked for several at once.
    const embedding = embeddings[index];
    const twinInBatch = keptEmbeddings.some(
      (kept) => cosine(kept, embedding) >= REPEAT_THRESHOLD,
    );
    if (twinInBatch) {
      duplicates++;
      await refuse(candidate, ["DUPLICATE_IN_BATCH"], "DUPLICATE");
      continue;
    }

    // Already written before? Retired ones count: re-writing a rejected question is a loop.
    const verdict = await classifyAgainstPool(db, embedding);
    if (verdict.kind === "repeat") {
      duplicates++;
      await refuse(candidate, ["DUPLICATE_OF_EXISTING"], "DUPLICATE");
      continue;
    }
    if (verdict.kind === "alternate") alternates++;

    const created = await db.masterItem.create({
      data: {
        type: "TEXT",
        status: "DRAFT",
        topicId: topic.id,
        licenseClassId: input.licenseClassId ?? null,
        difficulty: candidate.difficulty,
        content,
        correctOptionKey: candidate.correctOptionKey,
        legalCitations: candidate.citations,
        createdBy: "AI",
        createdById: actor.id,
        modelVersion: result.modelVersion,
        promptVersion: result.promptVersion,
        batchId: batch.id,
      },
      select: { id: true },
    });

    await storeStemEmbedding(
      db,
      created.id,
      embedding,
      verdict.conceptGroupId ?? null,
    );
    keptEmbeddings.push(embedding);
    accepted++;
  }

  await db.generationBatch.update({
    where: { id: batch.id },
    data: {
      status: "READY",
      modelVersion: result.modelVersion,
      promptVersion: result.promptVersion,
    },
    select: { id: true },
  });

  await auditLog({
    actorId: actor.id,
    action: AUDIT.questionsGenerated,
    entityType: "GenerationBatch",
    entityId: batch.id,
    meta: {
      topic: topic.slug,
      requested: input.count,
      returned: result.data.questions.length,
      accepted,
      duplicates,
      alternates,
      rejected: rejected.length,
      lessonsUsed: lessons.used,
      model: result.modelVersion,
    },
  });

  logger.info(
    {
      batchId: batch.id,
      topic: topic.slug,
      accepted,
      rejected: rejected.length,
    },
    "theory questions generated",
  );

  return {
    batchId: batch.id,
    requested: input.count,
    returned: result.data.questions.length,
    accepted,
    duplicates,
    alternates,
    rejected,
  };
}
