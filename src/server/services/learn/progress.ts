import type { PrismaClient } from "@prisma/client";
import { readingProgressInputSchema } from "@/server/contracts/learn";

/**
 * Reading progress (spec-23 C4). One row per (user, document): the furthest position reached,
 * and a `readAt` that is set once and never cleared — re-opening a chapter you finished is not
 * un-reading it.
 */
export function createProgressService(db: PrismaClient) {
  async function recordProgress(
    userId: string,
    rawInput: unknown,
    now: Date = new Date(),
  ): Promise<{ readAt: Date | null; positionPct: number }> {
    const input = readingProgressInputSchema.parse(rawInput);
    const doc = await db.learnDocument.findFirst({
      where: { id: input.documentId, deletedAt: null, status: "PUBLISHED" },
      select: { version: true },
    });
    if (!doc) return { readAt: null, positionPct: 0 };

    // PK read: LearnReadingProgress(userId, documentId).
    const existing = await db.learnReadingProgress.findUnique({
      where: { userId_documentId: { userId, documentId: input.documentId } },
      select: { positionPct: true, readAt: true },
    });
    const positionPct = Math.max(existing?.positionPct ?? 0, input.positionPct);
    const finished = input.markRead || positionPct >= READ_AT_PCT;
    const readAt = existing?.readAt ?? (finished ? now : null);

    const row = await db.learnReadingProgress.upsert({
      where: { userId_documentId: { userId, documentId: input.documentId } },
      create: {
        userId,
        documentId: input.documentId,
        positionPct,
        readAt,
        readVersion: readAt ? doc.version : null,
        lastOpenedAt: now,
      },
      update: {
        positionPct,
        lastOpenedAt: now,
        ...(readAt && !existing?.readAt ? { readAt, readVersion: doc.version } : {}),
      },
      select: { readAt: true, positionPct: true },
    });
    return row;
  }

  /** The reader page opened: remember it for "Continue reading", without touching the position. */
  async function touchOpened(userId: string, documentId: string, now: Date = new Date()): Promise<void> {
    await db.learnReadingProgress.upsert({
      where: { userId_documentId: { userId, documentId } },
      create: { userId, documentId, lastOpenedAt: now },
      update: { lastOpenedAt: now },
      select: { userId: true },
    });
  }

  return { recordProgress, touchOpened };
}

/** Reaching this far counts as having read the document, even without pressing the button. */
export const READ_AT_PCT = 95;

export type ProgressService = ReturnType<typeof createProgressService>;
