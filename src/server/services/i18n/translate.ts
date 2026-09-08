import type { PrismaClient, TranslationStatus } from "@prisma/client";
import { z } from "zod";
import { schoolConfig } from "../../../../config/school.config";
import { logger } from "@/lib/logger";
import { aiJson } from "@/server/ai/client";
import {
  glossaryBlock,
  rejectedBlock,
  translateUnitsPrompt,
} from "@/server/ai/prompts/translation";
import {
  probeMemory,
  rememberTranslations,
  countMemoryHits,
  type RememberInput,
} from "./memory";
import { semanticCheck, type QaInput } from "./qa";
import { memoryHash, type TranslationUnit, type UnitPayload } from "./units";
import { allCodes, blockingCodes, checkTranslation } from "./validation";

/**
 * Translating a batch of units (spec-15).
 *
 * The shape of it: probe the memory → ask the model for what is left → run the deterministic gate
 * → run the semantic pass on the share the language asks for → write the rows.
 *
 * A unit that fails either gate is stored as NEEDS_REVIEW, which is never served under any
 * approval policy. Failing towards "a human looks at it" is the only safe direction here: the
 * alternative is a question that reads fine and marks wrong.
 */

/** The shape every translation call — fresh or repair — must come back in. */
export const translationResponseSchema = z.object({
  units: z.array(
    z.object({
      id: z.string(),
      value: z.object({
        stem: z.string().optional(),
        options: z
          .array(z.object({ key: z.string(), text: z.string() }))
          .optional(),
        explanation: z.string().optional(),
        name: z.string().optional(),
        meaning: z.string().optional(),
        description: z.string().optional(),
        text: z.string().optional(),
      }),
      /** The model's own escape hatch — better a flagged item than a quietly fudged one. */
      issue: z.string().optional(),
    }),
  ),
});

export interface LanguagePolicy {
  code: string;
  englishName: string;
  nativeName: string;
  glossary: Record<string, string> | null;
  glossaryVersion: number;
  styleNote: string | null;
  qaSampleRate: number;
}

export interface TranslatedUnit {
  unit: TranslationUnit;
  value: UnitPayload;
  status: TranslationStatus;
  qaFlags: string[];
  qaReport: Record<string, unknown> | null;
  semanticScore: number | null;
  fromMemory: boolean;
  modelVersion: string | null;
  promptVersion: string | null;
  providerLabel: string | null;
  promptTokens: number;
  completionTokens: number;
}

/** Strip the payload down to the keys the source actually had, so nothing invented sneaks in. */
export function shapeLike(
  source: UnitPayload,
  candidate: Record<string, unknown>,
): UnitPayload {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (key === "options") {
      out.options = Array.isArray(candidate.options) ? candidate.options : [];
    } else if (typeof candidate[key] === "string") {
      out[key] = candidate[key];
    } else {
      out[key] = "";
    }
  }
  return out as unknown as UnitPayload;
}

export interface Rejection {
  excerpt: string;
  note: string | null;
}

/**
 * Recent refusals in this language, as worked examples for the prompt.
 *
 * Computed once per run by the runner and passed in; a rejection made mid-run reaches the prompt
 * on the NEXT run, which is when `pendingUnits` re-plans the rejected unit anyway.
 */
export async function recentRejections(
  db: PrismaClient,
  locale: string,
): Promise<Rejection[]> {
  const rows = await db.translation.findMany({
    where: { locale, status: "REJECTED" },
    orderBy: { reviewedAt: "desc" },
    take: 10,
    select: { value: true, reviewNote: true },
  });
  return rows.map((row) => {
    const value = row.value as {
      stem?: string;
      name?: string;
      text?: string;
    } | null;
    return {
      excerpt: value?.stem ?? value?.name ?? value?.text ?? "",
      note: row.reviewNote,
    };
  });
}

/**
 * Translate one batch.
 *
 * Returns what should be written; writing is the caller's job, so the runner controls the
 * transaction boundary and the run counters.
 */
