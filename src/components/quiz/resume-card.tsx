import { getTranslations } from "next-intl/server";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Link } from "@/i18n/navigation";
import type { ResumableAttempt } from "@/server/services/assessment/history";

/**
 * The test the student walked away from.
 *
 * Every answer is written the moment it is given, so nothing was lost — this card only has to
 * find the attempt and say where they got to. It sits above the start tiles on purpose: finishing
 * something already begun beats starting a fourth half-done test.
 */
export async function ResumeCard({ attempt }: { attempt: ResumableAttempt }) {
  const [t, tHistory] = await Promise.all([
    getTranslations("home"),
    getTranslations("history"),
  ]);

  const progress = Math.round(
    (attempt.answeredCount / attempt.questionCount) * 100,
  );
  const minutesLeft =
    attempt.timeRemainingSec === null
      ? null
      : Math.ceil(attempt.timeRemainingSec / 60);

  return (
    <Card className="border-primary/30 bg-accent/40">
      <CardContent className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-0.5">
            <p className="text-sm font-medium text-foreground">
              {t("inProgressTitle")}
            </p>
            <p className="text-xs text-muted-foreground">
              {tHistory(`kind.${attempt.kind}`)}
              {minutesLeft !== null
                ? ` · ${t("timeLeft", { minutes: minutesLeft })}`
                : ""}
            </p>
          </div>
          <p className="shrink-0 text-sm font-semibold tabular-nums text-foreground">
            {attempt.answeredCount}/{attempt.questionCount}
          </p>
        </div>

        <div
          className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuenow={attempt.answeredCount}
          aria-valuemin={0}
          aria-valuemax={attempt.questionCount}
          aria-label={t("inProgressProgress", {
            answered: attempt.answeredCount,
            total: attempt.questionCount,
          })}
        >
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>

        <Button asChild size="lg" className="w-full">
          <Link href={`/quiz/${attempt.id}`}>{t("continueTest")}</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
