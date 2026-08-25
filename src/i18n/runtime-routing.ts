import "server-only";
import { defineRouting } from "next-intl/routing";
import type { LocaleRegistry } from "@/server/services/i18n/registry";

/**
 * The routing config for the CURRENT set of languages.
 *
 * Rebuilt per request from the registry, which is what makes a language added in the admin panel
 * routable without a redeploy. `createMiddleware` re-reads `locales` and `localePrefix` from its
 * config on every call and does nothing at construction but copy two objects, so building this per
 * request costs nothing measurable — and keeps accept-language negotiation, the `NEXT_LOCALE`
 * cookie, the `x-next-intl-locale` header contract that `getRequestConfig` depends on, and
 * open-redirect sanitisation, all of which a hand-rolled matcher would have to reimplement.
 */
export function routingFor(registry: LocaleRegistry) {
  return defineRouting({
    locales: registry.codes,
    defaultLocale: registry.defaultLocale,
    localePrefix: { mode: "always", prefixes: registry.prefixes },
  });
}
