import { Prisma, type PrismaClient, type TranslationStatus } from "@prisma/client";
import { createHash } from "node:crypto";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { publishItem, unpublishItem } from "./publish";
import { invalidateAccuracyStats } from "./stats";

/**
 * The ONE place that rewrites an approved question in place (spec-22).
 *
 * ## Why this file exists at all
 *
 * `upsertItem` refuses an APPROVED item (`approvedIsFrozen`) and `replaceItem` retires the original
 * immediately. Running `replaceItem` over ~722 questions would empty the approved pool and break
 * every `TaskSetMember` that points at one, so the campaign needs a third path — and exactly one,
 * because this is the only code permitted to open the database's freeze exception.
 *
 * ## The GUC
 *
 * `SET LOCAL teoripro.inplace_rewrite = 'on'` is what the amended `tp_approved_item_frozen` trigger
 * looks for. `SET LOCAL` is transaction-scoped and reverts on COMMIT *and* on ROLLBACK, so it can
 * never leak to another statement or connection. Even with it set, the trigger still refuses any
 * change to the answer key, the citations, the topic, the difficulty or the type — so the one thing
 * that must never move is guarded by Postgres, not merely by the checks upstream of here.
 *
 * Nothing else in this codebase may set that GUC. `rewrite.guc.test.ts` greps for it.
 *
 * ## Why this is safe for students who already sat the question
 *
 * `unpublishItem` only sets `isActive = false`; `ExamAttemptQuestion` references its `ItemVariant`
 * row directly, and that row's content is immutable by DB trigger. A sat paper therefore still
 * renders the exact text the student saw, and a student mid-attempt keeps the old text to the end.
 */

/** A translation, as it must look to be written at swap time. */
export interface RewriteTranslation {
  locale: string;
  value: Prisma.InputJsonValue;
  status: TranslationStatus;
  sourceHash: string;
  qaFlags?: string[];
  modelVersion?: string | null;
  promptVersion?: string | null;
  providerLabel?: string | null;
}

export interface RewriteInput {
  itemId: string;
  newContent: Prisma.InputJsonValue;
  /** Refuse unless the item is still at this version. */
  expectedVersion: number;
  /** Refuse unless the item's current content still hashes to this. */
  expectedFingerprint: string;
  /**
   * The translations to install in the SAME transaction as the content.
   *
   * This is the whole no-gap design. `Translation` is unique on (locale, entity, entityId), so
   * there is no way to stage tomorrow's Bangla beside today's — and `loadOverlay` picks a
   * translation by status alone, never comparing `sourceHash`, so a rewrite that left the old row
   * in place would serve the OLD Bangla over the NEW English, merged by option key. For a sign
   * question, where an option's text is another sign's meaning, that can turn a wrong option into
   * a defensible one.
   *
   * Passing every locale here means no student ever reads a stale pairing, and no student falls
   * back to English either.
   */
  translations: RewriteTranslation[];
  runId: string;
  actorId: string;
  /** Recomputed by the caller from the new content; the old vector is wrong the moment text moves. */
  stemEmbedding?: number[] | null;
}

/** Canonical fingerprint of an item's content, for optimistic concurrency. */
export function contentFingerprint(content: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(content ?? null))
    .digest("hex");
}

export interface RewriteResult {
  itemId: string;
  versionFrom: number;
  versionTo: number;
  variantsCreated: number;
  variantsReused: number;
  translationsWritten: number;
}

