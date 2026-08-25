import { getTranslations, setRequestLocale } from "next-intl/server";
import { CategoryProgress } from "@/components/quiz/category-progress";
import { RecentTests } from "@/components/quiz/recent-tests";
import { ResumeCard } from "@/components/quiz/resume-card";
import { StartTiles } from "@/components/quiz/start-tiles";
import { Card, CardContent } from "@/components/ui/card";
import { Link } from "@/i18n/navigation";
import { pickBilingualText } from "@/lib/i18n-content";
import { getSessionUser } from "@/server/auth";
import { db } from "@/server/db";
import { examReadiness } from "@/server/services/assessment/exam-readiness";
import {
  categoryPerformance,
  getResumableAttempt,
  listAttemptHistory,
} from "@/server/services/assessment/history";
import { schoolConfig, type AppLocale } from "../../../config/school.config";

/**
 * Student home. Signed out it explains what this is; signed in it is the way into a test.
 *
 * The full dashboard (mastery, streaks, readiness) is spec-09 — this is the part that matters
 * first: a student can start practising, and can see what they have already done.
 */
export default async function HomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const [t, user] = await Promise.all([
    getTranslations("home"),
    getSessionUser(),
  ]);

  if (!user) {
    return (
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 px-4 py-10">
        <div className="space-y-3 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {t("title")}
          </h1>
          <p className="text-balance text-muted-foreground">{t("subtitle")}</p>
        </div>
        <Card>
          <CardContent className="space-y-3 text-center">
            <p className="text-muted-foreground">{t("signedOutNote")}</p>
            <Link
              href="/login"
              className="inline-flex min-h-11 items-center rounded-md text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              {t("logIn")}
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  // How much material is actually ready to serve — an empty pool must say so, not fail on tap.
  // Counted per type, because the three tiles draw from three different pools: a school with a
  // full theory bank and no sign registry must get a working Theory tile and an honestly disabled
  // Sign tile, not three tiles of which two fail on tap.
  // Served by MasterItem_topicId_status_type_idx.
  const [byType, examReady, topics, history, resumable, categories] =
    await Promise.all([
      db.masterItem.groupBy({
        by: ["type"],
        where: {
          status: "APPROVED",
          deletedAt: null,
          variants: { some: { isActive: true } },
        },
        _count: { _all: true },
      }),
      // Whether an exam can actually be assembled — a total is not the same as a full blueprint.
      examReadiness(db, schoolConfig.licenseClassSeeds[0].code),
      db.topic.findMany({
        where: { parentId: null, isActive: true, deletedAt: null },
        select: { id: true, slug: true, name: true },
        orderBy: { sortOrder: "asc" },
      }),
      listAttemptHistory(db, user, user.id, { page: 1, pageSize: 3 }),
      // A test left half-finished is offered back before anything new is started.
      getResumableAttempt(db, user, user.id),
      // Category standing, from tests only — practice does not tell you how you perform under test
      // conditions, which is the question this panel answers.
      categoryPerformance(db, user, user.id, locale as AppLocale),
    ]);

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          {t("title")}
        </h1>
        <p className="text-balance text-sm/relaxed text-muted-foreground">
          {t("subtitle")}
        </p>
      </header>

      {resumable ? <ResumeCard attempt={resumable} /> : null}

      <StartTiles
        locale={locale as AppLocale}
        counts={{
          TEXT: byType.find((row) => row.type === "TEXT")?._count._all ?? 0,
          IMAGE: byType.find((row) => row.type === "IMAGE")?._count._all ?? 0,
          SIGN: byType.find((row) => row.type === "SIGN")?._count._all ?? 0,
        }}
        signTestEnabled={schoolConfig.featureFlags.signTest}
        examReady={examReady.ready}
        examShortfall={examReady.shortfall.length}
        topics={topics.map((topic) => ({
          slug: topic.slug,
          label: pickBilingualText(topic.name, locale as AppLocale),
        }))}
      />

      <CategoryProgress categories={categories} />

      <RecentTests attempts={history.items} />
    </div>
  );
}
