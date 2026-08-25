import { getTranslations, setRequestLocale } from "next-intl/server";
import { QuizSetup } from "@/components/quiz/quiz-setup";
import { pickBilingualText } from "@/lib/i18n-content";
import { requireUser } from "@/server/auth/require-user";
import { db } from "@/server/db";
import {
  schoolConfig,
  type AppLocale,
} from "../../../../../../config/school.config";

/**
 * Test setup (student-facing). The student decides the clock, the length and which categories are
 * in play — and is told BEFORE starting whether the result will count towards the pass guarantee.
 * Finding that out afterwards would be worthless.
 */
export default async function QuizSetupPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireUser();

  const [t, topics, licenseClass] = await Promise.all([
    getTranslations("quiz.setup"),
    db.topic.findMany({
      where: { parentId: null, isActive: true, deletedAt: null },
      select: { slug: true, name: true },
      orderBy: { sortOrder: "asc" },
    }),
    db.licenseClass.findFirst({
      where: { code: schoolConfig.licenseClassSeeds[0].code },
      select: { timeLimitMin: true, questionCount: true, passMark: true },
    }),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col gap-5 px-4 py-8">
      <header className="space-y-1.5">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {t("title")}
        </h1>
        <p className="text-sm/relaxed text-muted-foreground">{t("subtitle")}</p>
      </header>

      <QuizSetup
        locale={locale as AppLocale}
        timeLimitMin={licenseClass?.timeLimitMin ?? 90}
        officialCount={licenseClass?.questionCount ?? 45}
        officialPassMark={licenseClass?.passMark ?? 38}
        topics={topics.map((topic) => ({
          slug: topic.slug,
          label: pickBilingualText(topic.name, locale as AppLocale),
        }))}
      />
    </div>
  );
}
