import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { ValidationError } from "@/lib/errors";
import { pickBilingualText } from "@/lib/i18n-content";
import { logger } from "@/lib/logger";
import { aiJson } from "@/server/ai/client";
import { learnDraftPrompt } from "@/server/ai/prompts/learn";
import type { SessionUser } from "@/server/authz";
import {
  draftDocumentInputSchema,
  draftResultSchema,
  type DraftResult,
} from "@/server/contracts/learn";
import { legalCitationSchema } from "@/server/contracts/models";
import { checkTranslation } from "@/server/services/i18n/validation";
import {
  lookupChunksForCitations,
  type CitationLookup,
  type CitationRef,
} from "@/server/services/kb/citations";
import { search } from "@/server/services/kb/search";
import { countWords, markdownStructure } from "./markdown";

/**
 * AI drafting of a chapter or an article (spec-23 C8).
 *
 * Nothing here is stored. The result goes back to the editor as a proposal; the row is created
 * only when the admin saves, and then carries `createdBy: AI` with the model and prompt versions.
 * The gates are the same kind the question factory runs: grounded in retrieved excerpts, both
 * languages with the same skeleton, numbers and § references identical across them, and every
 * citation resolvable to a knowledge-base chunk.
 */
export const MIN_EXCERPTS = 3;
const MAX_EXCERPT_CHARS = 24_000;

/** Models sometimes write Norwegian under "no" (the ISO code) rather than "nb"; both are accepted. */
const bilingualField = (side: z.ZodString) =>
  z.preprocess(
    (value) => {
      if (
        value &&
        typeof value === "object" &&
        !("nb" in value) &&
        "no" in value
      ) {
        const { no, ...rest } = value as Record<string, unknown>;
        return { ...rest, nb: no };
      }
      return value;
    },
    z.object({ en: side, nb: side }),
  );

export const learnDraftResponseSchema = z.object({
  title: bilingualField(z.string().min(1).max(160)),
  summary: bilingualField(z.string().max(400)),
  body: bilingualField(z.string().min(1)),
  citations: z
    .array(
      legalCitationSchema.extend({
        supports: z.string().nullable().optional(),
      }),
    )
    .default([]),
  issue: z.string().nullable().optional(),
});
type DraftResponse = z.infer<typeof learnDraftResponseSchema>;

export interface DraftDeps {
  generate: (vars: Parameters<typeof learnDraftPrompt.render>[0]) => Promise<{
    data: DraftResponse;
    modelVersion: string;
    promptVersion: string;
    promptTokens: number;
    completionTokens: number;
  }>;
  retrieve: (
    db: PrismaClient,
    input: { query: string; sourceCodes: string[]; sectionRef?: string },
  ) => Promise<
    Array<{ chunkId: string; sourceCode: string; ref: string; text: string }>
  >;
  resolve: (
    db: PrismaClient,
    citations: CitationRef[],
  ) => Promise<CitationLookup>;
}

/**
 * A 700-word markdown chapter inside a JSON string is where small models most often break the
 * JSON itself (an unescaped quote, a stray newline). That is a fact about one sample, not about
 * the topic, so a parse failure gets exactly one more try at a colder temperature.
 */
export async function generateWithOneRetry(
  vars: Parameters<typeof learnDraftPrompt.render>[0],
  call: (temperature: number) => ReturnType<DraftDeps["generate"]>,
): ReturnType<DraftDeps["generate"]> {
  try {
    return await call(0.4);
  } catch (error) {
    const reason = (error as { meta?: { reason?: string } }).meta?.reason;
    if (reason !== "response failed contract validation") throw error;
    logger.warn(
      { topic: vars.topicNameEn },
      "learn draft: malformed JSON — one colder retry",
    );
    return call(0.2);
  }
}

