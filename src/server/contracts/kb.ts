import { z } from "zod";
import { idSchema } from "./common";
import {
  factTypeSchema,
  kbSourceKindSchema,
  legalCitationSchema,
} from "./models";

/** Knowledge-base & facts contracts (spec-05). */

export const kbSearchInputSchema = z
  .object({
    query: z.string().min(2).max(500),
    topicSlug: z.string().optional(),
    limit: z.int().min(1).max(20).default(8),
  })
  .strict();

export const kbSearchHitSchema = z
  .object({
    chunkId: idSchema,
    sourceCode: z.string(),
    sourceName: z.string(),
    ref: z.string(),
    text: z.string(),
    score: z.number(), // fused hybrid score (vector + keyword), higher = better
  })
  .strict();

export const kbSearchResultSchema = z
  .object({ hits: z.array(kbSearchHitSchema) })
  .strict();

export const ingestSourceInputSchema = z
  .object({
    code: z.string().min(1).max(64),
    kind: kbSourceKindSchema,
    name: z.string().min(1),
    url: z.string().optional(),
    effectiveDate: z.iso.datetime().optional(),
    version: z.string().optional(),
    /** Raw text; the pipeline chunks + embeds it. Re-ingesting a code replaces its chunks. */
    text: z.string().min(1),
  })
  .strict();

export const upsertFactInputSchema = z
  .object({
    key: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9_]+$/, "snake_case keys only"),
    value: z.string().min(1),
    valueType: factTypeSchema,
    unit: z.string().optional(),
    description: z.string().optional(),
    sourceRef: legalCitationSchema,
    effectiveFrom: z.iso.datetime().optional(),
  })
  .strict();

/** "Affected items" lookup — what a fact/chunk change would flag for re-review. */
export const affectedItemsInputSchema = z
  .object({
    factKey: z.string().optional(),
    kbChunkId: idSchema.optional(),
  })
  .strict()
  .refine((v) => Boolean(v.factKey) !== Boolean(v.kbChunkId), {
    message: "provide exactly one of factKey or kbChunkId",
  });
