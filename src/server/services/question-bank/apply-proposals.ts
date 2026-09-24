import type { PrismaClient } from "@prisma/client";
import { ConflictError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { embedStems } from "./similarity";
import { rewriteApprovedItemInPlace, type RewriteTranslation } from "./rewrite";
import {
  shadowTranslateAll,
  type ShadowSet,
  targetLanguages,
} from "./shadow-translate";
import type { QuestionContent } from "./simplify";

/**
 * Apply the proposals a human has already read (spec-22, production run 2026-09-24).
 *
 * `text --apply` re-proposes with fresh AI calls and swaps whatever comes back, so the diffs a
 * reviewer read from the dry run were never what went live. This module closes that gap: it takes
 * a run id, loads its PROPOSED rows, and swaps exactly that content — translating first, then
 * writing content, variant and every locale in one transaction — and marks each row APPLIED.
 *
 * Nothing here decides whether a rewrite is good. The gates decided that when the proposal was
 * made, and the reviewer decided it by reading `diffs --run`. A proposal whose item has moved on
 * since (version or fingerprint) is refused by `rewriteApprovedItemInPlace` and reported as a
 * hold, never overwritten.
 */

export interface ApplyFromRunDeps {
  translate: (
    db: PrismaClient,
    languages: Awaited<ReturnType<typeof targetLanguages>>,
    input: { itemId: string; proposed: QuestionContent; correctOptionKey: string; label: string },
  ) => Promise<ShadowSet>;
  rewrite: typeof rewriteApprovedItemInPlace;
  /** The stem vector is not stored with the proposal; it is recomputed for the swap. */
  embed: (content: QuestionContent) => Promise<number[] | null>;
  loadLanguages: typeof targetLanguages;
  log: (line: string) => void;
}

const defaultDeps: ApplyFromRunDeps = {
  translate: shadowTranslateAll,
  rewrite: rewriteApprovedItemInPlace,
  embed: async (content) => {
    const [vector] = await embedStems([{ en: content.en.stem, nb: content.nb.stem }]);
    return vector ?? null;
  },
  loadLanguages: targetLanguages,
  log: (line) => console.log(line),
};

export interface ApplyFromRunResult {
  runId: string;
  applied: string[];
  held: Array<{ itemId: string; reason: string }>;
  /** PROPOSED rows whose item is gone or no longer approved. */
  skipped: Array<{ itemId: string; reason: string }>;
}

export async function applyProposalsFromRun(
  db: PrismaClient,
  input: { runId: string; actorId: string; onlyItemId?: string },
  overrides: Partial<ApplyFromRunDeps> = {},
): Promise<ApplyFromRunResult> {
  const deps = { ...defaultDeps, ...overrides };
  const result: ApplyFromRunResult = { runId: input.runId, applied: [], held: [], skipped: [] };

  // Index: SimplificationProposal_runId_status_idx.
  const proposals = await db.simplificationProposal.findMany({
    where: {
      runId: input.runId,
      status: "PROPOSED",
      masterItemId: input.onlyItemId ?? { not: null },
    },
    select: {
      id: true,
      masterItemId: true,
      proposed: true,
      expectedVersion: true,
      expectedFingerprint: true,
      masterItem: {
        select: { status: true, deletedAt: true, correctOptionKey: true },
      },
    },
    orderBy: { createdAt: "asc" },
  });
  if (proposals.length === 0) return result;

  const languages = await deps.loadLanguages(db);

  for (const proposal of proposals) {
    const itemId = proposal.masterItemId!;
    const item = proposal.masterItem;
    if (!item || item.deletedAt || item.status !== "APPROVED" || !item.correctOptionKey) {
      result.skipped.push({ itemId, reason: "item is no longer an approved question" });
      continue;
    }
    if (proposal.expectedVersion === null) {
      result.skipped.push({ itemId, reason: "proposal carries no expected version" });
      continue;
    }
    const proposed = proposal.proposed as unknown as QuestionContent;

    // Translate FIRST, into every language, so the swap never leaves a student reading English
    // or a stale pairing. A student-visible language that fails QA holds the item; nothing is
    // written.
    const shadow = await deps.translate(db, languages, {
      itemId,
      proposed,
      correctOptionKey: item.correctOptionKey,
      label: `q ${itemId.slice(-6)}`,
    });
    if (!shadow.ready) {
      const reason = shadow.failures.map((f) => `${f.locale}(${f.reason})`).join(", ");
      result.held.push({ itemId, reason: `translation not ready — ${reason}` });
      deps.log(`  hold ${itemId.slice(-6)}: ${reason}`);
      continue;
    }

    try {
      await deps.rewrite(db, {
        itemId,
        newContent: proposed as never,
        expectedVersion: proposal.expectedVersion,
        expectedFingerprint: proposal.expectedFingerprint,
        translations: shadow.translations as RewriteTranslation[],
        runId: input.runId,
        actorId: input.actorId,
        stemEmbedding: await deps.embed(proposed),
      });
    } catch (error) {
      if (error instanceof ConflictError) {
        // The item moved between the dry run and now. That is the optimistic check doing its job:
        // the reviewer read a diff against text that no longer exists, so it must be re-proposed.
        result.held.push({ itemId, reason: "item changed since the proposal (stale)" });
        deps.log(`  hold ${itemId.slice(-6)}: stale — re-run a dry run for this item`);
        continue;
      }
      throw error;
    }

    await db.simplificationProposal.update({
      where: { id: proposal.id },
      data: { status: "APPLIED", appliedAt: new Date(), appliedById: input.actorId },
      select: { id: true },
    });
    result.applied.push(itemId);
    logger.info({ itemId, runId: input.runId }, "proposal applied from reviewed run");
  }

  return result;
}
