import { getRequestConfig } from "next-intl/server";
import { db } from "@/server/db";
import { getMessages } from "@/server/services/i18n/catalogue";
import { getRegistry, resolveLocale } from "@/server/services/i18n/registry";
import { schoolConfig } from "../../config/school.config";
import { logger } from "@/lib/logger";

/**
 * Per-request i18n config.
 *
 * Messages no longer come from a bundler glob over `src/i18n/messages/*.json` — a language added
 * at runtime has no file on disk. Built-in languages still resolve from the compiled catalogues;
 * everything else is English with that language's translations merged on top, so a missing key
 * renders English rather than a raw dotted path.
 *
 * `onError` swallows next-intl's missing-message errors on purpose: with catalogues coming from a
 * database, a gap is a content problem to be reported as coverage, never a reason for a student's
 * page to fail mid-exam.
 */
export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const registry = await getRegistry(db);
  const locale = resolveLocale(registry, requested);

  return {
    locale,
    timeZone: schoolConfig.locales.timeZone,
    messages: await getMessages(locale, db),
    onError(error) {
      logger.warn({ error: error.message, locale }, "intl message error");
    },
  };
});
