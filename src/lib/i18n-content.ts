import { isBuiltinLocale, type Locale } from "@/lib/locale";
import type { ContentLocale } from "@/server/contracts/common";

/**
 * Resolving `{ en, nb }` content to what a student should actually read.
 *
 * Content is authored in exactly two languages and translated onward from there (spec-15), so
 * these helpers answer a narrower question than they used to: *which authored side do we fall back
 * to*, once a translation overlay has already had its chance.
 */

/** The authored side to fall back to. Anything that is not an authoring locale falls back to English. */
export function contentSideFor(locale: Locale): ContentLocale {
  return locale === "nb" ? "nb" : "en";
}

/**
 * Resolve authored bilingual content to one side.
 *
 * The old behaviour flipped en↔nb — right for a bilingual product, wrong the moment there are six
 * languages: a student reading Arabic is not helped by being shown Norwegian. English is the
 * universal fallback now, and Norwegian is served only to someone who asked for Norwegian.
 */
export function pickLocale<T>(content: { en: T; nb: T }, locale: Locale): T {
  const side = contentSideFor(locale);
  return content[side] ?? content.en ?? content.nb;
}

/**
 * Same idea for values coming straight out of a Json column, where the type is `unknown`:
 * parse defensively and never throw in a render path — a missing label is a content bug, not a
 * reason for a page to 500.
 */
export function pickBilingualText(value: unknown, locale: Locale): string {
  const content = value as { en?: unknown; nb?: unknown } | null;
  const side = contentSideFor(locale);
  const preferred = content?.[side];
  const fallback = side === "en" ? content?.nb : content?.en;
  if (typeof preferred === "string" && preferred.length > 0) return preferred;
  if (typeof fallback === "string" && fallback.length > 0) return fallback;
  return "";
}

/**
 * The full chain for a translated string: the overlay, then the language's own fallback, then the
 * authored English.
 *
 * `overlay` is whatever the translation store resolved for this locale — `null` when the language
 * is built in, when nothing has been translated yet, or when the translation is not servable under
 * the language's approval policy. In every one of those cases the student reads English, which is
 * the honest outcome and never an error.
 */
export function resolveText(
  overlay: string | null | undefined,
  authored: unknown,
  locale: Locale,
): string {
  if (typeof overlay === "string" && overlay.length > 0) return overlay;
  return pickBilingualText(authored, isBuiltinLocale(locale) ? locale : "en");
}
