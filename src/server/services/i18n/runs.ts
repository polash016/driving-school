import type {
  PrismaClient,
  TranslatableEntity,
  TranslationRunKind,
} from "@prisma/client";
import { logger } from "@/lib/logger";
import { AUDIT, auditLog } from "@/server/audit";
import { extractAll, pendingUnits, pruneOrphans } from "./extract";
import { invalidateMessages } from "./catalogue";
import { repairBatch, repairContextFor, storeRepairs } from "./repair";
import { batchRate, ESTIMATED_USD_PER_1K_TOKENS, ewmaRate } from "./run-math";
import {
  BATCH_SIZE,
  storeTranslations,
  translateBatch,
  type LanguagePolicy,
  type TranslatedUnit,
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
    /** Hand the run to the background worker. Without it this is a cost-free preview. */
    enqueue?: boolean;
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

  if (input.enqueue) {
    // At most one live plan per locale: an old cost-free preview must not be executable later
    // against a bank that has since changed.
    // Index: TranslationRun[locale, status, createdAt].
    await db.translationRun.updateMany({
      where: { locale, status: "PENDING", enqueuedAt: null },
      data: {
        status: "CANCELLED",
        error: "superseded",
        finishedAt: new Date(),
      },
    });
  }

  const run = await db.translationRun.create({
    data: {
      locale,
      kind: input.kind,
      status: "PENDING",
      plannedUnits: pending.length,
      startedById: input.startedById ?? null,
      ...(input.enqueue ? { enqueuedAt: new Date() } : {}),
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

export type StopReason =
  | "finished"
  | "budget"
  | "paused"
  | "cancelled"
  | "aborted"
  | "lostLease"
  | "notClaimed"
  | "localeBusy";

export interface RunProgress {
  runId: string;
  status: string;
  planned: number;
  completed: number;
  failed: number;
  flagged: number;
  memoryHits: number;
  done: boolean;
  /** Why this call returned. Every caller spreads `progressOf` and overrides this. */
  stopReason: StopReason;
}

/** Lease keepalive cadence: a quarter of the lease, so three missed ticks still hold it. */
const KEEPALIVE_MS = (LEASE_MINUTES * 60_000) / 4;

function leaseUntil(from = Date.now()): Date {
  return new Date(from + LEASE_MINUTES * 60_000);
}

/**
 * Jobs that have spent every attempt: SKIPPED, and charged to the run's failure counter once.
 *
 * Counting at the moment of failure instead would charge the same unit on every attempt — a
 * 5-unit batch failing three times rendered as "failed 15 / planned 5" — and counting nowhere at
 * all would let a run finish COMPLETED with units silently given up on. This is the one crossing
 * into a terminal state, so it is the one place the count belongs.
 */
async function retireExhausted(
  db: PrismaClient,
  runId: string,
  leaseOwner: string,
): Promise<void> {
  // Index: TranslationJob[runId, state, entity].
  const retired = await db.translationJob.updateMany({
    where: { runId, state: "FAILED", attempts: { gte: MAX_ATTEMPTS } },
    data: { state: "SKIPPED" },
  });
  if (retired.count === 0) return;
  await db.translationRun.updateMany({
    where: { id: runId, leaseOwner },
    data: { failedUnits: { increment: retired.count } },
  });
}

/**
 * Do the work.
 *
 * Claims the run under a lease first, so two runners (a script and an admin action, say) cannot
 * translate the same units twice. `maxUnits` lets a caller take a bounded slice and come back —
 * which is how the admin screen makes progress without holding a request open for ten minutes.
 *
 * Spec-19 hardened it for the unattended worker, which calls it with no bound and stays in here for
 * hours. Four things the attended callers never noticed:
 *
 * 1. The lease used to be extended only AFTER a batch. A batch is up to three provider calls, and
 *    one call on the self-hosted model has been measured at 29.7 s — so a QA'd batch routinely
 *    outlived a 2-minute lease, and the runner never found out. Now a keepalive refreshes it from
 *    inside the batch, and every write to the run row is guarded on `leaseOwner`.
 * 2. A partial claim used to translate the whole batch: `updateMany` reported 3 of 5 rows won and
 *    the code carried on with all 5. Now the claim stamps `claimedBy` and the runner re-reads
 *    exactly the rows it holds.
 * 3. Jobs a killed process left RUNNING were never re-queued, and completion only counted QUEUED —
 *    so a `kill -9` produced a COMPLETED run with units silently untranslated.
 * 4. There was no way to ask it to stop. `pauseRequested`/`cancelRequested` are read between
 *    batches, and an `AbortSignal` covers worker shutdown mid-batch.
 */
export async function executeRun(
  db: PrismaClient,
  runId: string,
  options: {
    leaseOwner: string;
    maxUnits?: number;
    onProgress?: (progress: RunProgress) => void;
    /** Worker shutdown. Checked between batches and threaded into every provider call. */
    signal?: AbortSignal;
  },
): Promise<RunProgress> {
  const now = new Date();
  const run = await db.translationRun.findUniqueOrThrow({
    where: { id: runId },
    select: {
      id: true,
      locale: true,
      kind: true,
      status: true,
      startedAt: true,
    },
  });

  // One live run per locale, whatever the entry point (worker, admin slice, CLI). Two runs
  // planned for the same language each hold a job per unit, and would translate them twice.
  // Index: TranslationRun[locale, status, createdAt].
  const busy = await db.translationRun.findFirst({
    where: {
      locale: run.locale,
      id: { not: runId },
      status: "RUNNING",
      leaseExpiresAt: { gt: now },
    },
    select: { id: true },
  });
  if (busy)
    return { ...(await progressOf(db, runId)), stopReason: "localeBusy" };

  // Index: TranslationRun[status, leaseExpiresAt].
  const claimed = await db.translationRun.updateMany({
    where: {
      id: runId,
      status: { in: ["PENDING", "PAUSED", "RUNNING"] },
      pauseRequested: false,
      cancelRequested: false,
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
    },
    data: {
      status: "RUNNING",
      leaseOwner: options.leaseOwner,
      leaseExpiresAt: leaseUntil(now.getTime()),
      heartbeatAt: now,
      ...(run.startedAt ? {} : { startedAt: now }),
    },
  });
  if (claimed.count !== 1) {
    // Someone else is on it, or an admin asked for a pause. Not an error — report where it is.
    return { ...(await progressOf(db, runId)), stopReason: "notClaimed" };
  }

  // The lease is exclusive from here. Anything a dead runner left RUNNING goes back to the queue —
  // attempts are kept, so a unit that keeps killing its runner still reaches SKIPPED.
  // Index: TranslationJob[runId, state, entity].
  await db.translationJob.updateMany({
    where: { runId, state: "RUNNING" },
    data: { state: "QUEUED", startedAt: null, claimedBy: null },
  });

  const language = await languagePolicy(db, run.locale);
  const budget = options.maxUnits ?? Number.POSITIVE_INFINITY;
  const translatedMasterIds: string[] = [];
  let processed = 0;
  let lostLease = false;
  let stopReason: StopReason = "finished";

  // Keepalive IS the heartbeat: a batch on the slow self-hosted model routinely outlives a 2-minute
  // lease, and the lease used to be extended only after a batch. Owner-guarded, so a runner that
  // has already lost the lease learns it here instead of overwriting the new owner's state.
  const keepalive = setInterval(() => {
    void db.translationRun
      .updateMany({
        where: { id: runId, leaseOwner: options.leaseOwner },
        data: { leaseExpiresAt: leaseUntil(), heartbeatAt: new Date() },
      })
      .then((result) => {
        if (result.count === 0) lostLease = true;
      })
      .catch((error: unknown) =>
        logger.warn({ error, runId }, "lease keepalive failed"),
      );
  }, KEEPALIVE_MS);

  try {
    for (;;) {
      if (lostLease) {
        stopReason = "lostLease";
        break;
      }
      if (options.signal?.aborted) {
        stopReason = "aborted";
        break;
      }
      if (processed >= budget) {
        stopReason = "budget";
        break;
      }

      const flags = await db.translationRun.findUniqueOrThrow({
        where: { id: runId },
        select: { pauseRequested: true, cancelRequested: true },
      });
      if (flags.cancelRequested) {
        stopReason = "cancelled";
        break;
      }
      if (flags.pauseRequested) {
        stopReason = "paused";
        break;
      }

      // A batch that failed on a provider outage is worth another go; one that has failed three
      // times is a real problem with that unit, and is left alone so the run can finish.
      // Index: TranslationJob[runId, state, entity].
      await db.translationJob.updateMany({
        where: { runId, state: "FAILED", attempts: { lt: MAX_ATTEMPTS } },
        data: { state: "QUEUED", error: null },
      });
      await retireExhausted(db, runId, options.leaseOwner);

      // One entity kind at a time, so a batch shares a prompt shape.
      // Index: TranslationJob[runId, state, entity].
      const jobs = await db.translationJob.findMany({
        where: { runId, state: "QUEUED" },
        orderBy: [{ entity: "asc" }, { id: "asc" }],
        take: Math.min(BATCH_SIZE, budget - processed),
        select: { id: true, entity: true, entityId: true },
      });
      if (jobs.length === 0) {
        stopReason = "finished";
        break;
      }

      const entity = jobs[0].entity;
      const wanted = jobs
        .filter((job) => job.entity === entity)
        .map((job) => job.id);
      await db.translationJob.updateMany({
        where: { id: { in: wanted }, state: "QUEUED" },
        data: {
          state: "RUNNING",
          startedAt: new Date(),
          attempts: { increment: 1 },
          claimedBy: options.leaseOwner,
        },
      });
      // Exactly what THIS runner won — another runner may have taken part of the batch. Prisma has
      // no `updateManyAndReturn` here, which is why the claim stamps an owner and we read it back.
      const batch = await db.translationJob.findMany({
        where: {
          id: { in: wanted },
          state: "RUNNING",
          claimedBy: options.leaseOwner,
        },
        select: { id: true, entity: true, entityId: true },
      });
      if (batch.length === 0) continue;

      // Re-extract just this slice, so the source is read fresh rather than trusted from plan time.
      const units = await unitsFor(
        db,
        language,
        entity,
        batch.map((job) => job.entityId),
      );
      const batchStarted = Date.now();

      try {
        const outcome =
          run.kind === "REPAIR"
            ? await repairSlice(
                db,
                run.locale,
                language,
                units,
                runId,
                options.signal,
              )
            : await translateSlice(
                db,
                run.locale,
                language,
                units,
                runId,
                options.signal,
              );
        const { translated, superseded } = outcome;

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

        const doneIds = new Set(
          translated
            .map((item) => item.unit.entityId)
            .filter((id) => !superseded.has(id)),
        );
        await db.translationJob.updateMany({
          where: {
            runId,
            entityId: { in: [...doneIds] },
            state: "RUNNING",
            claimedBy: options.leaseOwner,
          },
          data: { state: "DONE", finishedAt: new Date() },
        });
        if (superseded.size > 0) {
          await db.translationJob.updateMany({
            where: {
              runId,
              entityId: { in: [...superseded] },
              state: "RUNNING",
              claimedBy: options.leaseOwner,
            },
            data: {
              state: "SKIPPED",
              error: "superseded",
              finishedAt: new Date(),
            },
          });
        }
        // Anything the model silently dropped stays FAILED rather than vanishing.
        await db.translationJob.updateMany({
          where: {
            runId,
            id: { in: batch.map((job) => job.id) },
            state: "RUNNING",
            claimedBy: options.leaseOwner,
          },
          data: {
            state: "FAILED",
            error: "no translation returned",
            finishedAt: new Date(),
          },
        });

        const modelUnits = translated.length - memoryHits;
        const previous = await db.translationRun.findUniqueOrThrow({
          where: { id: runId },
          select: { rateUnitsPerMin: true },
        });
        const updated = await db.translationRun.updateMany({
          where: { id: runId, leaseOwner: options.leaseOwner },
          data: {
            // Not `translated.length`: a repair `storeRepairs` refused as superseded was returned
            // by the slice but never written, and counting it would report progress that is not
            // in the database.
            translatedUnits: { increment: translated.length - superseded.size },
            flaggedUnits: { increment: flagged },
            memoryHits: { increment: memoryHits },
            promptTokens: { increment: promptTokens },
            completionTokens: { increment: completionTokens },
            leaseExpiresAt: leaseUntil(),
            heartbeatAt: new Date(),
            // A batch served entirely from memory says nothing about how fast the model is.
            ...(modelUnits > 0
              ? {
                  rateUnitsPerMin: ewmaRate(
                    previous.rateUnitsPerMin,
                    batchRate(modelUnits, batchStarted, Date.now()),
                  ),
                  modelBatches: { increment: 1 },
                }
              : {}),
          },
        });
        if (updated.count === 0) lostLease = true;
        processed += batch.length;
      } catch (error) {
        if (options.signal?.aborted) {
          // A deploy is not the unit's fault: hand the batch back without charging an attempt.
          await db.translationJob.updateMany({
            where: {
              runId,
              id: { in: batch.map((job) => job.id) },
              state: "RUNNING",
              claimedBy: options.leaseOwner,
            },
            data: {
              state: "QUEUED",
              startedAt: null,
              claimedBy: null,
              attempts: { decrement: 1 },
            },
          });
          stopReason = "aborted";
          break;
        }
        // One bad batch must not end a run of three thousand. Record it and carry on.
        logger.error({ error, runId, entity }, "translation batch failed");
        await db.translationJob.updateMany({
          where: {
            runId,
            id: { in: batch.map((job) => job.id) },
            state: "RUNNING",
            claimedBy: options.leaseOwner,
          },
          data: {
            state: "FAILED",
            error:
              error instanceof Error ? error.message.slice(0, 300) : "unknown",
            finishedAt: new Date(),
          },
        });
        // No `failedUnits` here: this batch may well be retried. The counter is charged where a
        // job runs out of attempts — see `retireExhausted` — so a 5-unit batch that fails all
        // three times is 5 failed units, not the 15 the panel used to show against a plan of 5.
        const updated = await db.translationRun.updateMany({
          where: { id: runId, leaseOwner: options.leaseOwner },
          data: {
            leaseExpiresAt: leaseUntil(),
            heartbeatAt: new Date(),
          },
        });
        if (updated.count === 0) lostLease = true;
        processed += batch.length;
      }

      options.onProgress?.({ ...(await progressOf(db, runId)), stopReason });
    }
  } finally {
    clearInterval(keepalive);
  }

  // The loop retires exhausted jobs at the top of each pass, which the last failure of a run
  // never reaches: it stops on the budget, a pause, or an empty queue instead. Once more here, so
  // every terminal failure is SKIPPED and counted exactly once whatever ended the run.
  if (stopReason !== "lostLease")
    await retireExhausted(db, runId, options.leaseOwner);

  if (stopReason === "lostLease") {
    logger.warn(
      { runId, leaseOwner: options.leaseOwner },
      "lost the lease — leaving the run to its new owner",
    );
    return { ...(await progressOf(db, runId)), stopReason };
  }

  // Push approved question translations out to the variants students are served.
  if (translatedMasterIds.length > 0) {
    await deriveVariantTranslations(db, run.locale, translatedMasterIds);
  }
  await invalidateMessages(run.locale);

  const release = { leaseOwner: null, leaseExpiresAt: null };
  if (stopReason === "cancelled") {
    // Index: TranslationJob[runId, state, entity].
    await db.translationJob.updateMany({
      where: { runId, state: { in: ["QUEUED", "RUNNING"] } },
      data: { state: "SKIPPED", error: "cancelled", finishedAt: new Date() },
    });
    await db.translationRun.updateMany({
      where: { id: runId, leaseOwner: options.leaseOwner },
      data: {
        status: "CANCELLED",
        finishedAt: new Date(),
        cancelRequested: false,
        ...release,
      },
    });
    return { ...(await progressOf(db, runId)), stopReason };
  }

  // RUNNING counts too: a job this runner could not finish is not a finished run.
  // Index: TranslationJob[runId, state, entity].
  const remaining = await db.translationJob.count({
    where: { runId, state: { in: ["QUEUED", "RUNNING"] } },
  });
  if (remaining === 0) {
    await db.translationRun.updateMany({
      where: { id: runId, leaseOwner: options.leaseOwner },
      data: {
        status: "COMPLETED",
        finishedAt: new Date(),
        // Nothing left to pause; a stale flag would only confuse the run board.
        pauseRequested: false,
        ...release,
      },
    });
    // Only a whole-language pass may claim the language is in sync. A SINGLE_ENTITY slice, a
    // REPAIR or a SAMPLE finishing does not mean every unit is current.
    if (run.kind === "SYNC" || run.kind === "FULL") {
      await db.language.update({
        where: { code: run.locale },
        data: { lastSyncedAt: new Date() },
        select: { code: true },
      });
    }
    if (run.kind !== "SAMPLE") {
      await auditLog({
        actorId: null,
        action: AUDIT.translationRunFinished,
        entityType: "TranslationRun",
        entityId: runId,
        meta: { locale: run.locale, kind: run.kind },
      });
    }
    return { ...(await progressOf(db, runId)), stopReason: "finished" };
  }

  // `pauseRequested` is deliberately NOT cleared here: an admin's pause must outlive the runner
  // that honoured it, or the worker would re-claim the run on its very next tick. Only a resume
  // clears it. A bounded slice ending never set the flag in the first place.
  await db.translationRun.updateMany({
    where: { id: runId, leaseOwner: options.leaseOwner },
    data: { status: "PAUSED", ...release },
  });
  return { ...(await progressOf(db, runId)), stopReason };
}

interface SliceOutcome {
  translated: TranslatedUnit[];
  /** Units whose row was approved/edited/re-sourced while the batch ran; never overwritten. */
  superseded: Set<string>;
}

async function translateSlice(
  db: PrismaClient,
  locale: string,
  language: LanguagePolicy,
  units: TranslationUnit[],
  runId: string,
  signal: AbortSignal | undefined,
): Promise<SliceOutcome> {
  const translated = await translateBatch(
    db,
    language,
    units,
    signal ? { signal } : {},
  );
  await storeTranslations(db, locale, translated, runId);
  return { translated, superseded: new Set() };
}

/**
 * A REPAIR slice.
 *
 * Three things separate it from `translateSlice`, and all three are safety, not style:
 * `qaSampleRate: 1` — every repaired unit is QA'd whatever the language asks for, because repair
 * raises scrutiny and never lowers it; the context is read fresh so the prompt carries the finding
 * that is on the row right now; and `storeRepairs` writes conditionally, so a reviewer who
 * approved the row while this batch was in the model keeps their answer.
 */
async function repairSlice(
  db: PrismaClient,
  locale: string,
  language: LanguagePolicy,
  units: TranslationUnit[],
  runId: string,
  signal: AbortSignal | undefined,
): Promise<SliceOutcome> {
  if (units.length === 0) return { translated: [], superseded: new Set() };
  const context = await repairContextFor(
    db,
    locale,
    units[0].entity,
    units.map((unit) => unit.entityId),
  );
  const { translated, consumed } = await repairBatch(
    db,
    { ...language, qaSampleRate: 1 },
    units,
    context,
    signal ? { signal } : {},
  );
  const superseded = await storeRepairs(
    db,
    locale,
    translated,
    runId,
    consumed,
    language.glossaryVersion,
  );
  return { translated, superseded };
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
    ids,
  });
  const wanted = new Set(ids);
  // Defence in depth: every extractor filters on ids, but a future one that forgets would
  // silently widen a batch.
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
  // A job left RUNNING by a killed process is outstanding work, not finished work.
  // Index: TranslationJob[runId, state, entity].
  const remaining = await db.translationJob.count({
    where: { runId, state: { in: ["QUEUED", "RUNNING"] } },
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
    // A plain progress read has no stop of its own to report; every caller inside `executeRun`
    // spreads this and overrides it with the reason it actually stopped.
    stopReason: "finished",
  };
}
