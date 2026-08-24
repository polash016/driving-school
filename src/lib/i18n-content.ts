import type { Locale } from "@/server/contracts/common";

/**
 * Resolve bilingual DB content ({ en, nb }) to one locale.
 * Fallback chain: requested → the other locale (never crash on missing content;
 * ingestion guards should prevent this, callers may log).
 */
export function pickLocale<T>(
  content: { en: T; nb: T },
  locale: Locale,
): T {
  return content[locale] ?? content[locale === "en" ? "nb" : "en"];
}
