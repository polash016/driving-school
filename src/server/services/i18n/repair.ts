import type { PrismaClient, TranslatableEntity } from "@prisma/client";
import { logger } from "@/lib/logger";
import { aiJson } from "@/server/ai/client";
import {
  glossaryBlock,
  translateRepairPrompt,
} from "@/server/ai/prompts/translation";
import { extractAll } from "./extract";
import { probeMemory, rememberTranslation } from "./memory";
import { semanticCheck, type QaInput } from "./qa";
import { ESTIMATED_USD_PER_1K_TOKENS } from "./run-math";
// Type-only: erased at compile time, so there is no runtime cycle with runs.ts, which imports the
// repair slice from here.
import type { RunPlan } from "./runs";
import {
  shapeLike,
  translationResponseSchema,
  type LanguagePolicy,
  type TranslatedUnit,
} from "./translate";
import { memoryHash, type TranslationUnit, type UnitPayload } from "./units";
import { allCodes, checkTranslation, NOT_A_QUALITY_FLAG } from "./validation";

/**
 * Auto-repair (spec-19).
 *
 * A translation that fails a QA check is stored NEEDS_REVIEW, and NEEDS_REVIEW is served under no
 * policy, never counts towards the coverage a language needs to be published, and is refused by
 * bulk approve unless a reviewer names the very code that flagged it. So a quality finding is
 * cleared one unit at a time by a human, and that wall is what this module exists to remove — by
 * making the machine fix its own mistakes, never by lowering the bar.
 *
 * A NEEDS_REVIEW unit is re-translated with the QA finding stated in the prompt, at temperature 0,
 * and ALWAYS re-QA'd. Three attempts, then a human. Units whose only flags are infrastructure
 * (`QA_UNAVAILABLE`) or advisory (`LENGTH_OUTLIER`) are not re-translated at all — their text was
 * never the problem — they are re-QA'd on the existing value, and that does not consume a repair
 * attempt.
 *
 * Three rules hold the whole thing up:
 *
 * 1. **Never overwrite a human.** A repair run is planned from exactly the rows a reviewer is
 *    working through, so `storeRepairs` writes conditionally rather than upserting.
 * 2. **Scrutiny goes up, never down.** Every repaired unit is QA'd whatever `qaSampleRate` says.
 * 3. **The budget must bind.** An attempt is charged only where one was actually spent.
 */

/** After this many spent attempts a unit is left to a human. Persisted on the row, not the job. */
export const MAX_REPAIR_ATTEMPTS = 3;

/**
 * Units whose only flags say nothing about the text — re-QA'd, never re-translated. Without this
 * rule one provider outage would burn every flagged unit's entire quality budget re-translating
 * text that was never wrong. The list of such codes lives in `validation.ts`, because bulk approve
 * asks the same question of the same codes and there must be one answer to it.
 *
 * `[].every()` is vacuously true, so an empty flag list would report "the text was never the
 * problem" about a unit nothing is known about — and that unit would be re-QA'd for free, for
 * ever, instead of being re-translated. Unreachable while every NEEDS_REVIEW writer attaches a
 * flag; the guard is what keeps it that way.
 */
export function isReQaOnly(flags: string[]): boolean {
  return (
    flags.length > 0 && flags.every((flag) => NOT_A_QUALITY_FLAG.has(flag))
  );
}

export interface RepairProblem {
  code: string;
  detail?: string;
}

export interface RepairContext {
  value: UnitPayload;
  qaFlags: string[];
  problems: RepairProblem[];
  reviewNote: string | null;
  repairAttempts: number;
  sourceHash: string;
}

/**
 * The stored qaReport, restated as things the model can act on.
 *
 * `qaFlags` carries only codes; the detail strings — `NUMBER_DRIFT: "80, 11, 1 to 60, 11, 1"` —
 * live in `qaReport.issues`, and they are the whole value of a repair prompt. Reading the report
 * rather than the flags is therefore not an optimisation, it is the point.
 */