export async function translateBatch(
  db: PrismaClient,
  language: LanguagePolicy,
  units: TranslationUnit[],
  options: {
    /** Worker shutdown, threaded into every provider call this batch makes. */
    signal?: AbortSignal;
    /** Computed once per run by the caller; queried here only when it is not. */
    rejections?: Rejection[];
  } = {},
): Promise<TranslatedUnit[]> {
  if (units.length === 0) return [];

  // 1. Anything already translated from identical source text, in this language, is free.
  const hashes = units.map((unit) =>
    memoryHash(unit.entity, unit.en, language.glossaryVersion),
  );
  const memory = await probeMemory(db, language.code, hashes);

  const results: TranslatedUnit[] = [];
  const pending: TranslationUnit[] = [];
  const usedHashes: string[] = [];

  for (const [position, unit] of units.entries()) {
    const hit = memory.get(hashes[position]);
    if (!hit) {
      pending.push(unit);
      continue;
    }
    // A memory hit still faces the deterministic gate: the source it was made for was identical,
    // but the check is cheap and a stored bad translation should not spread.
    const check = checkTranslation({
      entity: unit.entity,
      locale: language.code,
      source: unit.en,
      translated: hit.value,
      correctOptionKey: unit.correctOptionKey,
    });
    usedHashes.push(hashes[position]);
    results.push({
      unit,
      value: hit.value,
      status: check.passed ? "MACHINE" : "NEEDS_REVIEW",
      qaFlags: allCodes(check),
      qaReport: { source: "memory", issues: check.issues },
      semanticScore: null,
      fromMemory: true,
      modelVersion: hit.modelVersion,
      promptVersion: hit.promptVersion,
      providerLabel: null,
      promptTokens: 0,
      completionTokens: 0,
    });
  }
  await countMemoryHits(db, language.code, usedHashes);

  if (pending.length === 0) return results;

  // 2. One call for the rest.
  const rejections =
    options.rejections ?? (await recentRejections(db, language.code));
  const response = await aiJson({
    task: "translation",
    prompt: translateUnitsPrompt,
    vars: {
      targetLanguage: `${language.englishName} (${language.nativeName})`,
      targetCode: language.code,
      styleNote: language.styleNote ? `STYLE: ${language.styleNote}` : "",
      glossaryBlock: glossaryBlock(language.glossary),
      rejectedBlock: rejectedBlock(rejections),
      unitsJson: JSON.stringify(
        pending.map((unit) => ({
          id: unit.entityId,
          kind: unit.entity,
          correctOptionKey: unit.correctOptionKey,
          en: unit.en,
          nb: unit.nb,
        })),
      ),
    },
    schema: translationResponseSchema,
    temperature: 0.2,
    maxTokens: schoolConfig.ai.translationMaxTokens,
    ...(options.signal ? { signal: options.signal } : {}),
  });

  const byId = new Map(response.data.units.map((entry) => [entry.id, entry]));
  const perUnitPrompt = Math.round(
    response.usage.promptTokens / pending.length,
  );
  const perUnitCompletion = Math.round(
    response.usage.completionTokens / pending.length,
  );

  const fresh: TranslatedUnit[] = [];
  // Entity ids whose finding forces the semantic pass regardless of the sample rate — local to
  // this call, never attached to a `TranslatedUnit`, so there is nothing here for
  // `storeTranslations` to accidentally persist.
  const forced = new Set<string>();
  for (const unit of pending) {
    const entry = byId.get(unit.entityId);
    if (!entry) {
      // The model dropped an item. Not a silent skip: it is recorded so the run reports it.
      logger.warn(
        { locale: language.code, entity: unit.entity, entityId: unit.entityId },
        "translation missing from model response",
      );
      continue;
    }

    const value = shapeLike(unit.en, entry.value as Record<string, unknown>);
    const check = checkTranslation({
      entity: unit.entity,
      locale: language.code,
      source: unit.en,
      translated: value,
      correctOptionKey: unit.correctOptionKey,
    });
    const flags = allCodes(check);
    // The model saying it could not translate faithfully is worth more than any check we wrote.
    if (entry.issue) flags.push("MODEL_FLAGGED");
    if (blockingCodes(check).length > 0 || entry.issue) {
      forced.add(unit.entityId);
    }

    fresh.push({
      unit,
      value,
      status: check.passed && !entry.issue ? "MACHINE" : "NEEDS_REVIEW",
      qaFlags: flags,
      qaReport: {
        source: "model",
        issues: check.issues,
        ...(entry.issue ? { modelIssue: entry.issue } : {}),
      },
      semanticScore: null,
      fromMemory: false,
      modelVersion: response.modelVersion,
      promptVersion: response.promptVersion,
      providerLabel: response.providerLabel,
      promptTokens: perUnitPrompt,
      completionTokens: perUnitCompletion,
    });
  }

  // 3. The semantic pass, on the share this language asks for. Only a BLOCKING finding (or the
  //    model's own doubt) forces the expensive semantic pass regardless of the sample rate —
  //    advisory codes such as LENGTH_OUTLIER stay in qaFlags for the reviewer and the
  //    bulk-approve guard, but they do not spend a back-translation on their own.
  const sampled = fresh.filter(
    (candidate, position) =>
      forced.has(candidate.unit.entityId) ||
      language.qaSampleRate >= 1 ||
      position / Math.max(1, fresh.length) < language.qaSampleRate,
  );

  if (sampled.length > 0) {
    const qaInputs: QaInput[] = sampled.map((candidate) => ({
      id: candidate.unit.entityId,
      entity: candidate.unit.entity,
      source: candidate.unit.en,
      translated: candidate.value,
      correctOptionKey: candidate.unit.correctOptionKey,
    }));
    const qa = await semanticCheck({
      locale: language.code,
      languageName: language.englishName,
      units: qaInputs,
      ...(options.signal ? { signal: options.signal } : {}),
    });

    for (const candidate of sampled) {
      const result = qa.get(candidate.unit.entityId);
      if (!result) continue;
      candidate.semanticScore = result.semanticScore;
      candidate.qaFlags = [...new Set([...candidate.qaFlags, ...result.flags])];
      candidate.qaReport = {
        ...(candidate.qaReport ?? {}),
        semantic: result.report,
      };
      // ANSWER_PERMUTED means the key now points at a different meaning. Never serve that.
      if (result.flags.length > 0) candidate.status = "NEEDS_REVIEW";
    }
  }

  // 4. Only a clean translation is worth remembering — and the batch's worth of them in one
  //    transaction, not a write per unit.
  const remembered: RememberInput[] = fresh
    .filter((candidate) => candidate.status === "MACHINE")
    .map((candidate) => ({
      locale: language.code,
      entity: candidate.unit.entity,
      source: candidate.unit.en,
      value: candidate.value,
      glossaryVersion: language.glossaryVersion,
      modelVersion: candidate.modelVersion,
      promptVersion: candidate.promptVersion,
    }));
  await rememberTranslations(db, remembered);

  return [...results, ...fresh];
}

