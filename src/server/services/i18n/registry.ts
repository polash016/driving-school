import type { PrismaClient } from "@prisma/client";
import { logger } from "@/lib/logger";
import { BUILTIN_LANGUAGES, type LanguageSnapshot } from "@/i18n/builtin";
import { primeLocalePrefixes } from "@/lib/locale-url";
import { cacheDel, cacheGet, cacheSet, keys } from "@/server/redis";
import { schoolConfig } from "../../../../config/school.config";

/**
 * The language registry (spec-15) — which languages exist, right now.
 *
 * Four layers, each falling back to the next:
 *
 *   process memo (30 s)  →  Redis (1 h)  →  Postgres  →  the compiled en/nb floor
 *
 * The floor is the point. `en` and `nb` are compiled into the app and are never read from the
 * database, so a school whose Postgres or Redis is down still serves both original languages
 * rather than a blank page. Adding a language is the only thing that depends on the upper layers.
 *
 * The memo lives on `globalThis` deliberately: Next 16 loads the proxy in-process, so clearing it
 * from an admin action reaches the proxy's copy too and a new language is live on the very next
 * request. If that ever stops holding, the 30 s TTL is the fallback and the language appears
 * within half a minute instead of instantly — worth knowing, not worth engineering around.
 */

const MEMO_TTL_MS = 30_000;
const REDIS_TTL_SEC = 3_600;

export interface LocaleRegistry {
  languages: LanguageSnapshot[];
  defaultLocale: string;
  /** Every language, including ones not yet visible to students (the admin still routes to them). */
  codes: string[];
  /** Code → URL prefix, for next-intl's `localePrefix.prefixes`. */
  prefixes: Record<string, string>;
  has(code: string): boolean;
  directionOf(code: string): "ltr" | "rtl";
  get(code: string): LanguageSnapshot | undefined;
  /** Languages a student may pick. */
  visible(): LanguageSnapshot[];
}

interface Memo {
  registry: LocaleRegistry;
  expiresAt: number;
}

const MEMO_KEY = Symbol.for("teoripro.i18n.registry");
const globalMemo = globalThis as unknown as { [MEMO_KEY]?: Memo };

function build(languages: LanguageSnapshot[]): LocaleRegistry {
  // Keep the synchronous prefix map in step, so email links and auth redirects are right for a
  // language that did not exist when this process started.
  primeLocalePrefixes(Object.fromEntries(languages.map((l) => [l.code, l.urlPrefix])));
  const sorted = [...languages].sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));
  const byCode = new Map(sorted.map((language) => [language.code, language]));
  const prefixes = Object.fromEntries(sorted.map((language) => [language.code, language.urlPrefix]));
  const defaultLocale = byCode.has(schoolConfig.locales.default)
    ? schoolConfig.locales.default
    : (sorted[0]?.code ?? "en");

  return {
    languages: sorted,
    defaultLocale,
    codes: sorted.map((language) => language.code),
    prefixes,
    has: (code) => byCode.has(code),
    directionOf: (code) => (byCode.get(code)?.direction === "RTL" ? "rtl" : "ltr"),
    get: (code) => byCode.get(code),
    visible: () => sorted.filter((language) => language.studentVisible),
  };
}

/** The compiled floor — used whenever nothing better can be reached. */
export const BUILTIN_REGISTRY: LocaleRegistry = build(BUILTIN_LANGUAGES);

function readMemo(): LocaleRegistry | null {
  const memo = globalMemo[MEMO_KEY];
  return memo && memo.expiresAt > Date.now() ? memo.registry : null;
}

function writeMemo(registry: LocaleRegistry): void {
  globalMemo[MEMO_KEY] = { registry, expiresAt: Date.now() + MEMO_TTL_MS };
}

/**
 * The registry as the current request should see it.
 *
 * `db` is optional on purpose: the proxy must not import Prisma (`src/server/db.ts` only pins its
 * client to `globalThis` outside production, so a second module instance there would open a second
 * connection pool). The proxy passes nothing and reads memo → Redis → floor; the app passes the
 * client and repopulates Redis on a miss.
 */
export async function getRegistry(db?: PrismaClient): Promise<LocaleRegistry> {
  const memo = readMemo();
  if (memo) return memo;

  const cached = await cacheGet<LanguageSnapshot[]>(keys.i18nRegistry());
  if (cached && cached.length > 0) {
    const registry = build(cached);
    writeMemo(registry);
    return registry;
  }

  if (!db) return BUILTIN_REGISTRY;

  try {
    const rows = await db.language.findMany({
      select: {
        code: true,
        englishName: true,
        nativeName: true,
        shortLabel: true,
        urlPrefix: true,
        direction: true,
        isBuiltIn: true,
        requiresApproval: true,
        studentVisible: true,
        fallbackCode: true,
        sortOrder: true,
      },
      orderBy: { sortOrder: "asc" },
    });
    if (rows.length === 0) return BUILTIN_REGISTRY;

    const languages = rows as LanguageSnapshot[];
    await cacheSet(keys.i18nRegistry(), languages, REDIS_TTL_SEC);
    const registry = build(languages);
    writeMemo(registry);
    return registry;
  } catch (error) {
    // A language list that cannot be read must not take the site down: en and nb still work.
    logger.error({ error }, "language registry unreadable — serving the compiled languages");
    return BUILTIN_REGISTRY;
  }
}

/** Called after any change to a language. Clears the process memo and the Redis copy. */
export async function invalidateRegistry(): Promise<void> {
  delete globalMemo[MEMO_KEY];
  await cacheDel(keys.i18nRegistry());
}

/**
 * Narrow an untrusted locale (a route param, a form field, a stored preference) to one that
 * actually exists. Never throws — an unknown code falls back to the default rather than 500ing a
 * page, because a deactivated language is a normal thing for a profile to still point at.
 */
export function resolveLocale(registry: LocaleRegistry, candidate: unknown): string {
  return typeof candidate === "string" && registry.has(candidate)
    ? candidate
    : registry.defaultLocale;
}
