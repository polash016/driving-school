import { getTranslations, setRequestLocale } from "next-intl/server";
import {
  LanguageBoard,
  type LanguageRow,
} from "@/components/admin/languages/language-board";
import { requireUser } from "@/server/auth/require-user";
import { db } from "@/server/db";
import { keys, redis } from "@/server/redis";
import {
  languageCoverage,
  listLanguages,
} from "@/server/services/i18n/languages";
import { latestRunFor } from "@/server/services/i18n/run-control";

/**
 * Languages (spec-15): what the school offers, how far each one has got, and the two switches
 * that decide whether students see it.
 */
export default async function LanguagesPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireUser("ADMIN");

  const [t, languages] = await Promise.all([
    getTranslations("admin.languages"),
    listLanguages(db),
  ]);

  const rows: LanguageRow[] = await Promise.all(
    languages.map(async (language) => {
      // Index: TranslationRun[locale, status, createdAt] serves latestRunFor; coverage is its own
      // cached read. Both per language, both bounded by the handful of languages a school offers.
      const [coverage, latestRun] = await Promise.all([
        languageCoverage(db, language.code),
        latestRunFor(db, language.code),
      ]);
      return { ...language, coverage, latestRun };
    }),
  );

  const workerOnline = await isWorkerOnline();

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-8">
      <header className="space-y-1.5">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {t("title")}
        </h1>
        <p className="text-sm/relaxed text-muted-foreground">{t("subtitle")}</p>
      </header>

      <LanguageBoard languages={rows} workerOnline={workerOnline} />
    </div>
  );
}

/**
 * The worker sets this key every poll with a 3×poll TTL, so its presence means one is alive.
 * Redis being down must never take the board down — it degrades to "offline", which is exactly
 * what an admin would conclude anyway.
 */
async function isWorkerOnline(): Promise<boolean> {
  try {
    return Boolean(await redis.get(keys.i18nWorker()));
  } catch {
    return false;
  }
}
