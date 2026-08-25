import type { PrismaClient } from "@prisma/client";
import { logger } from "@/lib/logger";
import { BASE_MESSAGES, BUILTIN_MESSAGES, type MessageCatalogue } from "@/i18n/builtin";
import { isBuiltinLocale } from "@/lib/locale";
import { cacheDel, cacheGet, cacheSet, keys } from "@/server/redis";

/**
 * UI message catalogues for runtime languages (spec-15).
 *
 * A catalogue is assembled as `en.json` with the language's own strings merged on top. That
 * ordering is the whole design: **English is always the floor**, so a half-translated language
 * renders English for what is missing instead of a raw `admin.quality.stemMissing`, and next-intl
 * can never throw on a missing key.
 *
 * Note the honest cost of that: a missing translation is invisible to the eye, so the admin screen
 * has to report coverage as a number rather than letting anyone judge by looking.
 *
 * This per-key merge is deliberately the OPPOSITE of how exam content falls back. A UI is a mosaic
 * and mixing languages inside it is normal; a question is evidence, and an Arabic stem above
 * English options is worse than plain English. Chrome is chrome; content is content.
 */

const CACHE_TTL_SEC = 3_600;

type Messages = Record<string, unknown>;

function isPlainObject(value: unknown): value is Messages {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep-merge `overlay` over `base`, leaving `base` untouched. */
export function mergeMessages(base: Messages, overlay: Messages): Messages {
  const out: Messages = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const existing = out[key];
    out[key] =
      isPlainObject(existing) && isPlainObject(value) ? mergeMessages(existing, value) : value;
  }
  return out;
}

/** Turn `{a: {b: "x"}}` into `{"a.b": "x"}` — the shape translations are keyed by. */
export function flattenMessages(messages: Messages, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(messages)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value)) Object.assign(out, flattenMessages(value, path));
    else if (typeof value === "string") out[path] = value;
  }
  return out;
}

/** Turn `{"a.b": "x"}` back into `{a: {b: "x"}}`. */
export function expandMessages(flat: Record<string, string>): Messages {
  const out: Messages = {};
  for (const [path, value] of Object.entries(flat)) {
    const parts = path.split(".");
    let node = out;
    for (const part of parts.slice(0, -1)) {
      if (!isPlainObject(node[part])) node[part] = {};
      node = node[part] as Messages;
    }
    node[parts[parts.length - 1]] = value;
  }
  return out;
}

/**
 * The catalogue for one locale.
 *
 * Built-in languages never touch the database — that is what keeps the app serving when Postgres
 * is down. Everything else is `en.json` plus whatever has been translated and is servable.
 */
export async function getMessages(
  locale: string,
  db?: PrismaClient,
  options: { servableOnly?: boolean } = {},
): Promise<MessageCatalogue> {
  if (isBuiltinLocale(locale)) return BUILTIN_MESSAGES[locale];

  const cached = await cacheGet<MessageCatalogue>(keys.i18nMessages(locale));
  if (cached) return cached;
  if (!db) return BASE_MESSAGES;

  try {
    const language = await db.language.findUnique({
      where: { code: locale },
      select: { requiresApproval: true },
    });
    if (!language) return BASE_MESSAGES;

    // A QA-flagged or rejected string is never served, whatever the approval policy says.
    const servable =
      options.servableOnly === false
        ? undefined
        : language.requiresApproval
          ? (["APPROVED"] as const)
          : (["APPROVED", "MACHINE"] as const);

    const rows = await db.translation.findMany({
      where: {
        locale,
        entity: "UI_MESSAGE",
        ...(servable ? { status: { in: [...servable] } } : {}),
      },
      select: { entityId: true, value: true },
    });

    const flat: Record<string, string> = {};
    for (const row of rows) {
      const text = (row.value as { text?: unknown } | null)?.text;
      if (typeof text === "string" && text.length > 0) flat[row.entityId] = text;
    }

    // English underneath, so the result has every key by construction — see the note above.
    const merged = mergeMessages(BASE_MESSAGES as Messages, expandMessages(flat)) as MessageCatalogue;
    await cacheSet(keys.i18nMessages(locale), merged, CACHE_TTL_SEC);
    return merged;
  } catch (error) {
    // English is always a correct answer here. A broken catalogue must not break the page.
    logger.error({ error, locale }, "message catalogue unreadable — serving English");
    return BASE_MESSAGES;
  }
}

export async function invalidateMessages(locale: string): Promise<void> {
  await cacheDel(keys.i18nMessages(locale));
}

/** Every key the UI can ask for — the denominator for translation coverage. */
export function baseMessageKeys(): string[] {
  return Object.keys(flattenMessages(BASE_MESSAGES as Messages));
}