export function repairProblems(row: {
  qaFlags: string[];
  qaReport: unknown;
}): RepairProblem[] {
  const report = (row.qaReport ?? {}) as {
    issues?: Array<{ code: string; detail?: string }>;
    modelIssue?: string;
    semantic?: { optionPairings?: Array<{ key: string; nearest: string }> };
  };
  const problems: RepairProblem[] = (report.issues ?? []).map((issue) =>
    issue.detail
      ? { code: issue.code, detail: issue.detail }
      : { code: issue.code },
  );
  const seen = new Set(problems.map((problem) => problem.code));

  // The semantic pass records which option drifted onto which, but only as pairings. Said plainly,
  // it is the most actionable sentence in the whole prompt.
  if (row.qaFlags.includes("ANSWER_PERMUTED") && !seen.has("ANSWER_PERMUTED")) {
    const swapped = (report.semantic?.optionPairings ?? []).filter(
      (pairing) => pairing.nearest !== pairing.key,
    );
    problems.push({
      code: "ANSWER_PERMUTED",
      detail: `option ${swapped
        .map((pairing) => `${pairing.key} reads like ${pairing.nearest}`)
        .join(", ")}`,
    });
  }
  // The model's own escape hatch from the previous attempt, handed back to it.
  if (report.modelIssue)
    problems.push({ code: "MODEL_FLAGGED", detail: report.modelIssue });
  // A flag whose detail did not survive is still worth naming.
  for (const flag of row.qaFlags) {
    if (!seen.has(flag) && !problems.some((problem) => problem.code === flag)) {
      problems.push({ code: flag });
    }
  }
  return problems;
}

/**
 * Units eligible for repair right now: flagged, under the ceiling, and whose source is unchanged.
 *
 * Needed as its own planner because `pendingUnits` deliberately will not return these: a
 * NEEDS_REVIEW row whose hash still matches its source is not stale, so a SYNC skips it for ever.
 *
 * ITEM_VARIANT is excluded because `extractAll` has no branch for it — variants are derived from
 * their master by `deriveVariantTranslations`, so a repair job for one could only fail three times
 * and end up SKIPPED.
 */
export async function repairCandidates(
  db: PrismaClient,
  locale: string,
): Promise<TranslationUnit[]> {
  const language = await db.language.findUniqueOrThrow({
    where: { code: locale },
    select: { glossaryVersion: true, isBuiltIn: true },
  });
  // en and nb are authored, not translated: there is nothing here to repair.
  if (language.isBuiltIn) return [];

  // Index: Translation[locale, status, createdAt] — locale + status are the leading columns.
  const rows = await db.translation.findMany({
    where: {
      locale,
      status: "NEEDS_REVIEW",
      entity: { not: "ITEM_VARIANT" },
      repairAttempts: { lt: MAX_REPAIR_ATTEMPTS },
    },
    select: { entity: true, entityId: true, sourceHash: true },
  });
  if (rows.length === 0) return [];

  const units = await extractAll(db, {
    glossaryVersion: language.glossaryVersion,
  });
  const byKey = new Map(
    units.map((unit) => [`${unit.entity}:${unit.entityId}`, unit]),
  );

  return rows.flatMap((row) => {
    const unit = byKey.get(`${row.entity}:${row.entityId}`);
    // A stale row belongs to SYNC, not REPAIR: re-translating from the new source is a fresh
    // translation with a fresh repair budget, not a second attempt at the old one.
    return unit && unit.sourceHash === row.sourceHash ? [unit] : [];
  });
}

/** Rough per-unit token cost of a repair: the previous attempt and its findings ride along. */
const ESTIMATED_PROMPT_TOKENS_PER_UNIT = 420;
const ESTIMATED_COMPLETION_TOKENS_PER_UNIT = 280;

