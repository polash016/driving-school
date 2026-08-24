import { z } from "zod";
import { idSchema } from "./common";
import { imageStatusSchema } from "./models";

/**
 * Image quiz AI pipeline contracts (spec-06).
 * contextSheetSchema is the vision job's REQUIRED output shape — the AI gateway
 * validates against it, so malformed model output fails the job, never the data.
 */

export const detectedSignSchema = z.object({
  signCode: z.string().min(1), // must exist in Sign registry — service cross-checks
  confidence: z.number().min(0).max(1),
  bbox: z
    .object({
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      w: z.number().min(0).max(1),
      h: z.number().min(0).max(1),
    })
    .optional(),
});

export const contextSheetSchema = z.object({
  signs: z.array(detectedSignSchema),
  roadMarkings: z.array(z.string()),
  actors: z.array(z.string()), // "cyclist right side", "oncoming car", …
  conditions: z.object({
    lighting: z.string(),
    weather: z.string(),
    roadType: z.string(),
  }),
  situationSummary: z.string().min(1),
  applicableRules: z.array(
    z.object({
      sourceCode: z.string(),
      ref: z.string(),
      note: z.string().optional(),
    }),
  ),
});
export type ContextSheet = z.infer<typeof contextSheetSchema>;

export const uploadImagesInputSchema = z
  .object({
    files: z
      .array(
        z.object({
          fileName: z.string().min(1),
          contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
          sizeBytes: z.int().max(15 * 1024 * 1024),
        }),
      )
      .min(1)
      .max(50), // batch ≤50 (spec-06)
    licenseAttestation: z.object({
      confirmedRights: z.literal(true),
      note: z.string().optional(),
    }),
  })
  .strict();

export const correctContextSheetInputSchema = z
  .object({
    imageAssetId: idSchema,
    contextSheet: contextSheetSchema, // full corrected sheet; stored as few-shot example
  })
  .strict();

export const imageJobStatusSchema = z
  .object({
    imageAssetId: idSchema,
    status: imageStatusSchema,
    candidatesGenerated: z.int().min(0),
    candidatesSurvived: z.int().min(0),
    lastError: z.string().nullable(),
    updatedAt: z.date(),
  })
  .strict();

/** Validator chain verdict — stored on ItemVariant.validatorReport / rejection reason. */
export const validatorReportSchema = z.object({
  schemaValid: z.boolean(),
  citationSupported: z.boolean(),
  singleCorrect: z.boolean(),
  distractorAmbiguity: z.boolean(), // true = ambiguity detected → reject
  similarityMax: z.number().min(0).max(1), // vs existing pool
  styleOk: z.boolean(),
  passed: z.boolean(),
  reasons: z.array(z.string()),
});
