import { defineRouting } from "next-intl/routing";
import { BUILTIN_LOCALES, BUILTIN_PREFIXES } from "@/lib/locale";
import { schoolConfig } from "../../config/school.config";

/**
 * Static routing config — client-safe, and deliberately built from the COMPILED languages only.
 *
 * This module reaches the browser through `navigation.ts`, so it can never be async and can never
 * read the database. That is fine, because next-intl's navigation helpers do not consult
 * `locales`: `<Link>` and `redirect()` resolve a prefix through `getLocalePrefix()`, which falls
 * back to `/<code>` for anything not named in `prefixes`. A language added at runtime therefore
 * links correctly with no code change at all.
 *
 * The consequence to respect: a runtime-added language MUST be served at `/<code>`. A custom
 * prefix would live only on the server, so `<Link>` would emit `/pt-BR/...` while the proxy
 * expected `/br/...` — a redirect loop. `nb → /no` works only because it is compiled in here.
 *
 * The proxy builds its own routing object per request from the live registry
 * (`src/i18n/runtime-routing.ts`); this one is for the client.
 */
export const routing = defineRouting({
  locales: [...BUILTIN_LOCALES],
  // The config value is a BCP-47 string now; the compiled set is what this object routes over.
  defaultLocale: (BUILTIN_LOCALES as readonly string[]).includes(schoolConfig.locales.default)
    ? (schoolConfig.locales.default as (typeof BUILTIN_LOCALES)[number])
    : "en",
  localePrefix: {
    mode: "always",
    prefixes: { nb: BUILTIN_PREFIXES.nb },
  },
});
