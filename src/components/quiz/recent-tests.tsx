import { getFormatter, getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import type { AttemptSummary } from "@/server/services/assessment/history";

/**
 * A glimpse of the record: the last few tests, each with what it scored and whether it passed.
 *
 * A finished test links to its paper — the questions exactly as they were sat, with the student's
 * own answers. One still running links back into itself so it can be finished.
 */
export async function RecentTests({ attempts }: { attempts: AttemptSummary[] }) {
  const [t, tHistory, format] = await Promise.all([
    getTranslations("home"),
    getTranslations("history"),
    getFormatter(),
  ]);
  if (attempts.length === 0) return null;

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-foreground">{t("recentTests")}</h2>
        <Link
          href="/account/history"
          className="min-h-11 py-3 text-sm text-primary underline-offset-4 hover:underline"
        >
          {t("seeAll")}
        </Link>
      </div>

      <ul className="space-y-2">
        {attempts.map((attempt) => {
          const running = attempt.status === "IN_PROGRESS";
          const percent =
            attempt.correctCount === null
              ? null
              : Math.round((attempt.correctCount / attempt.questionCount) * 100);

          return (
            <li key={attempt.id}>
              <Link
                href={running ? `/quiz/${attempt.id}` : `/account/history/${attempt.id}`}
                className="flex min-h-14 items-center justify-between gap-3 rounded-[var(--radius-control)] bg-card px-3.5 py-2.5 shadow-card ring-1 ring-foreground/5 transition-colors hover:bg-muted"
              >
                <span className="min-w-0 space-y-0.5">
                  <span className="block truncate text-sm font-medium text-foreground">
                    {tHistory(`kind.${attempt.kind}`)}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {format.dateTime(attempt.startedAt, { dateStyle: "medium" })}
                  </span>
                </span>

                <span className="flex shrink-0 items-center gap-2">
                  {running ? (
                    <span className="text-sm font-medium text-primary">{t("resume")}</span>
                  ) : (
                    <>
                      <span className="text-sm font-semibold tabular-nums text-foreground">
                        {attempt.correctCount ?? 0}/{attempt.questionCount}
                        {percent !== null ? (
                          <span className="ml-1 text-xs font-normal text-muted-foreground">
                            {percent}%
                          </span>
                        ) : null}
                      </span>
                      {attempt.passed !== null ? (
                        <span
                          className={cn(
                            "rounded-full px-2 py-0.5 text-[0.6875rem] font-medium",
                            attempt.passed
                              ? "bg-[var(--status-success-soft)] text-[var(--status-success)]"
                              : "bg-destructive/10 text-destructive",
                          )}
                        >
                          {attempt.passed ? tHistory("passed") : tHistory("notPassed")}
                        </span>
                      ) : null}
                    </>
                  )}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