const defaultDeps: DraftDeps = {
  generate: (vars) =>
    generateWithOneRetry(vars, async (temperature) => {
      const result = await aiJson({
        task: "generation",
        prompt: learnDraftPrompt,
        vars,
        schema: learnDraftResponseSchema,
        temperature,
        maxTokens: 8192,
        timeoutMs: 90_000,
      });
      return {
        data: result.data,
        modelVersion: result.modelVersion,
        promptVersion: result.promptVersion,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
      };
    }),
  retrieve: async (db, input) => {
    if (input.sectionRef && input.sourceCodes.length > 0) {
      // Addressed directly, no embedding call: the editor named the section.
      const { resolved } = await lookupChunksForCitations(
        db,
        input.sourceCodes.map((sourceCode) => ({
          sourceCode,
          ref: input.sectionRef!,
        })),
        { perCitation: 6 },
      );
      if (resolved.length > 0) {
        return resolved.map((c) => ({
          chunkId: c.kbChunkId,
          sourceCode: c.sourceCode,
          ref: c.chunkRef,
          text: c.text,
        }));
      }
    }
    const result = await search(db, {
      query: input.sectionRef
        ? `${input.query} ${input.sectionRef}`
        : input.query,
      limit: 12,
      ...(input.sourceCodes.length > 0
        ? { sourceCodes: input.sourceCodes }
        : {}),
    });
    return result.hits.map((hit) => ({
      chunkId: hit.chunkId,
      sourceCode: hit.sourceCode,
      ref: hit.ref,
      text: hit.text,
    }));
  },
  resolve: (db, citations) =>
    lookupChunksForCitations(db, citations, { perCitation: 1 }),
};

/** The one-line skeleton comparison the retry feedback and the refusal both quote. */
export function structureMismatch(en: string, nb: string): string | null {
  const a = markdownStructure(en);
  const b = markdownStructure(nb);
  if (a.h2 !== b.h2)
    return `English has ${a.h2} H2 sections, Norwegian ${b.h2}.`;
  if (a.h3 !== b.h3)
    return `English has ${a.h3} H3 headings, Norwegian ${b.h3}.`;
  if (a.h2 < 2) return `Only ${a.h2} H2 section(s); write 4 to 8.`;
  return null;
}

