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
    sourceImageId: idSchema.optional(),
  })
  .strict()
  .superRefine((item, ctx) => {
    for (const locale of ["en", "nb"] as const) {
      const keys = item.content[locale].options.map((o) => o.key);
      if (new Set(keys).size !== keys.length) {
        ctx.addIssue({ code: "custom", message: `${locale}: duplicate option keys` });
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
      ctx.addIssue({ code: "custom", message: "option keys differ across locales" });
    }
  });

/** Lifecycle transitions — legality (DRAFT→IN_REVIEW→APPROVED→RETIRED, NEEDS_REVIEW loops) enforced server-side. */
export const transitionItemInputSchema = z
  .object({
    id: idSchema,
    to: itemStatusSchema,
    reason: z.string().max(1000).optional(), // required for rejections (service-enforced)
  })
  .strict();

export const bulkActionInputSchema = z
  .object({
    ids: z.array(idSchema).min(1).max(200),
    action: z.enum(["APPROVE", "RETIRE", "RETAG"]),
    topicId: idSchema.optional(), // for RETAG
  })
  .strict();

export const itemListRowSchema = masterItemSchema.pick({
  id: true,
  type: true,
  status: true,
  topicId: true,
  difficulty: true,
  version: true,
  createdBy: true,
}).extend({
  stemPreview: z.string(),
  updatedAt: z.date(),
});