/** Plan a repair run. No AI call, so an admin sees the size and the bill before committing. */
export async function planRepairRun(
  db: PrismaClient,
  locale: string,
  input: { startedById: string | null },
): Promise<RunPlan> {
  const candidates = await repairCandidates(db, locale);
  const run = await db.translationRun.create({
    data: {
      locale,
      kind: "REPAIR",
      status: "PENDING",
      plannedUnits: candidates.length,
      startedById: input.startedById,
      estimatedUsd:
        ((candidates.length *
          (ESTIMATED_PROMPT_TOKENS_PER_UNIT +
            ESTIMATED_COMPLETION_TOKENS_PER_UNIT)) /
          1000) *
        ESTIMATED_USD_PER_1K_TOKENS,
      enqueuedAt: new Date(),
    },
    select: { id: true, estimatedUsd: true },
  });

  if (candidates.length > 0) {
    await db.translationJob.createMany({
      data: candidates.map((unit) => ({
        runId: run.id,
        entity: unit.entity,
        entityId: unit.entityId,
        sourceHash: unit.sourceHash,
      })),
      skipDuplicates: true,
    });
  }

  const byEntity: Record<string, number> = {};
  for (const unit of candidates)
    byEntity[unit.entity] = (byEntity[unit.entity] ?? 0) + 1;

  return {
    runId: run.id,
    locale,
    plannedUnits: candidates.length,
    byEntity,
    estimatedPromptTokens: candidates.length * ESTIMATED_PROMPT_TOKENS_PER_UNIT,
    estimatedCompletionTokens:
      candidates.length * ESTIMATED_COMPLETION_TOKENS_PER_UNIT,
    estimatedUsd: run.estimatedUsd,
  };
}

/** What the flagged rows currently say, read fresh at slice time rather than trusted from plan. */
export async function repairContextFor(
  db: PrismaClient,
  locale: string,
  entity: TranslatableEntity,
  ids: string[],
): Promise<Map<string, RepairContext>> {
  if (ids.length === 0) return new Map();
  // Index: Translation @@unique([locale, entity, entityId]).
  const rows = await db.translation.findMany({
    where: { locale, entity, entityId: { in: ids } },
    select: {
      entityId: true,
      value: true,
      qaFlags: true,
      qaReport: true,
      reviewNote: true,
      repairAttempts: true,
      sourceHash: true,
    },
  });
  return new Map(
    rows.map((row) => [
      row.entityId,
      {
        value: row.value as unknown as UnitPayload,
        qaFlags: row.qaFlags,
        problems: repairProblems(row),
        reviewNote: row.reviewNote,
        repairAttempts: row.repairAttempts,
        sourceHash: row.sourceHash,
      },
    ]),
  );
}

export interface RepairOutcome {
  translated: TranslatedUnit[];
  /** Units that cost a repair attempt (a model call or a memory hit) — re-QA-only ones do not. */
  consumed: Set<string>;
}

interface Candidate {
  unit: TranslationUnit;
  value: UnitPayload;
  fromMemory: boolean;
  modelVersion: string | null;
  promptVersion: string | null;
  providerLabel: string | null;
  promptTokens: number;
  completionTokens: number;
  issue?: string;
}

/**
 * Repair one batch.
 *
 * Returns what should be written; writing is `storeRepairs`' job, so the runner keeps control of
 * the run counters and of which units were superseded while this ran.
 */