/** Things a draft may not contain; they are removed and reported, never stored. */
export function stripForbidden(markdown: string): {
  markdown: string;
  removed: string[];
} {
  const removed: string[] = [];
  let out = markdown;
  if (/!\[[^\]]*\]\([^)]*\)/.test(out)) {
    removed.push("images");
    out = out.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  }
  if (/(?<!!)\[[^\]]+\]\([^)]*\)/.test(out)) {
    removed.push("links");
    out = out.replace(/(?<!!)\[([^\]]+)\]\([^)]*\)/g, "$1");
  }
  if (/<\/?[a-zA-Z][^>]*>/.test(out)) {
    removed.push("html");
    out = out.replace(/<\/?[a-zA-Z][^>]*>/g, "");
  }
  if (/^```/m.test(out)) {
    removed.push("code");
    out = out.replace(/```[\s\S]*?```/g, "");
  }
  if (/^#\s/m.test(out)) {
    removed.push("h1");
    out = out.replace(/^#\s+.*$/gm, "");
  }
  return { markdown: out.replace(/\n{3,}/g, "\n\n").trim() + "\n", removed };
}

export async function draftDocument(
  db: PrismaClient,
  actor: SessionUser,
  rawInput: unknown,
  overrides: Partial<DraftDeps> = {},
): Promise<DraftResult> {
  const deps = { ...defaultDeps, ...overrides };
  const input = draftDocumentInputSchema.parse(rawInput);

  const topic = await db.topic.findFirst({
    where: { id: input.topicId, deletedAt: null },
    select: { id: true, slug: true, name: true },
  });
  if (!topic)
    throw new ValidationError(
      { topicId: input.topicId },
      "admin.learn.errors.topicMissing",
    );
  const topicNameEn = pickBilingualText(topic.name, "en") || topic.slug;
  const topicNameNb = pickBilingualText(topic.name, "nb") || topicNameEn;

  const [book, siblings] = await Promise.all([
    input.bookId
      ? db.learnBook.findFirst({
          where: { id: input.bookId, deletedAt: null },
          select: { title: true },
        })
      : Promise.resolve(null),
    // Index: LearnDocument_topicId_status_idx.
    db.learnDocument.findMany({
      where: { topicId: topic.id, deletedAt: null },
      select: { title: true },
      take: 20,
      orderBy: { updatedAt: "desc" },
    }),
  ]);
  const kindLabel =
    input.kind === "CHAPTER"
      ? `a chapter of the book "${book ? pickBilingualText(book.title, "en") : ""}"`
      : "a standalone article";
  const siblingTitles = siblings
    .map((row) => `- ${pickBilingualText(row.title, "en")}`)
    .join("\n");

  // Retrieve the law first. No excerpts, no draft — a chapter nobody can trace to a rule is
  // exactly what this platform must not produce.
  const hits = await deps.retrieve(db, {
    query: `${topicNameNb} ${topicNameEn} ${input.brief ?? ""}`.trim(),
    sourceCodes: input.sourceCodes,
    ...(input.sectionRef ? { sectionRef: input.sectionRef } : {}),
  });
  if (hits.length < MIN_EXCERPTS) {
    throw new ValidationError(
      { topicId: topic.id, found: hits.length },
      "admin.learn.errors.aiNoMaterial",
    );
  }
  let budget = MAX_EXCERPT_CHARS;
  const kept = hits.filter((hit) => {
    if (budget - hit.text.length < 0) return false;
    budget -= hit.text.length;
    return true;
  });
  const kbExcerpts = kept
    .map((hit) => `[${hit.sourceCode} ${hit.ref}]\n${hit.text}`)
    .join("\n\n");

  const vars = {
    topicNameEn,
    topicNameNb,
    kindLabel,
    siblingTitles,
    brief: input.brief ?? "",
    targetWords: input.targetWords,
    kbExcerpts,
    feedback: "",
  };

  // Strip what may never be stored BEFORE judging the skeleton: an image the model added in one
  // language is removed, not a reason to refuse the whole draft. Then one retry, with the finding
  // in the prompt — the same sample twice teaches nothing.
  let response = await deps.generate(vars);
  let en = stripForbidden(response.data.body.en);
  let nb = stripForbidden(response.data.body.nb);
  let mismatch = structureMismatch(en.markdown, nb.markdown);
  let drift = driftBetween(en.markdown, nb.markdown);
  if (mismatch || drift) {
    response = await deps.generate({
      ...vars,
      feedback: mismatch ?? drift ?? "",
    });
    en = stripForbidden(response.data.body.en);
    nb = stripForbidden(response.data.body.nb);
    mismatch = structureMismatch(en.markdown, nb.markdown);
    drift = driftBetween(en.markdown, nb.markdown);
    if (mismatch || drift) {
      throw new ValidationError(
        { mismatch, drift },
        "admin.learn.errors.aiStructure",
      );
    }
  }

  const warnings: string[] = [];
  for (const removed of new Set([...en.removed, ...nb.removed]))
    warnings.push(`stripped${removed[0]!.toUpperCase()}${removed.slice(1)}`);
  if (response.data.issue) warnings.push("modelIssue");

  const citations = response.data.citations.map(({ sourceCode, ref }) => ({
    sourceCode,
    ref,
  }));
  const { resolved, unresolved } = await deps.resolve(db, citations);
  const resolvedRefs = new Map(
    resolved.map((c) => [`${c.sourceCode}|${c.ref}`, c]),
  );
  if (resolvedRefs.size === 0) {
    throw new ValidationError(
      { citations },
      "admin.learn.errors.aiNoCitations",
    );
  }
  // Every § the body mentions should be in the citation list, or the sources footer lies by omission.
  const mentioned = new Set(
    (en.markdown.match(/§\s*\d+(?:[.\-]\d+)*/gu) ?? []).map((s) =>
      s.replace(/\s+/g, " "),
    ),
  );
  const listed = new Set(citations.map((c) => c.ref.replace(/\s+/g, " ")));
  if (
    [...mentioned].some(
      (ref) => ![...listed].some((l) => l.startsWith(ref) || ref.startsWith(l)),
    )
  ) {
    warnings.push("uncitedReference");
  }
  const wordsEn = countWords(en.markdown, "en");
  if (wordsEn < input.targetWords * 0.5 || wordsEn > input.targetWords * 1.6)
    warnings.push("length");

  logger.info(
    {
      actorId: actor.id,
      topicId: topic.id,
      excerpts: kept.length,
      promptTokens: response.promptTokens,
      completionTokens: response.completionTokens,
      warnings,
    },
    "learn draft produced",
  );

  return draftResultSchema.parse({
    title: response.data.title,
    summary: response.data.summary,
    body: { en: en.markdown, nb: nb.markdown },
    citations: citations.filter((c) =>
      resolvedRefs.has(`${c.sourceCode}|${c.ref}`),
    ),
    unresolvedCitations: unresolved,
    excerptCount: kept.length,
    modelVersion: response.modelVersion,
    promptVersion: response.promptVersion,
    warnings,
  });
}

/** Numbers and § references must be identical across the two languages — the same gate translations pass. */
function driftBetween(en: string, nb: string): string | null {
  const check = checkTranslation({
    entity: "LEARN_SECTION",
    locale: "nb",
    source: { text: en },
    translated: { text: nb },
  });
  const blocking = check.issues.filter(
    (issue) => issue.blocking && issue.code !== "UNTRANSLATED",
  );
  if (blocking.length === 0) return null;
  return blocking
    .map((issue) => `${issue.code}${issue.detail ? ` (${issue.detail})` : ""}`)
    .join("; ");
}
