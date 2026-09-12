import type { Prisma, PrismaClient } from "@prisma/client";
import { logger } from "@/lib/logger";
import { extractAll, pendingUnits } from "./extract";
import { planRun, type RunPlan } from "./runs";

/**
 * A language that keeps itself translated (spec-20).
 *
 * Adding a language used to create a row and nothing else, and approving a question afterwards
 * left it English in every added language until somebody remembered to start a sync. Now every
 * write to translatable source content leaves a stamp on each language that opted in
 * (`Language.autoTranslate`), and the worker, when it has nothing enqueued, turns a stamp into a
 * SYNC run — which plans only what is missing or stale, so nothing already translated is paid for
 * twice.
 *
 * The stamp is compared against the latest sync run's PLAN time, not its finish time. A run
 * extracts its units when it is planned; an approval that lands while it executes is not in it,
 * and would be lost if "synced at" meant "finished at".
 *
 * A run that FAILED still counts as "planned since the stamp": re-planning behind a failure is
 * the tight loop spec-19 refuses to enter. The failure mails an admin, and the next content change
 * — or the admin's own click — plans the next run.
 */

type Db = PrismaClient | Prisma.TransactionClient;

const LIVE_KINDS = ["FULL", "SYNC", "SINGLE_ENTITY", "REPAIR"] as const;

/** Leave the stamp on every language that keeps itself translated — or on one. */
export async function requestTranslationSync(
  db: Db,
  options: { locale?: string } = {},
): Promise<number> {
  // No index: the language table holds a handful of rows.
  const result = await db.language.updateMany({
    where: {
      isBuiltIn: false,
      autoTranslate: true,
      ...(options.locale ? { code: options.locale } : {}),
    },
    data: { syncRequestedAt: new Date() },
  });
  return result.count;
}

/**
 * Plan an enqueued SYNC for what this language is missing, or clear its stamp if nothing is.
 *
 * Extracts before planning so an empty sync never becomes a run row, a claim, a "finished" mail
 * and an audit entry about nothing.
 */
export async function planSyncIfPending(
  db: PrismaClient,
  locale: string,
): Promise<RunPlan | null> {
  const language = await db.language.findUniqueOrThrow({
    where: { code: locale },
    select: { glossaryVersion: true, isBuiltIn: true },
  });
  if (language.isBuiltIn) return null;

  const units = await extractAll(db, {
    glossaryVersion: language.glossaryVersion,
  });
  const pending = await pendingUnits(db, locale, units);
  if (pending.length === 0) {
    await db.language.update({
      where: { code: locale },
      data: { syncRequestedAt: null },
      select: { code: true },
    });
    return null;
  }
  return planRun(db, locale, {
    kind: "SYNC",
    startedById: null,
    enqueue: true,
  });
}

/**
 * What the idle worker calls: every stamped language with no live run and a stamp newer than its
 * last sync plan gets a SYNC. Returns the run ids planned, so the tick can look again at once.
 */
export async function planAutoSyncs(db: PrismaClient): Promise<string[]> {
  // No index: the language table holds a handful of rows.
  const candidates = await db.language.findMany({
    where: {
      isBuiltIn: false,
      autoTranslate: true,
      syncRequestedAt: { not: null },
    },
    select: { code: true, syncRequestedAt: true },
  });

  const planned: string[] = [];
  for (const language of candidates) {
    // Index: TranslationRun[locale, status, createdAt].
    const live = await db.translationRun.findFirst({
      where: {
        locale: language.code,
        enqueuedAt: { not: null },
        status: { in: ["PENDING", "RUNNING", "PAUSED"] },
        kind: { in: [...LIVE_KINDS] },
      },
      select: { id: true },
    });
    if (live) continue;

    // Index: TranslationRun[locale, status, createdAt] — locale leads; the sort is on createdAt.
    const latest = await db.translationRun.findFirst({
      where: { locale: language.code, kind: { in: ["SYNC", "FULL"] } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (
      latest &&
      language.syncRequestedAt !== null &&
      language.syncRequestedAt <= latest.createdAt
    )
      continue;

    try {
      const plan = await planSyncIfPending(db, language.code);
      if (plan) planned.push(plan.runId);
    } catch (error) {
      // One language's planner failing must not stop the others, or the tick.
      logger.error(
        { error, locale: language.code },
        "automatic sync could not be planned",
      );
    }
  }
  return planned;
}