export async function rewriteApprovedItemInPlace(
  db: PrismaClient,
  input: RewriteInput,
): Promise<RewriteResult> {
  return db.$transaction(async (tx) => {
    // Opens the exception for THIS transaction only.
    await tx.$executeRawUnsafe(`SET LOCAL teoripro.inplace_rewrite = 'on'`);

    // Lock the row, then check it is still what was proposed and reviewed. This is what makes
    // "propose against a prod restore on Monday, apply on Friday" safe: anything that touched the
    // item in between refuses the swap instead of silently overwriting it.
    const locked = await tx.$queryRaw<
      Array<{ id: string; version: number; content: unknown; status: string }>
    >`SELECT "id", "version", "content", "status"::text
        FROM "MasterItem"
       WHERE "id" = ${input.itemId} AND "deletedAt" IS NULL
         FOR UPDATE`;
    const item = locked[0];
    if (!item) throw new NotFoundError({ itemId: input.itemId });

    if (item.version !== input.expectedVersion) {
      throw new ConflictError(
        {
          itemId: input.itemId,
          expectedVersion: input.expectedVersion,
          actualVersion: item.version,
        },
        "admin.questions.errors.rewriteStale",
      );
    }
    if (contentFingerprint(item.content) !== input.expectedFingerprint) {
      throw new ConflictError(
        { itemId: input.itemId },
        "admin.questions.errors.rewriteStale",
      );
    }

    // Deactivate first: from this instant no new attempt can be assembled onto the old text, while
    // in-flight attempts keep rendering it from their own variant row.
    await unpublishItem(tx as unknown as PrismaClient, input.itemId);

    await tx.masterItem.update({
      where: { id: input.itemId },
      data: {
        content: input.newContent,
        version: item.version + 1,
      },
      select: { id: true },
    });

    // New content hashes to a new contentHash, so this creates a new ItemVariant at the new
    // master version. It also stamps every auto-translating language for a sync.
    const published = await publishItem(
      tx as unknown as PrismaClient,
      input.itemId,
    );

    // Snapshot every translation this item currently has, BEFORE the upserts below overwrite
    // them. Without this the old Bangla/Spanish text is simply gone: `previousContent` covers only
    // the en/nb master, so a rollback would restore the old English and leave the NEW short
    // translations attached to it — which is precisely the stale pairing this whole design exists
    // to prevent, reintroduced by an incomplete undo.
    const previousTranslations = await tx.translation.findMany({
      where: { entity: "MASTER_ITEM", entityId: input.itemId },
      select: {
        locale: true,
        value: true,
        status: true,
        sourceHash: true,
        qaFlags: true,
        modelVersion: true,
        promptVersion: true,
        providerLabel: true,
      },
    });

    // The translations land with the content, never after it.
    for (const translation of input.translations) {
      await tx.translation.upsert({
        where: {
          locale_entity_entityId: {
            locale: translation.locale,
            entity: "MASTER_ITEM",
            entityId: input.itemId,
          },
        },
        create: {
          locale: translation.locale,
          entity: "MASTER_ITEM",
          entityId: input.itemId,
          value: translation.value,
          status: translation.status,
          sourceHash: translation.sourceHash,
          qaFlags: translation.qaFlags ?? [],
          modelVersion: translation.modelVersion ?? null,
          promptVersion: translation.promptVersion ?? null,
          providerLabel: translation.providerLabel ?? null,
        },
        update: {
          value: translation.value,
          status: translation.status,
          sourceHash: translation.sourceHash,
          qaFlags: translation.qaFlags ?? [],
          modelVersion: translation.modelVersion ?? null,
          promptVersion: translation.promptVersion ?? null,
          providerLabel: translation.providerLabel ?? null,
          // A fresh budget: this is new text, not another attempt at the old text.
          repairAttempts: 0,
        },
        select: { id: true },
      });
    }

    // The old embedding describes text that no longer exists. Writing the new one is better than
    // nulling it, because a null silently mis-classifies until a backfill runs.
    if (input.stemEmbedding && input.stemEmbedding.length > 0) {
      const vector = `[${input.stemEmbedding.join(",")}]`;
      await tx.$executeRaw`UPDATE "MasterItem"
                              SET "stemEmbedding" = ${vector}::vector
                            WHERE "id" = ${input.itemId}`;
    } else {
      await tx.$executeRaw`UPDATE "MasterItem"
                              SET "stemEmbedding" = NULL
                            WHERE "id" = ${input.itemId}`;
    }

    // Written with `create`, not the fire-and-forget `auditLog` helper, which swallows its own
    // errors by design. Here the audit row IS the rollback record, so a failure to write it must
    // take the transaction down rather than leave an unreversible change behind.
    await tx.auditLog.create({
      data: {
        actorId: input.actorId,
        action: "item.simplified",
        entityType: "MasterItem",
        entityId: input.itemId,
        meta: {
          runId: input.runId,
          versionFrom: item.version,
          versionTo: item.version + 1,
          previousContent: item.content as Prisma.InputJsonValue,
          previousTranslations: previousTranslations as unknown as Prisma.InputJsonValue,
          locales: input.translations.map((t) => t.locale),
        } as Prisma.InputJsonValue,
      },
      select: { id: true },
    });

    logger.info(
      {
        itemId: input.itemId,
        versionTo: item.version + 1,
        locales: input.translations.length,
      },
      "approved item rewritten in place",
    );

    return {
      itemId: input.itemId,
      versionFrom: item.version,
      versionTo: item.version + 1,
      variantsCreated: published.variantsCreated,
      variantsReused: published.variantsReused,
      translationsWritten: input.translations.length,
    };
  });
}

