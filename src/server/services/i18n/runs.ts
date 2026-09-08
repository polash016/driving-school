import type {
  PrismaClient,
  TranslatableEntity,
  TranslationRunKind,
} from "@prisma/client";
import { logger } from "@/lib/logger";
import { AUDIT, auditLog } from "@/server/audit";
import { extractAll, pendingUnits, pruneOrphans } from "./extract";
import { invalidateMessages } from "./catalogue";
import { ESTIMATED_USD_PER_1K_TOKENS } from "./run-math";
import {
  BATCH_SIZE,
  storeTranslations,
  translateBatch,
  type LanguagePolicy,
} from "./translate";
import type { TranslationUnit } from "./units";

/**
 * The translation runner (spec-15).
 *
 * There is no job queue in this stack — BullMQ is not installed and adding it is spec-06's
 * decision, not this one's. So the run IS the queue: the work is planned into rows, claimed under
 * a lease, and a process that dies mid-run loses nothing but its lease. Re-running picks up where
 * it stopped, and never re-translates anything already done.
 *
 * Planning costs nothing — no AI call at all — which is what lets an admin see the size and the
 * bill before committing to it.
 */

/** How long a runner holds its claim before another may take over. */
const LEASE_MINUTES = 2;
/** After this many tries a unit is left alone, so one bad item cannot stall a whole run. */
const MAX_ATTEMPTS = 3;

/**
 * Rough per-unit token cost, used only for the estimate shown before a run starts.
 *
 * Deliberately a guess, and labelled as one: the runner records real `promptTokens` and
 * `completionTokens` on every row, so the second language's estimate can come from the first
 * language's measurements rather than from this constant.
 */
const ESTIMATED_PROMPT_TOKENS_PER_UNIT = 420;
const ESTIMATED_COMPLETION_TOKENS_PER_UNIT = 260;

export interface RunPlan {
  runId: string;
  locale: string;
  plannedUnits: number;
  byEntity: Record<string, number>;
  estimatedPromptTokens: number;
  estimatedCompletionTokens: number;
  estimatedUsd: number;
}

async function languagePolicy(
  db: PrismaClient,
  locale: string,
): Promise<LanguagePolicy> {
  const language = await db.language.findUniqueOrThrow({
    where: { code: locale },
    select: {
      code: true,
      englishName: true,
      nativeName: true,
      glossary: true,
      glossaryVersion: true,
      styleNote: true,
      qaSampleRate: true,
      isBuiltIn: true,
    },
  });
  if (language.isBuiltIn) {
    // en and nb are authored, not translated. Translating them would overwrite the source of truth
    // with a paraphrase of itself.
    throw new Error(
      `${locale} is a built-in language and is authored, not translated`,
    );
  }
  return {
    code: language.code,
    englishName: language.englishName,
    nativeName: language.nativeName,
    glossary: (language.glossary as Record<string, string> | null) ?? null,
    glossaryVersion: language.glossaryVersion,
    styleNote: language.styleNote,
    qaSampleRate: language.qaSampleRate,
  };
}

/**
 * Work out what needs doing, and what it will cost, WITHOUT calling a model.
 *
 * Safe to call from a server action for that reason — everything expensive happens in `executeRun`.
 */
