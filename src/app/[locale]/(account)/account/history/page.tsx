import {
  getFormatter,
  getTranslations,
  setRequestLocale,
} from "next-intl/server";
import { Card, CardContent } from "@/components/ui/card";
import { Link } from "@/i18n/navigation";
import { requireUser } from "@/server/auth/require-user";
import { db } from "@/server/db";
import { listAttemptHistory } from "@/server/services/assessment/history";
import { cn } from "@/lib/utils";

/**
 * The student's own exam record (spec-04b). Mobile-first at 390px like the rest of the student
 * panel; every entry links to the full paper: the questions as served and the answers given.
 */
export default async function HistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const [{ locale }, query] = await Promise.all([params, searchParams]);
  setRequestLocale(locale);
  const user = await requireUser();

  const [t, format, history] = await Promise.all([
    getTranslations("history"),
    getFormatter(),
    listAttemptHistory(db, user, user.id, {
      page: Number(query.page ?? 1),
      pageSize: 10,
    }),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-5 px-4 py-8">
      <header className="space-y-1.5">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {t("title")}
        </h1>
        <p className="text-sm/relaxed text-muted-foreground">{t("subtitle")}</p>
      </header>

      {history.items.length === 0 ? (
        <p className="rounded-[var(--radius-base)] border border-dashed border-border p-8 text-center text-muted-foreground">
          {t("empty")}
        </p>
      ) : (
        <ul className="space-y-3">
          {history.items.map((attempt) => (
            <li key={attempt.id}>
              <Card className="[--card-spacing:--spacing(4)]">
                <CardContent className="space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-0.5">
                      <p className="font-medium text-foreground">
                        {t(`kind.${attempt.kind}`)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {format.dateTime(attempt.startedAt, {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })}
                      </p>
                    </div>
                    {attempt.status === "IN_PROGRESS" ? (
                      <span className="rounded-full bg-[var(--status-warning-soft)] px-2.5 py-1 text-xs font-medium text-[var(--status-warning)]">
                        {t("inProgress")}
                      </span>
                    ) : (
                      <span
                        className={cn(
                          "rounded-full px-2.5 py-1 text-xs font-medium",
                          attempt.passed
                            ? "bg-[var(--status-success-soft)] text-[var(--status-success-strong)]"
                            : "bg-[var(--status-danger-soft)] text-[var(--status-danger-strong)]",
                        )}
                      >
                        {attempt.passed ? t("passed") : t("notPassed")}
                      </span>
                    )}
                  </div>

                  {attempt.status !== "IN_PROGRESS" ? (
                    <>
                      <p className="text-sm text-muted-foreground">
                        {t("score", {
                          correct: attempt.correctCount ?? 0,
                          total: attempt.questionCount,
                        })}
                        {attempt.passMark
                          ? ` · ${t("passMark", { mark: attempt.passMark })}`
                          : ""}
                      </p>
                      <div className="flex items-center justify-between gap-3">
                        <Link
                          href={`/account/history/${attempt.id}`}
                          className="inline-flex min-h-11 items-center text-sm font-medium text-primary underline-offset-4 hover:underline"
                        >
                          {t("viewPaper")}
                        </Link>
                        <span className="flex items-center gap-2 text-xs text-muted-foreground">
                          {attempt.countsTowardGuarantee ? (
                            <span className="rounded-full bg-[var(--status-success-soft)] px-2 py-0.5 font-medium text-[var(--status-success-strong)]">
                              {t("countsTowardGuarantee")}
                            </span>
                          ) : (
                            <span>{t("doesNotCount")}</span>
                          )}
                          {attempt.attested ? (
                            <span>{t("attested")}</span>
                          ) : null}
                        </span>
                      </div>
                    </>
                  ) : null}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
