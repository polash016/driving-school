import type { PrismaClient, TranslatableEntity } from "@prisma/client";
import { logger } from "@/lib/logger";
import { memoryHash, type UnitPayload } from "./units";

/**
 * Translation memory (spec-15) — a given source payload is translated once, ever.
 *
 * Keyed on the whole unit rather than on segments, deliberately. Segment-level reuse is how
 * "Right" gets substituted as "correct" into a question about turning right: the same words mean
 * different things in different questions, which is exactly why the unit is the unit.
 *
 * Where it pays: option texts and topic names repeat across a bank, a republished variant is
 * usually byte-identical to what it replaced, and a retire-and-replace that only changed a
 * citation leaves the text untouched. None of those should cost a second call.
 *
 * The glossary version is part of the key, so changing terminology correctly invalidates every
 * memory that used the old terms rather than quietly reusing them.
 */

export interface MemoryHit {
  value: UnitPayload;
  modelVersion: string | null;
  promptVersion: string | null;
}

/** Look up several units at once — one indexed read per batch, never per unit. */
export async function probeMemory(
  db: PrismaClient,
  locale: string,
  hashes: string[],
): Promise<Map<string, MemoryHit>> {
  if (hashes.length === 0) return new Map();
  const rows = await db.translationMemory.findMany({
    where: { locale, sourceHash: { in: hashes } },
    select: {
      sourceHash: true,
      value: true,
      modelVersion: true,
      promptVersion: true,
    },
  });
  return new Map(
    rows.map((row) => [
      row.sourceHash,
      {
        value: row.value as unknown as UnitPayload,
        modelVersion: row.modelVersion,
        promptVersion: row.promptVersion,
      },
    ]),
  );
}

export interface RememberInput {
  locale: string;
  entity: TranslatableEntity;
  source: UnitPayload;
  value: UnitPayload;
  glossaryVersion: number;
  modelVersion?: string | null;
  promptVersion?: string | null;
}

/**
 * Record a batch of translations for reuse.
 *
 * One array transaction rather than a write per unit: the runner will soon run several batches
 * concurrently, and a write per unit holds a connection per unit. The cost is that a failure loses
 * the whole batch's memory rows — acceptable, because a lost memory row costs a few tokens next
 * time and nothing else.
 *
 * Non-throwing, for the same reason as the singular: losing a memory entry must never fail the run
 * that produced it.
 */
export async function rememberTranslations(
  db: PrismaClient,
  inputs: RememberInput[],
): Promise<void> {
  if (inputs.length === 0) return;
  try {
    await db.$transaction(
      inputs.map((input) => {
        const hash = memoryHash(
          input.entity,
          input.source,
          input.glossaryVersion,
        );
        return db.translationMemory.upsert({
          where: {
            locale_sourceHash: { locale: input.locale, sourceHash: hash },
          },
          create: {
            locale: input.locale,
            sourceHash: hash,
            contextKind: input.entity,
            value: input.value as object,
            glossaryVersion: input.glossaryVersion,
            modelVersion: input.modelVersion ?? null,
            promptVersion: input.promptVersion ?? null,
            lastUsedAt: new Date(),
          },
          update: { value: input.value as object, lastUsedAt: new Date() },
          select: { id: true },
        });
      }),
    );
  } catch (error) {
    logger.warn(
      { error, locale: inputs[0].locale, count: inputs.length },
      "translation memory batch write failed",
    );
  }
}

/**
 * Record one translation for reuse.
 *
 * Kept for the single-unit callers (review, repair); the plural does the work, so the two can
 * never drift apart.
 */
export async function rememberTranslation(
  db: PrismaClient,
  input: RememberInput,
): Promise<void> {
  await rememberTranslations(db, [input]);
}

/** Count a reuse, so an admin can see how much the memory is actually saving. */
export async function countMemoryHits(
  db: PrismaClient,
  locale: string,
  hashes: string[],
): Promise<void> {
  if (hashes.length === 0) return;
  try {
    await db.translationMemory.updateMany({
      where: { locale, sourceHash: { in: hashes } },
      data: { hits: { increment: 1 }, lastUsedAt: new Date() },
    });
  } catch (error) {
    logger.warn({ error, locale }, "translation memory hit counter failed");
  }
}
