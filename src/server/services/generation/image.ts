import type { PrismaClient, SignClass } from "@prisma/client";
import { z } from "zod";
import { AiPipelineError, NotFoundError, ValidationError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { aiJson } from "@/server/ai/client";
import { imageQuestionPrompt } from "@/server/ai/prompts";
import { AUDIT, auditLog } from "@/server/audit";
import type { SessionUser } from "@/server/authz";
import { contextSheetSchema, type ContextSheet } from "@/server/contracts/image-pipeline";
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
import {
  checkDistractorDistinctness,
  checkStemDoesNotLeakAnswer,
  checkStemHidesTheSign,
  verifyAnswerBlind,
} from "@/server/services/pipeline/validators";

/**
 * Mode 2 — questions drafted from a photograph the school uploaded (spec-06).
 *
 * Deliberately the same shape as `generation/theory.ts`: retrieve the law → draft candidates
 * grounded in exactly those excerpts → put every candidate through the gate a human-written
 * question must pass → save survivors as DRAFTs for review. What differs is only the grounding
 * (a context sheet rather than a topic) and two extra checks that a picture makes necessary.
 *
 * Nothing here reaches a student: an AI-authored question needs two reviewers (spec-04b).
 */

const MIN_EXCERPTS = 2;
/** The regulations a question about a road scene can legitimately rest on. */
const SOURCES = ["skiltforskriften", "trafikkreglene"];

/** Where each sign class lives in the topic tree, mirroring `scripts/seed-sign-questions.ts`. */
const TOPIC_FOR_CLASS: Record<SignClass, string> = {
  FARE: "warning-signs",
  FORBUD: "prohibition-mandatory-signs",
  PABUD: "prohibition-mandatory-signs",
  VIKEPLIKT_OG_FORKJORS: "priority-yield-signs",
  OPPLYSNING: "information-signs",
  SERVICE: "information-signs",
  VEGVISNING: "information-signs",
  UNDERSKILT: "information-signs",
  MARKERING: "road-markings",
};
/** A picture with no identified sign is still a traffic situation. */
const FALLBACK_TOPIC = "right-of-way";

const optionSchema = z.object({ key: z.string().min(1).max(2), text: z.string().min(1).max(300) });
const localizedSchema = z.object({
  stem: z.string().min(10).max(400),
  options: z.array(optionSchema).min(3).max(4),
  explanation: z.string().min(10).max(1000),
});
const candidateSchema = z.object({
  en: localizedSchema,
  nb: localizedSchema,
  correctOptionKey: z.string().min(1).max(2),
  difficulty: z.number().int().min(1).max(5),
  citations: z.array(z.object({ sourceCode: z.string().min(1), ref: z.string().min(1) })).min(1),
  testsPoint: z.string().min(3).max(200).optional(),
});
const responseSchema = z.union([
  z.object({ questions: z.array(candidateSchema).min(1).max(10) }),
  z.array(candidateSchema).min(1).max(10).transform((questions) => ({ questions })),
]);

export interface ImageGenerationOutcome {
  batchId: string;
  requested: number;
  returned: number;
  accepted: number;
  duplicates: number;
  alternates: number;
  /** Refused because the answer key could not be independently reproduced. The headline number. */
  answerDisputed: number;
  /** Refused because the question described a picture other than this one. */
  sceneMismatched: number;
  /** Whether a human had confirmed the picture's facts before this ran. */
  factsVerified: boolean;
  rejected: Array<{ stem: string; reasons: string[] }>;
}

function difficultyBriefFor(count: number): string {
  const easy = Math.max(1, Math.round(count * 0.3));
  const hard = Math.max(1, Math.round(count * 0.3));
  const medium = Math.max(0, count - easy - hard);
  return [
    "DIFFICULTY — spread them deliberately:",
    `- about ${easy} at difficulty 1–2: reading one sign or one fact straight off the picture.`,
    `- about ${medium} at difficulty 3: the rule applied to what is in the picture.`,
    `- about ${hard} at difficulty 4–5: two things interacting, or where the obvious answer is wrong.`,
  ].join("\n");
}

export async function generateImageQuestions(
  db: PrismaClient,
  actor: SessionUser,
  input: { imageAssetId: string; count: number; licenseClassId?: string | null },
): Promise<ImageGenerationOutcome> {
  const image = await db.imageAsset.findFirst({
    where: { id: input.imageAssetId, deletedAt: null },
    select: { id: true, aiContextSheet: true, contextVerifiedAt: true },
  });
  if (!image) throw new NotFoundError({ imageAssetId: input.imageAssetId });
  if (!image.aiContextSheet) {
    throw new ValidationError(
      { imageAssetId: image.id },
      "admin.images.errors.noContextSheet",
    );
  }

  const sheet: ContextSheet = contextSheetSchema.parse(image.aiContextSheet);
  // Snapshotted, not derived later: confirming the sheet after the fact must not retroactively
  // make these questions look as though they were built on verified ground.
  const factsVerified = Boolean(image.contextVerifiedAt);

  const signs = sheet.signs.length
    ? await db.sign.findMany({
        where: { code: { in: sheet.signs.map((sign) => sign.signCode) } },
        select: { code: true, name: true, meaning: true, signClass: true },
      })
    : [];

  const signNamesWithCodes = signs.map((sign) => ({
    code: sign.code,
    name: (sign.name as { en?: string }).en ?? sign.code,
  }));
  const signList = signNamesWithCodes.map((sign) => sign.name).join(", ");

  // Retrieve on what the picture actually contains, restricted to the regulations that govern a
  // road scene. A question about a sign grounded in general traffic rules cites something that
  // does not define the sign.
  const query = [signList, sheet.situationSummary, sheet.roadMarkings.join(" ")]
    .filter(Boolean)
    .join(" ");
  const retrieval = await search(db, { query, limit: 8, sourceCodes: SOURCES });
  if (retrieval.hits.length < MIN_EXCERPTS) {
    throw new AiPipelineError({
      imageAssetId: image.id,
      found: retrieval.hits.length,
      reason: "not enough regulation text to ground a question about this picture",
    });
  }
  const kbExcerpts = retrieval.hits
    .map((hit) => `[${hit.sourceCode} ${hit.ref}]\n${hit.text}`)
    .join("\n\n");

  const topicSlug = signs.length
    ? TOPIC_FOR_CLASS[signs[0].signClass]
    : FALLBACK_TOPIC;
  const topic = await db.topic.findFirst({
    where: { slug: topicSlug, deletedAt: null },
    select: { id: true },
  });
  if (!topic) throw new NotFoundError({ topicSlug });

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

  const lessons = await buildRejectionLessons(db, topic.id);

  const batch = await db.generationBatch.create({
    data: {
      kind: "IMAGE",
      status: "RUNNING",
      sourceImageId: image.id,
      topicId: topic.id,
      licenseClassId: input.licenseClassId ?? null,
      requestedCount: input.count,
      createdById: actor.id,
      factsVerified,
      notes: `${signList || "no signs"} · ${sheet.situationSummary.slice(0, 60)}`,
    },
    select: { id: true },
  });

  let result;
  try {
    result = await aiJson({
      task: "generation",
      prompt: imageQuestionPrompt,
      vars: {
        situationSummary: sheet.situationSummary,
        signList,
        sceneFacts: [
          sheet.roadMarkings.length ? `Road markings: ${sheet.roadMarkings.join(", ")}` : "",
          sheet.actors.length ? `Other road users: ${sheet.actors.join(", ")}` : "",
          `Conditions: ${sheet.conditions.lighting}, ${sheet.conditions.weather}, ${sheet.conditions.roadType}`,
        ]
          .filter(Boolean)
          .join("\n"),
        kbExcerpts,
        candidateCount: input.count,
        avoidStems,
        difficultyBrief: difficultyBriefFor(input.count),
        rejectionLessons: lessons.block,
      },
      schema: responseSchema,
    });
  } catch (error) {
    await db.generationBatch.update({
      where: { id: batch.id },
      data: { status: "FAILED" },
      select: { id: true },
    });
    throw error;
  }

  const rejected: Array<{ stem: string; reasons: string[] }> = [];
  let accepted = 0;
  let duplicates = 0;
  let alternates = 0;
  let answerDisputed = 0;
  let sceneMismatched = 0;

  const refuse = async (
    candidate: z.infer<typeof candidateSchema>,
    reasons: string[],
    source: "GATE" | "DUPLICATE" | "REVIEWER",
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

  const embeddings = await embedStems(
    result.data.questions.map((c) => ({ en: c.en.stem, nb: c.nb.stem })),
  );
  const keptEmbeddings: number[][] = [];

  for (const [index, candidate] of result.data.questions.entries()) {
    const content = {
      en: { stem: candidate.en.stem, options: candidate.en.options, explanation: candidate.en.explanation },
      nb: { stem: candidate.nb.stem, options: candidate.nb.options, explanation: candidate.nb.explanation },
    };

    const quality = checkItemQuality({
      content,
      correctOptionKey: candidate.correctOptionKey,
      legalCitations: candidate.citations,
    });
    if (!quality.passed) {
      await refuse(candidate, quality.errors.map((issue) => issue.code), "GATE");
      continue;
    }

    // A stem that names the sign is answerable without the picture, which makes the picture
    // decoration and usually gives the answer away.
    const named = checkStemHidesTheSign(candidate.en.stem, signNamesWithCodes);
    if (!named.ok) {
      await refuse(candidate, ["ANSWER_IN_STEM", named.revealed ?? ""], "GATE");
      continue;
    }

    // THE check. A wrong answer key is the failure that teaches a learner the wrong rule while
    // marking them correct, and it is the one no schema, citation or duplicate check can find.
    const cited = retrieval.hits
      .filter((hit) => candidate.citations.some((c) => c.sourceCode === hit.sourceCode && c.ref === hit.ref))
      .map((hit) => hit.text)
      .join("\n\n");
    const blind = await verifyAnswerBlind({
      stem: candidate.en.stem,
      options: candidate.en.options,
      correctOptionKey: candidate.correctOptionKey,
      situationSummary: sheet.situationSummary,
      signNames: signs.map((sign) => (sign.name as { en?: string }).en ?? sign.code),
      legalText: cited || kbExcerpts,
      seed: `${batch.id}:${index}`,
    });
    if (!blind.verified) {
      // A scene mismatch is a different fault from a disputed key and is counted separately, so
      // the accuracy dashboard can tell "the model misread the law" from "the model described a
      // different picture" — they need different fixes.
      if (blind.sceneMismatch) {
        sceneMismatched++;
        await refuse(candidate, ["IMAGE_MISMATCH", blind.reason], "GATE");
      } else {
        answerDisputed++;
        await refuse(candidate, ["WRONG_ANSWER", blind.reason], "GATE");
      }
      continue;
    }

    // The stem must not contain its own answer, whether by naming the sign or describing it.
    const correctText =
      candidate.en.options.find((option) => option.key === candidate.correctOptionKey)?.text ?? "";
    const leak = await checkStemDoesNotLeakAnswer(candidate.en.stem, correctText);
    if (!leak.ok) {
      await refuse(candidate, ["ANSWER_IN_STEM", leak.similarity.toFixed(2)], "GATE");
      continue;
    }

    // Two options meaning the same thing make the question ungradeable.
    const distinct = await checkDistractorDistinctness(candidate.en.options);
    if (!distinct.ok) {
      await refuse(candidate, ["AMBIGUOUS_DISTRACTOR", `${distinct.collidingKeys?.join("/")}`], "GATE");
      continue;
    }

    const embedding = embeddings[index];
    if (keptEmbeddings.some((kept) => cosine(kept, embedding) >= REPEAT_THRESHOLD)) {
      duplicates++;
      await refuse(candidate, ["DUPLICATE_IN_BATCH"], "DUPLICATE");
      continue;
    }
    const verdict = await classifyAgainstPool(db, embedding);
    if (verdict.kind === "repeat") {
      duplicates++;
      await refuse(candidate, ["DUPLICATE_OF_EXISTING"], "DUPLICATE");
      continue;
    }
    if (verdict.kind === "alternate") alternates++;

    const created = await db.masterItem.create({
      data: {
        type: "IMAGE",
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
        sourceImageId: image.id,
        batchId: batch.id,
      },
      select: { id: true },
    });
    await storeStemEmbedding(db, created.id, embedding, verdict.conceptGroupId ?? null);
    keptEmbeddings.push(embedding);
    accepted++;
  }

  await db.generationBatch.update({
    where: { id: batch.id },
    data: { status: "READY", modelVersion: result.modelVersion, promptVersion: result.promptVersion },
    select: { id: true },
  });
  await db.imageAsset.update({
    where: { id: image.id },
    data: { status: accepted > 0 ? "IN_REVIEW" : "READY" },
    select: { id: true },
  });

  await auditLog({
    actorId: actor.id,
    action: AUDIT.questionsGenerated,
    entityType: "GenerationBatch",
    entityId: batch.id,
    meta: { imageAssetId: image.id, accepted, answerDisputed, sceneMismatched, factsVerified },
  });

  logger.info(
    { batchId: batch.id, accepted, answerDisputed, sceneMismatched, duplicates, factsVerified },
    "image questions generated",
  );

  return {
    batchId: batch.id,
    requested: input.count,
    returned: result.data.questions.length,
    accepted,
    duplicates,
    alternates,
    answerDisputed,
    sceneMismatched,
    factsVerified,
    rejected,
  };
}