export async function planRun(
  db: PrismaClient,
  locale: string,
  input: {
    kind: TranslationRunKind;
    only?: TranslatableEntity[];
    startedById?: string | null;
  },
): Promise<RunPlan> {
  const language = await languagePolicy(db, locale);
  const all = await extractAll(db, {
    glossaryVersion: language.glossaryVersion,
    only: input.only,
  });
  // Clear out translations whose source has since been renamed or deleted. They cannot be served,
  // cannot be reviewed, and would otherwise sit in the queue for ever.
  const pruned = await pruneOrphans(db, locale, all);
  if (pruned > 0)
    logger.info({ locale, pruned }, "removed orphaned translations");

  const pending = await pendingUnits(db, locale, all);

  const run = await db.translationRun.create({
    data: {
      locale,
      kind: input.kind,
      status: "PENDING",
      plannedUnits: pending.length,
      startedById: input.startedById ?? null,
      estimatedUsd:
        ((pending.length *
          (ESTIMATED_PROMPT_TOKENS_PER_UNIT +
            ESTIMATED_COMPLETION_TOKENS_PER_UNIT)) /
          1000) *
        ESTIMATED_USD_PER_1K_TOKENS,
    },
    select: { id: true, estimatedUsd: true },
  });

  if (pending.length > 0) {
    await db.translationJob.createMany({
      data: pending.map((unit) => ({
        runId: run.id,
        entity: unit.entity,
        entityId: unit.entityId,
        sourceHash: unit.sourceHash,
      })),
      skipDuplicates: true,
    });
  }

  const byEntity: Record<string, number> = {};
  for (const unit of pending)
    byEntity[unit.entity] = (byEntity[unit.entity] ?? 0) + 1;

  return {
    runId: run.id,
    locale,
    plannedUnits: pending.length,
    byEntity,
    estimatedPromptTokens: pending.length * ESTIMATED_PROMPT_TOKENS_PER_UNIT,
    estimatedCompletionTokens:
      pending.length * ESTIMATED_COMPLETION_TOKENS_PER_UNIT,
    estimatedUsd: run.estimatedUsd,
  };
}

/**
 * Copy an approved master translation onto the variants a student is actually served.
 *
 * Free — no AI call. Every question today is one master with one variant that mirrors it, so this
 * is a straight copy; a templated item would need its slots expanded, which is why those are out
 * of scope for now.
 *
 * Variants left behind by an OLDER master version are deliberately not derived: showing a student
 * a translation of a different question than the English they sat is precisely the failure this
 * whole spec exists to avoid. They stay untranslated and read English.
 */
export async function deriveVariantTranslations(
  db: PrismaClient,
  locale: string,
  masterItemIds: string[],
): Promise<number> {
  if (masterItemIds.length === 0) return 0;

  const [masters, translations] = await Promise.all([
    db.masterItem.findMany({
      where: { id: { in: masterItemIds } },
      select: {
        id: true,
        version: true,
        variants: {
          where: { isActive: true },
          select: { id: true, masterVersion: true },
        },
      },
    }),
    db.translation.findMany({
      where: { locale, entity: "MASTER_ITEM", entityId: { in: masterItemIds } },
      select: {
        entityId: true,
        value: true,
        status: true,
        sourceHash: true,
        qaFlags: true,
      },
    }),
  ]);

  const byMaster = new Map(translations.map((row) => [row.entityId, row]));
  let derived = 0;

  for (const master of masters) {
    const translation = byMaster.get(master.id);
    if (!translation) continue;
    for (const variant of master.variants) {
      if (variant.masterVersion !== master.version) continue;
      await db.translation.upsert({
        where: {
          locale_entity_entityId: {
            locale,
            entity: "ITEM_VARIANT",
            entityId: variant.id,
          },
        },
        create: {
          locale,
          entity: "ITEM_VARIANT",
          entityId: variant.id,
          value: translation.value as object,
          status: translation.status,
          sourceHash: translation.sourceHash,
          qaFlags: translation.qaFlags,
          fromMemory: true,
        },
        update: {
          value: translation.value as object,
          status: translation.status,
          sourceHash: translation.sourceHash,
          qaFlags: translation.qaFlags,
        },
        select: { id: true },
      });
      derived++;
    }
  }
  return derived;
}

export interface RunProgress {
  runId: string;
  status: string;
  planned: number;
  completed: number;
  failed: number;
  flagged: number;
  memoryHits: number;
  done: boolean;
}

/**
 * Do the work.
 *
 * Claims the run under a lease first, so two runners (a script and an admin action, say) cannot
 * translate the same units twice. `maxUnits` lets a caller take a bounded slice and come back —
 * which is how the admin screen makes progress without holding a request open for ten minutes.
 */
