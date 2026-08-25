import type { Prisma, PrismaClient } from "@prisma/client";
import { ValidationError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import {
  publishResultSchema,
  type PublishResult,
} from "@/server/contracts/question-bank";
import { computeContentHash } from "@/server/services/quiz/content-hash";
import {
  expandTemplate,
  parameterSlotsSchema,
  type TemplateContent,
} from "@/server/services/quiz/template";

/**
 * Publishing (spec-04 D1) — THE link between the question bank and the quiz engine.
 *
 * `PrismaVariantSource` serves APPROVED master items **joined to active ItemVariants**, so an
 * approved item with no variant is invisible to students. Approval therefore materialises
 * variants here: one mirroring the master for a plain item, one per expansion for a templated
 * one. Retiring deactivates them instead of deleting: attempts already served keep rendering
 * their own immutable snapshot.
 *
 * Idempotent — `ItemVariant.contentHash` is unique, so re-approving reuses what exists.
 */

type Db = PrismaClient | Prisma.TransactionClient;

interface PublishableItem {
  id: string;
  version: number;
  content: unknown;
  correctOptionKey: string | null;
  legalCitations: unknown;
  parameterSlots: unknown;
  modelVersion: string | null;
  promptVersion: string | null;
}

/** Master content as the template engine wants it, with both explanations required. */
function templateContent(item: PublishableItem): TemplateContent {
  const content = item.content as TemplateContent;
  for (const locale of ["en", "nb"] as const) {
    const side = content?.[locale];
    if (!side?.stem || !Array.isArray(side.options) || side.options.length < 2) {
      throw new ValidationError(
        { itemId: item.id, locale },
        "admin.questions.errors.contentIncomplete",
      );
    }
  }
  return content;
}

export async function publishItem(
  db: Db,
  itemId: string,
  facts: Record<string, string> = {},
): Promise<PublishResult> {
  const item = (await db.masterItem.findUniqueOrThrow({
    where: { id: itemId },
    select: {
      id: true,
      version: true,
      content: true,
      correctOptionKey: true,
      legalCitations: true,
      parameterSlots: true,
      modelVersion: true,
      promptVersion: true,
    },
  })) as PublishableItem;

  if (!item.correctOptionKey) {
    throw new ValidationError(
      { itemId },
      "admin.questions.errors.answerKeyMissing",
    );
  }

  const content = templateContent(item);
  const optionKeys = content.en.options.map((option) => option.key);
  if (!optionKeys.includes(item.correctOptionKey)) {
    throw new ValidationError(
      { itemId, correctOptionKey: item.correctOptionKey },
      "admin.questions.errors.answerKeyUnknown",
    );
  }

  // With no parameterSlots the engine yields exactly one variant mirroring the master, so the
  // plain and templated cases share a single code path (and the same expansion validators).
  const expansion = expandTemplate({
    template: content,
    parameterSlots: item.parameterSlots
      ? parameterSlotsSchema.parse(item.parameterSlots)
      : null,
    facts,
  });
  const warnings = expansion.issues.map((issue) => issue.reason);

  if (expansion.variants.length === 0) {
    throw new ValidationError(
      { itemId, issues: warnings },
      "admin.questions.errors.expansionFailed",
    );
  }

  let created = 0;
  let reused = 0;

  for (const variant of expansion.variants) {
    const contentHash = computeContentHash(item.id, variant.content);
    const existing = await db.itemVariant.findUnique({
      where: { contentHash },
      select: { id: true, isActive: true },
    });

    if (existing) {
      // Re-approving an item revives the variants it published before.
      if (!existing.isActive) {
        await db.itemVariant.update({
          where: { id: existing.id },
          data: { isActive: true },
          select: { id: true },
        });
      }
      reused++;
      continue;
    }

    await db.itemVariant.create({
      data: {
        masterItemId: item.id,
        masterVersion: item.version,
        contentHash,
        content: variant.content as unknown as Prisma.InputJsonValue,
        correctOptionKey: item.correctOptionKey,
        explanation: {
          en: variant.explanation.en,
          nb: variant.explanation.nb,
          citations: (item.legalCitations ?? []) as unknown,
        } as unknown as Prisma.InputJsonValue,
        source: "TEMPLATE",
        modelVersion: item.modelVersion,
        promptVersion: item.promptVersion,
        isActive: true,
      },
      select: { id: true },
    });
    created++;
  }

  logger.info({ itemId, created, reused, warnings }, "item published");
  return publishResultSchema.parse({
    itemId,
    variantsCreated: created,
    variantsReused: reused,
    warnings,
  });
}

/**
 * Retiring stops the engine serving an item without touching history: variants go inactive,
 * attempts keep their snapshot (ExamAttemptQuestion references the variant row directly).
 */
export async function unpublishItem(db: Db, itemId: string): Promise<number> {
  const result = await db.itemVariant.updateMany({
    where: { masterItemId: itemId, isActive: true },
    data: { isActive: false },
  });
  logger.info({ itemId, deactivated: result.count }, "item unpublished");
  return result.count;
}
