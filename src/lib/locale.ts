import { z } from "zod";

/**
 * What a locale code is (spec-15).
 *
 * Locales used to be a closed pair — a Prisma enum and two separate Zod enums, all spelling out
 * `"en" | "nb"`. A school can now add a language from the admin panel, so the code became an open
 * set and this is the one place that says what a valid one looks like.
 *
 * BCP-47, loosely: a 2–3 letter language, optionally followed by script/region subtags
 * (`en`, `nb`, `es`, `ar`, `pt-BR`). Deliberately permissive about *which* language — refusing
 * Tigrinya because it is not on a list would be exactly the wrong failure — and strict about
 * shape, because the code becomes a URL segment.
 *
 * Client-safe: no imports beyond zod, so `config/school.config.ts` (which reaches the client
 * bundle through the site header) can use it.
 */
export const localeSchema = z
  .string()
  .min(2)
  .max(35)
  .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "must be a BCP-47 language tag, e.g. en, nb, pt-BR");

export type Locale = z.infer<typeof localeSchema>;

/**
 * The two languages compiled into the app.
 *
 * Their UI strings live in `src/i18n/messages/*.json` and their content in the `{ en, nb }` JSON
 * columns, so they are servable with no database and no Redis. Everything else is runtime data.
 * This constant is the floor the language registry falls back to.
 */
export const BUILTIN_LOCALES = ["en", "nb"] as const;
export type BuiltinLocale = (typeof BUILTIN_LOCALES)[number];

export function isBuiltinLocale(value: string): value is BuiltinLocale {
  return (BUILTIN_LOCALES as readonly string[]).includes(value);
}

/**
 * URL prefixes for the built-ins. Norwegian is `nb` internally but `/no` in the URL — a spec-01
 * decision, grandfathered.
 *
 * Runtime-added languages always use `/<code>`: next-intl compiles `localePrefix.prefixes` into
 * the client bundle, so a prefix that disagreed with the code would make `<Link>` and the proxy
 * point at different URLs and loop.
 */
export const BUILTIN_PREFIXES: Record<BuiltinLocale, string> = {
  en: "/en",
  nb: "/no",
};

/** The URL prefix a language uses. Anything not built in is served at `/<code>`. */
export function prefixForLocale(
  locale: string,
  overrides: Readonly<Record<string, string>> = BUILTIN_PREFIXES,
): string {
  return overrides[locale] ?? `/${locale}`;
}
