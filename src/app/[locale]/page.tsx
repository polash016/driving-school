import { getTranslations, setRequestLocale } from "next-intl/server";
import { CategoryProgress } from "@/components/quiz/category-progress";
import { RecentTests } from "@/components/quiz/recent-tests";
import { ResumeCard } from "@/components/quiz/resume-card";
import { StartTiles } from "@/components/quiz/start-tiles";
import { StatPair } from "@/components/quiz/stat-pair";
import { TaskSetHero } from "@/components/task-sets/task-set-hero";
import { Card, CardContent } from "@/components/ui/card";
import { Link } from "@/i18n/navigation";
import { getSessionUser } from "@/server/auth";
import { db } from "@/server/db";
import {
  categoryPerformance,
  getResumableAttempt,
  listAttemptHistory,
  passRate,
} from "@/server/services/assessment/history";
import { taskSetService } from "@/server/services/task-sets";
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

  // What the panel needs, in one round of parallel reads (mandate 2).
  //
  // Only the SIGN pool is counted now: Practice opens the setup screen rather than starting a
  // paper, and a task set's readiness is the published-set count, not a bank total. A school with
  // no sign registry must still get a working Practice tile and an honestly disabled Sign test —
  // so the tile is gated on its own pool, not on the bank as a whole.
  // Served by MasterItem_topicId_status_type_idx.
  const [
    signCount,
    licenseClass,
    board,
    history,
    resumable,
    categories,
    rate,
    profile,
  ] = await Promise.all([
    db.masterItem.count({
      where: {
        type: "SIGN",
        status: "APPROVED",
        deletedAt: null,
        variants: { some: { isActive: true } },
      },
    }),
    db.licenseClass.findFirst({
      where: { code: schoolConfig.licenseClassSeeds[0].code },
      select: { questionCount: true, timeLimitMin: true },
    }),
    taskSetService.studentBoard(user.id),
    // Ten, all types — the reference lists a page of them, and three was too few to read as a
    // record of anything (spec-09 amendment 2026-09-03).
    listAttemptHistory(db, user, user.id, { page: 1, pageSize: 10 }),
    // A test left half-finished is offered back before anything new is started.
    getResumableAttempt(db, user, user.id),
    // Category standing, from tests only — practice does not tell you how you perform under
    // test conditions, which is the question this panel answers.
    categoryPerformance(db, user, user.id, locale as AppLocale),
    passRate(db, user, user.id),
    // Just the first name — the greeting is the only thing on this page that needs it.
    db.profile.findUnique({
      where: { userId: user.id },
      select: { firstName: true },
    }),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
      <header className="space-y-1">
        <h1 className="text-[1.7rem] font-bold tracking-[-0.028em] text-foreground">
          {profile?.firstName
            ? t("greeting", { name: profile.firstName })
            : t("greetingAnon")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {board.totalCount > 0
            ? t("greetingProgress", {
                passed: board.passedCount,
                total: board.totalCount,
              })
            : t("subtitle")}
        </p>
      </header>

      {resumable ? <ResumeCard attempt={resumable} /> : null}

      {/* Falls back to the CONFIG seed, never to a literal: mandate 4 forbids "45" and "38"
          appearing in code, and a school with a different class must not see class B's numbers
          because a row was missing. */}
      <TaskSetHero
        board={board}
        paperSize={
          licenseClass?.questionCount ??
          schoolConfig.licenseClassSeeds[0].questionCount
        }
        timeLimitSec={
          (licenseClass?.timeLimitMin ??
            schoolConfig.licenseClassSeeds[0].timeLimitMin) * 60
        }
      />

      <StartTiles
        locale={locale as AppLocale}
        signCount={signCount}
        signTestEnabled={schoolConfig.featureFlags.signTest}
      />

      <StatPair passRate={rate.percent} passedCount={board.passedCount} />

      <CategoryProgress categories={categories} />

      <RecentTests attempts={history.items} />
    </div>
  );
}
