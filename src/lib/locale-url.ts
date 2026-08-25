import { BUILTIN_PREFIXES, prefixForLocale, type Locale } from "@/lib/locale";

/**
 * URL prefix per locale — shared by next-intl routing and by server-side link building for emails,
 * where there is no request context.
 *
 * Deliberately synchronous. `absoluteUrl()` is called from `email/templates.ts` on every auth
 * flow and from `auth/config.ts` at module load; making it async would spread `await` through the
 * whole auth layer for a lookup that is a map read.
 *
 * The map starts as the compiled built-ins and is topped up by the language registry
 * (`primeLocalePrefixes`) whenever it loads. Even before that first load the answer is correct for
 * runtime languages, because they are always served at `/<code>` — only `nb → /no` needs the map.
 */
const prefixes: Record<string, string> = { ...BUILTIN_PREFIXES };

/** Called by the language registry after it reads the language list. */
export function primeLocalePrefixes(next: Readonly<Record<string, string>>): void {
  for (const [code, prefix] of Object.entries(next)) prefixes[code] = prefix;
}

export const LOCALE_PREFIXES: Readonly<Record<string, string>> = prefixes;

/** Locale-prefixed path, e.g. localePath("nb", "/login") → "/no/login". */
export function localePath(locale: Locale, path: string): string {
  return `${prefixForLocale(locale, prefixes)}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Absolute link for emails: absoluteUrl(base, "nb", "/login") → "https://…/no/login". */
export function absoluteUrl(baseUrl: string, locale: Locale, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}${localePath(locale, path)}`;
}
