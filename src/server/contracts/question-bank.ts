import { z } from "zod";
import { idSchema, paginationInputSchema } from "./common";
import {
  itemStatusSchema,
  itemTypeSchema,
  legalCitationSchema,
  localizedQuestionSchema,
  masterItemSchema,
} from "./models";

/** Question-bank CRUD & review workflow contracts (spec-04). */

export const listItemsInputSchema = paginationInputSchema
  .extend({
    topicSlug: z.string().optional(),
    status: itemStatusSchema.optional(),
    type: itemTypeSchema.optional(),
    difficulty: z.int().min(1).max(5).optional(),
    search: z.string().max(200).optional(),
    languageIncomplete: z.boolean().optional(),
    /**
     * Items this reviewer can still act on: in review, not already signed off by them, and not
     * their own human-authored work. This is the queue bulk review works from.
     */
    awaitingMyReview: z.boolean().optional(),
  })
  .strict();

const editableContentSchema = z.object({
  en: localizedQuestionSchema.extend({ explanation: z.string().min(1) }),
  nb: localizedQuestionSchema.extend({ explanation: z.string().min(1) }),
});

export const upsertItemInputSchema = z
  .object({
    id: idSchema.optional(), // absent = create; editing APPROVED bumps version (spec-04)
    type: itemTypeSchema,
    topicId: idSchema,
    licenseClassId: idSchema.nullable(),
    difficulty: z.int().min(1).max(5),
    content: editableContentSchema,
    correctOptionKey: z.string().min(1).max(8),
    legalCitations: z.array(legalCitationSchema).min(0),
    /**
     * Nullable, not merely optional: switching a question back to TEXT must be able to say "no
     * picture" explicitly. Omitting the field would leave the old link in place, and the exam
     * screen would go on rendering an image the author had just removed.
     */
    sourceImageId: idSchema.nullish(),
  })
  .strict()
  .superRefine((item, ctx) => {
    // An image or sign question without a picture is not answerable. Caught here rather than at
    // the quality gate so an author sees it while editing, not on the way to review.
    if (item.type !== "TEXT" && !item.sourceImageId) {
      ctx.addIssue({
        code: "custom",
        path: ["sourceImageId"],
        message: "admin.questions.errors.imageRequired",
      });
    }
    for (const locale of ["en", "nb"] as const) {
      const keys = item.content[locale].options.map((o) => o.key);
      if (new Set(keys).size !== keys.length) {
        ctx.addIssue({
          code: "custom",
          message: `${locale}: duplicate option keys`,
        });
      }
      if (!keys.includes(item.correctOptionKey)) {
        ctx.addIssue({
          code: "custom",
          message: `${locale}: correctOptionKey not among options`,
        });
      }
    }
    const enKeys = item.content.en.options.map((o) => o.key).join(",");
    const nbKeys = item.content.nb.options.map((o) => o.key).join(",");
    if (enKeys !== nbKeys) {
      ctx.addIssue({
        code: "custom",
        message: "option keys differ across locales",
      });
    }
  });

/** Lifecycle transitions — legality (DRAFT→IN_REVIEW→APPROVED→RETIRED, NEEDS_REVIEW loops) enforced server-side. */
export const transitionItemInputSchema = z
  .object({
    id: idSchema,
    to: itemStatusSchema,
    reason: z.string().max(1000).optional(), // structured reason code, required for rejections (service-enforced)
    /// Optional free text from the reviewer — quoted back to the AI as a lesson (spec-05 amendment).
    note: z.string().max(1000).optional(),
  })
  .strict();

export const bulkActionInputSchema = z
  .object({
    ids: z.array(idSchema).min(1).max(200),
    action: z.enum(["APPROVE", "RETIRE", "RETAG"]),
    topicId: idSchema.optional(), // for RETAG
  })
  .strict();

export const itemListRowSchema = masterItemSchema
  .pick({
    id: true,
    type: true,
    status: true,
    topicId: true,
    difficulty: true,
    version: true,
    createdBy: true,
  })
  .extend({
    stemPreview: z.string(),
    updatedAt: z.date(),
  });

// ── Sets, curation and accuracy (spec-04 amendment) ─────────────────────────

export const rejectionReasonSchema = z.enum([
  "WRONG_ANSWER",
  "AMBIGUOUS_DISTRACTOR",
  "CITATION_MISMATCH",
  "DUPLICATE",
  "LANGUAGE_QUALITY",
  "IMAGE_MISMATCH",
  "OUT_OF_SCOPE",
  "OTHER",
]);
export type RejectionReasonValue = z.infer<typeof rejectionReasonSchema>;

export const batchKindSchema = z.enum(["IMAGE", "THEORY", "MANUAL"]);
export const batchStatusSchema = z.enum([
  "PENDING",
  "RUNNING",
  "READY",
  "FAILED",
]);

export const listBatchesInputSchema = paginationInputSchema
  .extend({
    kind: batchKindSchema.optional(),
    status: batchStatusSchema.optional(),
  })
  .strict();

/** Per-status item counts of one set — the shape both the board and the detail header render. */
export const batchCountsSchema = z
  .object({
    total: z.int().min(0),
    draft: z.int().min(0),
    inReview: z.int().min(0),
    approved: z.int().min(0),
    retired: z.int().min(0),
    needsReview: z.int().min(0),
  })
  .strict();