/**
 * Put an item back exactly as it was, from its audit row.
 *
 * Restores the version NUMBER as well as the content, which is what makes this exact rather than
 * approximate: at the old version the original `ItemApproval` rows are valid again, and because the
 * restored content hashes to the original `contentHash`, `publishItem` REVIVES the original variant
 * row instead of creating a third one. The student-facing history stays a straight line.
 */
export async function rollbackRewrite(
  db: PrismaClient,
  input: {
    itemId: string;
    previousContent: Prisma.InputJsonValue;
    versionFrom: number;
    translations: RewriteTranslation[];
    actorId: string;
    runId: string;
  },
): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL teoripro.inplace_rewrite = 'on'`);

    await unpublishItem(tx as unknown as PrismaClient, input.itemId);
    await tx.masterItem.update({
      where: { id: input.itemId },
      data: { content: input.previousContent, version: input.versionFrom },
      select: { id: true },
    });
    await publishItem(tx as unknown as PrismaClient, input.itemId);

    // Put the translations back exactly as they were, and REMOVE any locale that had no
    // translation before the rewrite — otherwise a language the campaign newly translated would be
    // left holding short text for a question that is long again.
    const restoredLocales = input.translations.map((t) => t.locale);
    await tx.translation.deleteMany({
      where: {
        entity: "MASTER_ITEM",
        entityId: input.itemId,
        ...(restoredLocales.length > 0
          ? { locale: { notIn: restoredLocales } }
          : {}),
      },
    });

    for (const translation of input.translations) {
      await tx.translation.upsert({
        where: {
          locale_entity_entityId: {
            locale: translation.locale,
            entity: "MASTER_ITEM",
            entityId: input.itemId,
          },
        },
        create: {
          locale: translation.locale,
          entity: "MASTER_ITEM",
          entityId: input.itemId,
          value: translation.value,
          status: translation.status,
          sourceHash: translation.sourceHash,
          qaFlags: translation.qaFlags ?? [],
          modelVersion: translation.modelVersion ?? null,
          promptVersion: translation.promptVersion ?? null,
          providerLabel: translation.providerLabel ?? null,
        },
        update: {
          value: translation.value,
          status: translation.status,
          sourceHash: translation.sourceHash,
          qaFlags: translation.qaFlags ?? [],
          modelVersion: translation.modelVersion ?? null,
          promptVersion: translation.promptVersion ?? null,
          providerLabel: translation.providerLabel ?? null,
        },
        select: { id: true },
      });
    }

    await tx.auditLog.create({
      data: {
        actorId: input.actorId,
        action: "item.rewrite_rolled_back",
        entityType: "MasterItem",
        entityId: input.itemId,
        meta: {
          runId: input.runId,
          restoredToVersion: input.versionFrom,
        } as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
  });

  await invalidateAccuracyStats();
  logger.info({ itemId: input.itemId }, "rewrite rolled back");
}