/** Persist a batch of translated units. Upsert, so a re-run overwrites rather than duplicating. */
export async function storeTranslations(
  db: PrismaClient,
  locale: string,
  translated: TranslatedUnit[],
  runId: string | null,
): Promise<void> {
  if (translated.length === 0) return;
  // One array transaction, not a write per unit: it holds one connection for the batch instead
  // of one per unit, which matters once the runner runs several batches concurrently (3 slots ×
  // a batch's worth of writes would queue past a small default pool — physical CPUs × 2 + 1, so 5 on a
  // 2-vCPU host — and time out at `pool_timeout`). It also lands all-or-nothing, so the DONE
  // marking the runner does next can never be true of a half-written batch.
  const upserts = translated.map((item) =>
    db.translation.upsert({
      where: {
        locale_entity_entityId: {
          locale,
          entity: item.unit.entity,
          entityId: item.unit.entityId,
        },
      },
      create: {
        locale,
        entity: item.unit.entity,
        entityId: item.unit.entityId,
        value: item.value as object,
        status: item.status,
        sourceHash: item.unit.sourceHash,
        modelVersion: item.modelVersion,
        promptVersion: item.promptVersion,
        providerLabel: item.providerLabel,
        promptTokens: item.promptTokens,
        completionTokens: item.completionTokens,
        fromMemory: item.fromMemory,
        qaReport: (item.qaReport ?? undefined) as object | undefined,
        semanticScore: item.semanticScore,
        qaFlags: item.qaFlags,
        runId,
        // A fresh translation is a fresh repair budget.
        repairAttempts: 0,
      },
      update: {
        value: item.value as object,
        status: item.status,
        sourceHash: item.unit.sourceHash,
        modelVersion: item.modelVersion,
        promptVersion: item.promptVersion,
        providerLabel: item.providerLabel,
        promptTokens: item.promptTokens,
        completionTokens: item.completionTokens,
        fromMemory: item.fromMemory,
        qaReport: (item.qaReport ?? undefined) as object | undefined,
        semanticScore: item.semanticScore,
        qaFlags: item.qaFlags,
        runId,
        // A fresh translation is a fresh repair budget.
        repairAttempts: 0,
        // A re-translation supersedes any earlier review.
        reviewedById: null,
        reviewedAt: null,
        reviewNote: null,
      },
      select: { id: true },
    }),
  );
  await db.$transaction(upserts);
}
