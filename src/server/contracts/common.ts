import { z } from "zod";

/**
 * Shared contract primitives. Every API boundary parses input AND output
 * with schemas from src/server/contracts (architecture blueprint §2/§7).
 */

export const localeSchema = z.enum(["en", "nb"]);
export type Locale = z.infer<typeof localeSchema>;

/** Bilingual content payload — both locales always present (mandate 4). */
export const bilingualTextSchema = z.object({
  en: z.string().min(1),
  nb: z.string().min(1),
});
export type BilingualText = z.infer<typeof bilingualTextSchema>;

export const idSchema = z.string().min(1).max(64);

export const paginationInputSchema = z.object({
  page: z.int().min(1).default(1),
  pageSize: z.int().min(1).max(100).default(20),
});
export type PaginationInput = z.infer<typeof paginationInputSchema>;

export function paginatedSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    page: z.int().min(1),
    pageSize: z.int().min(1),
    totalCount: z.int().min(0),
  });
}

/** ISO datetime string as serialized over the API boundary. */
export const isoDateTimeSchema = z.iso.datetime();
