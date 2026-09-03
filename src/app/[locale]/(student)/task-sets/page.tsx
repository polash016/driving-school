import { getTranslations, setRequestLocale } from "next-intl/server";
import { TaskSetGrid } from "@/components/task-sets/task-set-grid";
import { requireUser } from "@/server/auth/require-user";
import { taskSetService } from "@/server/services/task-sets";
import type { AppLocale } from "../../../../../config/school.config";

/**
 * The task set grid (spec-16). Mobile-first at the 390px design target; desktop renders the same
 * centred column, per the student-panel viewport rule.
 */
export default async function TaskSetsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requireUser();

  const [t, board] = await Promise.all([
    getTranslations("taskSets"),
    taskSetService.studentBoard(user.id),
  ]);

  const progressPct =
    board.totalCount === 0
      ? 0
      : Math.round((board.passedCount / board.totalCount) * 100);

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col gap-5 px-4 py-6">
      <header className="space-y-1.5">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {t("title")}
        </h1>
        <p className="text-sm/relaxed text-muted-foreground">{t("subtitle")}</p>
      </header>

      {board.totalCount > 0 ? (
        <section className="space-y-2 rounded-[var(--radius-base)] border border-border bg-card p-4 shadow-[var(--shadow-card)]">
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuenow={progressPct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={t("progress", {
              passed: board.passedCount,
              total: board.totalCount,
            })}
          >
            <div
              className="h-full rounded-full bg-[var(--status-success)] transition-[width] duration-500 motion-reduce:transition-none"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>
              {t("progress", {
                passed: board.passedCount,
                total: board.totalCount,
              })}
            </span>
            {board.nextNumber !== null ? (
              <span>{t("nextUp", { number: board.nextNumber })}</span>
            ) : null}
          </div>
        </section>
      ) : null}

      <TaskSetGrid board={board} locale={locale as AppLocale} />
    </div>
  );
}