export async function repairBatch(
  db: PrismaClient,
  language: LanguagePolicy,
  units: TranslationUnit[],
  context: Map<string, RepairContext>,
  options: { signal?: AbortSignal } = {},
): Promise<RepairOutcome> {
  const consumed = new Set<string>();
  const candidates: Candidate[] = [];
  const toTranslate: TranslationUnit[] = [];

  for (const unit of units) {
    const ctx = context.get(unit.entityId);
    if (!ctx) continue; // superseded since planning; storeRepairs would refuse it anyway
    if (isReQaOnly(ctx.qaFlags)) {
      // The text was never the problem — re-check it, spend nothing, charge nothing.
      candidates.push({
        unit,
        value: ctx.value,
        fromMemory: false,
        modelVersion: null,
        promptVersion: null,
        providerLabel: null,
        promptTokens: 0,
        completionTokens: 0,
      });
    } else {
      toTranslate.push(unit);
      consumed.add(unit.entityId);
    }
  }

  // Memory first, but only a hit that passes the deterministic gate: a sibling repaired one batch
  // ago, or a human edit of identical English, is exactly what we want to find here. Only clean
  // translations are ever remembered, so a hit can never be the flagged text coming back.
  if (toTranslate.length > 0) {
    const hashes = toTranslate.map((unit) =>
      memoryHash(unit.entity, unit.en, language.glossaryVersion),
    );
    const memory = await probeMemory(db, language.code, hashes);
    const pending: TranslationUnit[] = [];

    toTranslate.forEach((unit, position) => {
      const hit = memory.get(hashes[position]);
      const usable =
        hit !== undefined &&
        checkTranslation({
          entity: unit.entity,
          locale: language.code,
          source: unit.en,
          translated: hit.value,
          ...(unit.correctOptionKey
            ? { correctOptionKey: unit.correctOptionKey }
            : {}),
        }).passed;
      if (hit && usable) {
        candidates.push({
          unit,
          value: hit.value,
          fromMemory: true,
          modelVersion: hit.modelVersion,
          promptVersion: hit.promptVersion,
          providerLabel: null,
          promptTokens: 0,
          completionTokens: 0,
        });
      } else {
        pending.push(unit);
      }
    });

    if (pending.length > 0) {
      // Temperature 0: the previous attempt already showed what sampling produces from this
      // source. What changes the answer is the finding in the prompt, not more randomness.
      const response = await aiJson({
        task: "translation",
        prompt: translateRepairPrompt,
        vars: {
          targetLanguage: language.englishName,
          targetCode: language.code,
          styleNote: language.styleNote ?? "",
          glossaryBlock: glossaryBlock(language.glossary),
          unitsJson: JSON.stringify(
            pending.map((unit) => {
              const ctx = context.get(unit.entityId)!;
              return {
                id: unit.entityId,
                kind: unit.entity,
                correctOptionKey: unit.correctOptionKey,
                en: unit.en,
                nb: unit.nb,
                previous: ctx.value,
                problems: ctx.problems,
                reviewerNote: ctx.reviewNote,
              };
            }),
          ),
        },
        schema: translationResponseSchema,
        temperature: 0,
        maxTokens: 8192,
        ...(options.signal ? { signal: options.signal } : {}),
      });

      const perUnitPrompt = Math.round(
        response.usage.promptTokens / pending.length,
      );
      const perUnitCompletion = Math.round(
        response.usage.completionTokens / pending.length,
      );
      const byId = new Map(
        response.data.units.map((entry) => [entry.id, entry]),
      );
      for (const unit of pending) {
        const entry = byId.get(unit.entityId);
        if (!entry) {
          // The model dropped an item. Its job stays unfinished rather than silently vanishing.
          logger.warn(
            {
              locale: language.code,
              entity: unit.entity,
              entityId: unit.entityId,
            },
            "repair returned no unit",
          );
          continue;
        }
        candidates.push({
          unit,
          value: shapeLike(unit.en, entry.value as Record<string, unknown>),
          fromMemory: false,
          modelVersion: response.modelVersion,
          promptVersion: response.promptVersion,
          providerLabel: response.providerLabel,
          promptTokens: perUnitPrompt,
          completionTokens: perUnitCompletion,
          ...(entry.issue ? { issue: entry.issue } : {}),
        });
      }
    }
  }

  // Every candidate is QA'd, whatever this language's qaSampleRate says: repair raises scrutiny,
  // never lowers it. A repair that passes the structural gate and still means something else is
  // precisely the failure a second attempt is most likely to produce.
  const results: TranslatedUnit[] = candidates.map((candidate) => {
    const check = checkTranslation({
      entity: candidate.unit.entity,
      locale: language.code,
      source: candidate.unit.en,
      translated: candidate.value,
      ...(candidate.unit.correctOptionKey
        ? { correctOptionKey: candidate.unit.correctOptionKey }
        : {}),
    });
    const flags = allCodes(check);
    if (candidate.issue) flags.push("MODEL_FLAGGED");
    return {
      unit: candidate.unit,
      value: candidate.value,
      status: check.passed && !candidate.issue ? "MACHINE" : "NEEDS_REVIEW",
      qaFlags: flags,
      qaReport: {
        source: candidate.fromMemory ? "memory" : "repair",
        issues: check.issues,
        ...(candidate.issue ? { modelIssue: candidate.issue } : {}),
      },
      semanticScore: null,
      fromMemory: candidate.fromMemory,
      modelVersion: candidate.modelVersion,
      promptVersion: candidate.promptVersion,
      providerLabel: candidate.providerLabel,
      promptTokens: candidate.promptTokens,
      completionTokens: candidate.completionTokens,
    };
  });

  const qaInputs: QaInput[] = results.map((result) => ({
    id: result.unit.entityId,
    entity: result.unit.entity,
    source: result.unit.en,
    translated: result.value,
    ...(result.unit.correctOptionKey
      ? { correctOptionKey: result.unit.correctOptionKey }
      : {}),
  }));
  const semantic = await semanticCheck({
    locale: language.code,
    languageName: language.englishName,
    units: qaInputs,
    ...(options.signal ? { signal: options.signal } : {}),
  });

  for (const result of results) {
    const verdict = semantic.get(result.unit.entityId);
    if (!verdict) continue;
    result.semanticScore = verdict.semanticScore;
    result.qaFlags = [...new Set([...result.qaFlags, ...verdict.flags])];
    result.qaReport = { ...(result.qaReport ?? {}), semantic: verdict.report };
    if (verdict.flags.length > 0) result.status = "NEEDS_REVIEW";
  }

  return { translated: results, consumed };
}

