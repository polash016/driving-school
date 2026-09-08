import type { PrismaClient, TranslatableEntity } from "@prisma/client";
import { extractAll, pendingUnits } from "./extract";
import { sourceFor } from "./review";
import { ESTIMATED_USD_PER_1K_TOKENS } from "./run-math";
// Type-only: erased at compile time, so runs.ts is free to grow a runtime import of this module
// later without closing a loop.
import type { RunPlan } from "./runs";
import type { TranslationUnit, UnitPayload } from "./units";

/**
 * The sample-first dry run (spec-19).
 *
 * A full language is three thousand units and several hours, and the two things most likely to be
 * wrong about it — the glossary and the style note — are wrong in the same way on the first unit
 * as on the three-thousandth. So translate five, put them next to their source, and let a human
 * look before anyone commits to the bill.
 *
 * A sample is a real run: the same worker, the same prompts, the same QA. What it deliberately is
 * NOT is a sync — `executeRun` leaves `Language.lastSyncedAt` alone for this kind, skips the
 * `translationRunFinished` audit entry, and `maybePlanRepair` never chains a repair off it.
 */

/** Small enough to read in a minute, wide enough to show more than one kind of content. */
const DEFAULT_SAMPLE_SIZE = 5;

/** Same guess `planRun` uses, per unit: 420 prompt + 260 completion tokens. */
const ESTIMATED_PROMPT_TOKENS_PER_UNIT = 420;
const ESTIMATED_COMPLETION_TOKENS_PER_UNIT = 260;

export async function planSampleRun(
  db: PrismaClient,
  locale: string,
  input: { size?: number; startedById: string | null },
): Promise<RunPlan> {
  const size = input.size ?? DEFAULT_SAMPLE_SIZE;
  // Index: Language primary key (code).
  const language = await db.language.findUniqueOrThrow({
    where: { code: locale },
    select: { glossaryVersion: true, isBuiltIn: true },
  });
  if (language.isBuiltIn) {
    // Same refusal `languagePolicy` makes, made before a row is written: an enqueued run for a
    // built-in language is invisible to the worker's claim query and would sit PENDING for ever.
    throw new Error(
      `${locale} is a built-in language and is authored, not translated`,
    );
  }

  const all = await extractAll(db, {
    glossaryVersion: language.glossaryVersion,
  });
  const pending = await pendingUnits(db, locale, all);

  // Round-robin across entity kinds so a 5-unit sample shows a question, a topic, a sign, a
  // message… rather than five UI strings, which is what taking the first five would give — the
  // extractor emits every message key before it emits anything else.
  const byEntity = new Map<TranslatableEntity, TranslationUnit[]>();
  for (const unit of pending)
    byEntity.set(unit.entity, [...(byEntity.get(unit.entity) ?? []), unit]);
  const chosen: TranslationUnit[] = [];
  const queues = [...byEntity.values()];
  for (
    let i = 0;
    chosen.length < size && queues.some((queue) => queue.length > 0);
    i++
  ) {
    const next = queues[i % queues.length].shift();
    if (next) chosen.push(next);
  }

  const run = await db.translationRun.create({
    data: {
      locale,
      kind: "SAMPLE",
      status: "PENDING",
      plannedUnits: chosen.length,
      startedById: input.startedById,
      estimatedUsd:
        ((chosen.length *
          (ESTIMATED_PROMPT_TOKENS_PER_UNIT +
            ESTIMATED_COMPLETION_TOKENS_PER_UNIT)) /
          1000) *
        ESTIMATED_USD_PER_1K_TOKENS,
      // Enqueued on creation: a sample has no preview step of its own — it IS the preview.
      enqueuedAt: new Date(),
    },
    select: { id: true, estimatedUsd: true },
  });

  if (chosen.length > 0) {
    await db.translationJob.createMany({
      data: chosen.map((unit) => ({
        runId: run.id,
        entity: unit.entity,
        entityId: unit.entityId,
        sourceHash: unit.sourceHash,
      })),
    });
  }

  const counts: Record<string, number> = {};
  for (const unit of chosen)
    counts[unit.entity] = (counts[unit.entity] ?? 0) + 1;

  return {
    runId: run.id,
    locale,
    plannedUnits: chosen.length,
    byEntity: counts,
    estimatedPromptTokens: chosen.length * ESTIMATED_PROMPT_TOKENS_PER_UNIT,
    estimatedCompletionTokens:
      chosen.length * ESTIMATED_COMPLETION_TOKENS_PER_UNIT,
    estimatedUsd: run.estimatedUsd,
  };
}

export interface SampleItem {
  entity: TranslatableEntity;
  entityId: string;
  label: string;
  source: UnitPayload | null;
  value: UnitPayload | null;
  status: string | null;
  qaFlags: string[];
}

export interface SampleResultsView {
  runId: string;
  status: string;
  items: SampleItem[];
}

/**
 * What the sample produced, beside what it was translated from.
 *
 * Joined through the run's own jobs rather than through `Translation.runId`, and that is not an
 * arbitrary choice: `storeTranslations` overwrites `runId` on every upsert, so the first SYNC to
 * touch a sampled unit would quietly detach it from the sample it belongs to and the screen would
 * lose rows it had already shown. The jobs are the run's record of what it planned, and nothing
 * ever rewrites them.
 *
 * Rows are read one page at a time by construction — a sample is five units.
 */
export async function sampleResults(
  db: PrismaClient,
  runId: string,
): Promise<SampleResultsView> {
  // Index: TranslationRun primary key; jobs by TranslationJob[runId, state, entity].
  const run = await db.translationRun.findUniqueOrThrow({
    where: { id: runId },
    select: {
      locale: true,
      status: true,
      jobs: {
        select: { entity: true, entityId: true },
        orderBy: [{ entity: "asc" }, { entityId: "asc" }],
      },
    },
  });

  // Index: Translation[locale, entity, entityId] — the unique, which is also the resolver's key.
  const rows = await db.translation.findMany({
    where: {
      locale: run.locale,
      OR: run.jobs.map((job) => ({
        entity: job.entity,
        entityId: job.entityId,
      })),
    },
    select: {
      entity: true,
      entityId: true,
      value: true,
      status: true,
      qaFlags: true,
    },
  });
  const byKey = new Map(
    rows.map((row) => [`${row.entity}:${row.entityId}`, row]),
  );

  const items = await Promise.all(
    run.jobs.map(async (job) => {
      const row = byKey.get(`${job.entity}:${job.entityId}`);
      return {
        entity: job.entity,
        entityId: job.entityId,
        label: job.entityId,
        source: await sourceFor(db, job.entity, job.entityId),
        // Null until the worker reaches this unit — the screen fills in as the run progresses
        // rather than showing nothing until the whole sample is done.
        value: (row?.value as UnitPayload | undefined) ?? null,
        status: row?.status ?? null,
        qaFlags: row?.qaFlags ?? [],
      };
    }),
  );

  return { runId, status: run.status, items };
}
