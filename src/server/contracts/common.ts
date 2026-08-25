import { z } from "zod";
import { localeSchema as baseLocaleSchema } from "@/lib/locale";

/**
 * Shared contract primitives. Every API boundary parses input AND output
 * with schemas from src/server/contracts (architecture blueprint §2/§7).
 */

/**
 * A locale a student can be served in. Open since spec-15: a school adds languages at runtime, so
 * this validates the SHAPE of a code and the language registry decides which ones exist.
 */
export const localeSchema = baseLocaleSchema;
export type Locale = string;

/**
 * The AUTHORING pair — the two languages content is written in and the `{ en, nb }` columns hold.
 * Deliberately still closed: a question is authored in English and Norwegian and translated from
 * there, so the quality gate, the content hash and the option-key parity rules all keep working
 * against exactly two known sides.
 */
export const contentLocaleSchema = z.enum(["en", "nb"]);
export type ContentLocale = z.infer<typeof contentLocaleSchema>;

/** Bilingual content payload — both authoring locales always present (mandate 4). */
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

/**
 * Server actions return this shape and nothing else — never a raw exception and never an
 * `AppError.meta` (logs only). `messageKey` points into the i18n "errors"/"auth.errors"
 * namespaces so the client renders bilingual, user-safe text.
 */
export const actionErrorSchema = z
  .object({
    ok: z.literal(false),
    code: z.string(),
    messageKey: z.string(),
    fieldErrors: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type ActionError = z.infer<typeof actionErrorSchema>;

export const actionOkSchema = z.object({ ok: z.literal(true) }).strict();

export function actionResultSchema<T extends z.ZodType>(data: T) {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), data }).strict(),
    actionErrorSchema,
  ]);
}

/**
 * `[T] extends [undefined]` rather than `T extends undefined`: the naked form distributes over a
 * union payload, which silently turns `ActionResult<A | B>` into `ActionResult<A> | ActionResult<B>`
 * and rejects a perfectly good value.
 */
export type ActionResult<T = undefined> =
  | ([T] extends [undefined] ? { ok: true } : { ok: true; data: T })
  | ActionError;