/**
 * Store repairs WITHOUT the unconditional upsert `storeTranslations` uses.
 *
 * A repair run is planned from NEEDS_REVIEW rows, which are exactly the rows a reviewer is working
 * through right now — and `storeTranslations` would overwrite the value and null out
 * `reviewedById`/`reviewedAt`/`reviewNote` on the way past. So the write is conditional: only a
 * row that is still NEEDS_REVIEW on the same source is touched. `count === 0` means a human
 * approved, edited or rejected it, or the source moved, while the batch was in the model — that
 * unit is reported as superseded, its job is SKIPPED, and nothing about it is written, remembered
 * included.
 */
export async function storeRepairs(
  db: PrismaClient,
  locale: string,
  results: TranslatedUnit[],
  runId: string,
  consumed: Set<string>,
  glossaryVersion: number,
): Promise<Set<string>> {
  const superseded = new Set<string>();

  for (const item of results) {
    // Index: Translation @@unique([locale, entity, entityId]); status and sourceHash are the
    // guard, not the lookup — the row must still be the one repair was planned from.
    const updated = await db.translation.updateMany({
      where: {
        locale,
        entity: item.unit.entity,
        entityId: item.unit.entityId,
        status: "NEEDS_REVIEW",
        sourceHash: item.unit.sourceHash,
        // The ceiling, made structural. The planner already filters on it, but that read happened
        // before the batch went to the model: a row that reached three attempts in the meantime
        // must not be written a fourth time, whatever planned it.
        repairAttempts: { lt: MAX_REPAIR_ATTEMPTS },
      },
      data: {
        value: item.value as object,
        status: item.status,
        qaFlags: item.qaFlags,
        qaReport: (item.qaReport ?? undefined) as object | undefined,
        semanticScore: item.semanticScore,
        fromMemory: item.fromMemory,
        modelVersion: item.modelVersion,
        promptVersion: item.promptVersion,
        providerLabel: item.providerLabel,
        promptTokens: item.promptTokens,
        completionTokens: item.completionTokens,
        runId,
        // Whatever a reviewer noted was about the text this replaces.
        reviewedById: null,
        reviewedAt: null,
        reviewNote: null,
        // Only a unit that actually spent an attempt is charged for one.
        ...(consumed.has(item.unit.entityId)
          ? { repairAttempts: { increment: 1 } }
          : {}),
      },
    });

    if (updated.count === 0) {
      superseded.add(item.unit.entityId);
      continue;
    }

    // Only a clean repair is worth remembering — and only one that actually landed.
    if (item.status === "MACHINE" && !item.fromMemory) {
      await rememberTranslation(db, {
        locale,
        entity: item.unit.entity,
        source: item.unit.en,
        value: item.value,
        glossaryVersion,
        modelVersion: item.modelVersion,
        promptVersion: item.promptVersion,
      });
    }
  }

  return superseded;
}