export const batchSummarySchema = z
  .object({
    id: idSchema,
    kind: batchKindSchema,
    status: batchStatusSchema,
    sourceImageId: idSchema.nullable(),
    topicId: idSchema.nullable(),
    requestedCount: z.int().min(0),
    modelVersion: z.string().nullable(),
    promptVersion: z.string().nullable(),
    notes: z.string().nullable(),
    createdAt: z.date(),
    counts: batchCountsSchema,
    /** approved / (approved + retired); null until at least one item reached a terminal state. */
    acceptanceRate: z.number().min(0).max(1).nullable(),
  })
  .strict();

export const batchItemSchema = z
  .object({
    id: idSchema,
    status: itemStatusSchema,
    type: itemTypeSchema,
    difficulty: z.int().min(1).max(5),
    version: z.int().positive(),
    stemPreview: z.string(),
    createdBy: z.enum(["AI", "HUMAN"]),
    modelVersion: z.string().nullable(),
    promptVersion: z.string().nullable(),
    reviewReason: rejectionReasonSchema.nullable(),
    reviewNote: z.string().nullable(),
    updatedAt: z.date(),
  })
  .strict();

export const batchDetailSchema = batchSummarySchema
  .extend({ items: z.array(batchItemSchema) })
  .strict();

export const attachItemsToBatchInputSchema = z
  .object({ batchId: idSchema, itemIds: z.array(idSchema).min(1).max(200) })
  .strict();

export const detachItemInputSchema = z.object({ itemId: idSchema }).strict();

export const createBatchInputSchema = z
  .object({
    kind: batchKindSchema.default("MANUAL"),
    topicId: idSchema.optional(),
    sourceImageId: idSchema.optional(),
    requestedCount: z.int().min(1).max(50).default(5),
    notes: z.string().max(500).optional(),
  })
  .strict();

export const accuracyStatsInputSchema = z
  .object({
    groupBy: z.enum(["model", "prompt", "topic"]).default("model"),
    sinceDays: z.int().min(1).max(365).default(90),
  })
  .strict();

export const accuracyRowSchema = z
  .object({
    key: z.string(), // model id, prompt version, or topic slug
    label: z.string(),
    reviewed: z.int().min(0),
    approved: z.int().min(0),
    rate: z.number().min(0).max(1),
    medianHoursToReview: z.number().min(0).nullable(),
  })
  .strict();

export const accuracyStatsSchema = z
  .object({
    groupBy: z.enum(["model", "prompt", "topic"]),
    sinceDays: z.int().min(1),
    /** AI-authored items only — human-authored items have no acceptance rate to measure. */
    rows: z.array(accuracyRowSchema),
    reasons: z.array(
      z
        .object({ reason: rejectionReasonSchema, count: z.int().min(0) })
        .strict(),
    ),
    totals: batchCountsSchema,
  })
  .strict();

/** Result of publishing (spec-04 D1): approval materialises servable variants. */
export const publishResultSchema = z
  .object({
    itemId: idSchema,
    variantsCreated: z.int().min(0),
    variantsReused: z.int().min(0),
    warnings: z.array(z.string()),
  })
  .strict();

/** Lossless interchange shape — JSON export and CSV columns both derive from it. */
export const itemExportSchema = z
  .object({
    topicSlug: z.string().min(1),
    type: itemTypeSchema,
    status: itemStatusSchema,
    difficulty: z.int().min(1).max(5),
    licenseClassCode: z.string().nullable(),
    // Export tolerates an incomplete DRAFT (no answer key yet, no explanation written): the
    // point is to get content out. Import re-validates through `upsertItemInputSchema`, so an
    // incomplete row comes back as a per-row failure rather than a silently broken question.
    correctOptionKey: z.string(),
    content: z.object({
      en: localizedQuestionSchema.extend({
        explanation: z.string().default(""),
      }),
      nb: localizedQuestionSchema.extend({
        explanation: z.string().default(""),
      }),
    }),
    legalCitations: z.array(legalCitationSchema),
  })
  .strict();
export type ItemExport = z.infer<typeof itemExportSchema>;

export const importResultRowSchema = z
  .object({
    row: z.int().min(1),
    stem: z.string(),
    status: z.enum(["imported", "skipped", "invalid"]),
    messageKey: z.string(),
  })
  .strict();

export const importResultSchema = z
  .object({
    imported: z.int().min(0),
    skipped: z.int().min(0),
    rows: z.array(importResultRowSchema),
  })
  .strict();

export type ListItemsInput = z.infer<typeof listItemsInputSchema>;
export type UpsertItemInput = z.infer<typeof upsertItemInputSchema>;
export type ItemListRow = z.infer<typeof itemListRowSchema>;
export type BatchSummary = z.infer<typeof batchSummarySchema>;
export type BatchDetail = z.infer<typeof batchDetailSchema>;
export type BatchItem = z.infer<typeof batchItemSchema>;
export type AccuracyStats = z.infer<typeof accuracyStatsSchema>;
export type PublishResult = z.infer<typeof publishResultSchema>;
export type ImportResult = z.infer<typeof importResultSchema>;
