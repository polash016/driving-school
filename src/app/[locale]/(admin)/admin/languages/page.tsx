import { getTranslations, setRequestLocale } from "next-intl/server";
import { LanguageBoard, type LanguageRow } from "@/components/admin/languages/language-board";
import { requireUser } from "@/server/auth/require-user";
import { db } from "@/server/db";
import { languageCoverage, listLanguages } from "@/server/services/i18n/languages";

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
    languages.map(async (language) => ({
      ...language,
      coverage: await languageCoverage(db, language.code),
    })),
  );

  const running = await db.translationRun.findFirst({
    where: { status: { in: ["RUNNING", "PAUSED"] } },
    orderBy: { createdAt: "desc" },
    select: { id: true, locale: true, plannedUnits: true, translatedUnits: true },
  });

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-8">
      <header className="space-y-1.5">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">{t("title")}</h1>
        <p className="text-sm/relaxed text-muted-foreground">{t("subtitle")}</p>
      </header>

      <LanguageBoard
        languages={rows}
        activeRun={
          running
            ? {
                id: running.id,
                locale: running.locale,
                planned: running.plannedUnits,
                done: running.translatedUnits,
              }
            : null
        }
      />
    </div>
  );
}