export async function executeRun(
  db: PrismaClient,
  runId: string,
  options: {
    leaseOwner: string;
    maxUnits?: number;
    onProgress?: (progress: RunProgress) => void;
  },
): Promise<RunProgress> {
  const now = new Date();
  const claimed = await db.translationRun.updateMany({
    where: {
      id: runId,
      status: { in: ["PENDING", "PAUSED", "RUNNING"] },
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
    },
    data: {
      status: "RUNNING",
      leaseOwner: options.leaseOwner,
      // Extending the lease each batch IS the heartbeat: a run whose lease has lapsed was
      // abandoned, and another runner may take it over.
      leaseExpiresAt: new Date(now.getTime() + LEASE_MINUTES * 60_000),
      startedAt: now,
    },
  });

  const run = await db.translationRun.findUniqueOrThrow({
    where: { id: runId },
    select: {
      id: true,
      locale: true,
      status: true,
      plannedUnits: true,
      translatedUnits: true,
      failedUnits: true,
      flaggedUnits: true,
      memoryHits: true,
      leaseOwner: true,
    },
  });

  if (claimed.count !== 1 && run.leaseOwner !== options.leaseOwner) {
    // Someone else is on it. Not an error — report where they have got to.
    return {
      runId,
      status: run.status,
      planned: run.plannedUnits,
      completed: run.translatedUnits,
      failed: run.failedUnits,
      flagged: run.flaggedUnits,
      memoryHits: run.memoryHits,
      done: false,
    };
  }

  const language = await languagePolicy(db, run.locale);
  let processed = 0;
  const budget = options.maxUnits ?? Number.POSITIVE_INFINITY;
  const translatedMasterIds: string[] = [];

  for (;;) {
    if (processed >= budget) break;

    // A batch that failed on a provider outage is worth another go; one that has failed three
    // times is a real problem with that unit, and is left alone so the run can finish.
    await db.translationJob.updateMany({
      where: { runId, state: "FAILED", attempts: { lt: MAX_ATTEMPTS } },
      data: { state: "QUEUED", error: null },
    });
    await db.translationJob.updateMany({
      where: { runId, state: "FAILED", attempts: { gte: MAX_ATTEMPTS } },
      data: { state: "SKIPPED" },
    });

    // One entity kind at a time, so a batch shares a prompt shape.
    const jobs = await db.translationJob.findMany({
      where: { runId, state: "QUEUED" },
      orderBy: [{ entity: "asc" }, { id: "asc" }],
      take: Math.min(BATCH_SIZE, budget - processed),
      select: { id: true, entity: true, entityId: true },
    });
    if (jobs.length === 0) break;

    const entity = jobs[0].entity;
    const batch = jobs.filter((job) => job.entity === entity);

    const claimedJobs = await db.translationJob.updateMany({
      where: { id: { in: batch.map((job) => job.id) }, state: "QUEUED" },
      data: {
        state: "RUNNING",
        startedAt: new Date(),
        attempts: { increment: 1 },
      },
    });
    if (claimedJobs.count === 0) continue;

    // Re-extract just this slice, so the source is read fresh rather than trusted from plan time.
    const units = await unitsFor(
      db,
      language,
      entity,
      batch.map((job) => job.entityId),
    );

    try {
      const translated = await translateBatch(db, language, units);
      await storeTranslations(db, run.locale, translated, runId);

      const flagged = translated.filter(
        (item) => item.status !== "MACHINE",
      ).length;
      const memoryHits = translated.filter((item) => item.fromMemory).length;
      const promptTokens = translated.reduce(
        (sum, item) => sum + item.promptTokens,
        0,
      );
      const completionTokens = translated.reduce(
        (sum, item) => sum + item.completionTokens,
        0,
      );

      if (entity === "MASTER_ITEM") {
        translatedMasterIds.push(
          ...translated.map((item) => item.unit.entityId),
        );
      }

      const doneIds = new Set(translated.map((item) => item.unit.entityId));
      await db.translationJob.updateMany({
        where: { runId, entityId: { in: [...doneIds] }, state: "RUNNING" },
        data: { state: "DONE", finishedAt: new Date() },
      });
      // Anything the model silently dropped stays FAILED rather than vanishing.
      await db.translationJob.updateMany({
        where: {
          runId,
          id: { in: batch.map((job) => job.id) },
          state: "RUNNING",
        },
        data: {
          state: "FAILED",
          error: "no translation returned",
          finishedAt: new Date(),
        },
      });

      await db.translationRun.update({
        where: { id: runId },
        data: {
          translatedUnits: { increment: translated.length },
          flaggedUnits: { increment: flagged },
          memoryHits: { increment: memoryHits },
          promptTokens: { increment: promptTokens },
          completionTokens: { increment: completionTokens },
          leaseExpiresAt: new Date(Date.now() + LEASE_MINUTES * 60_000),
        },
        select: { id: true },
      });
      processed += batch.length;
    } catch (error) {
      // One bad batch must not end a run of three thousand. Record it and carry on.
      logger.error({ error, runId, entity }, "translation batch failed");
      await db.translationJob.updateMany({
        where: {
          runId,
          id: { in: batch.map((job) => job.id) },
          state: "RUNNING",
        },
        data: {
          state: "FAILED",
          error:
            error instanceof Error ? error.message.slice(0, 300) : "unknown",
          finishedAt: new Date(),
        },
      });
      await db.translationRun.update({
        where: { id: runId },
        data: {
          failedUnits: { increment: batch.length },
          leaseExpiresAt: new Date(Date.now() + LEASE_MINUTES * 60_000),
        },
        select: { id: true },
      });
      processed += batch.length;
    }

    options.onProgress?.(await progressOf(db, runId));
  }

  // Push approved question translations out to the variants students are served.
  if (translatedMasterIds.length > 0) {
    await deriveVariantTranslations(db, run.locale, translatedMasterIds);
  }
  await invalidateMessages(run.locale);

  const remaining = await db.translationJob.count({
    where: { runId, state: "QUEUED" },
  });
  const finished = remaining === 0;
  if (finished) {
    await db.translationRun.update({
      where: { id: runId },
      data: {
        status: "COMPLETED",
        finishedAt: new Date(),
        leaseOwner: null,
        leaseExpiresAt: null,
      },
      select: { id: true },
    });
    await db.language.update({
      where: { code: run.locale },
      data: { lastSyncedAt: new Date() },
      select: { code: true },
    });
    await auditLog({
      actorId: null,
      action: AUDIT.translationRunFinished,
      entityType: "TranslationRun",
      entityId: runId,
      meta: { locale: run.locale },
    });
  } else {
    await db.translationRun.update({
      where: { id: runId },
      data: { status: "PAUSED", leaseOwner: null, leaseExpiresAt: null },
      select: { id: true },
    });
  }

  return progressOf(db, runId);
}

async function unitsFor(
  db: PrismaClient,
  language: LanguagePolicy,
  entity: TranslatableEntity,
  ids: string[],
): Promise<TranslationUnit[]> {
  const all = await extractAll(db, {
    glossaryVersion: language.glossaryVersion,
    only: [entity],
  });
  const wanted = new Set(ids);
  return all.filter((unit) => wanted.has(unit.entityId));
}

export async function progressOf(
  db: PrismaClient,
  runId: string,
): Promise<RunProgress> {
  const run = await db.translationRun.findUniqueOrThrow({
    where: { id: runId },
    select: {
      id: true,
      status: true,
      plannedUnits: true,
      translatedUnits: true,
      failedUnits: true,
      flaggedUnits: true,
      memoryHits: true,
    },
  });
  const remaining = await db.translationJob.count({
    where: { runId, state: "QUEUED" },
  });
  return {
    runId: run.id,
    status: run.status,
    planned: run.plannedUnits,
    completed: run.translatedUnits,
    failed: run.failedUnits,
    flagged: run.flaggedUnits,
    memoryHits: run.memoryHits,
    done: remaining === 0,
  };
}
