import { getTranslations } from "next-intl/server";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { CategoryPerformance } from "@/server/services/assessment/history";

/**
 * How the student is doing in each category, from the tests they have sat.
 *
 * Deliberately shows every category, including untested ones: the gaps are the useful part. And
 * it shows the counts next to the percentage, because "1 of 2 correct" and "34 of 68 correct" are
 * both 50% and mean entirely different things — a bar on its own would overstate what one or two
 * answered questions can tell you.
 */
export async function CategoryProgress({
  categories,
}: {
  categories: CategoryPerformance[];
}) {
  const t = await getTranslations("home");
  if (categories.length === 0) return null;

  const anyData = categories.some((category) => category.answered > 0);

  return (
    <section className="space-y-2">
      <div className="space-y-0.5">
        <h2 className="text-sm font-medium text-foreground">
          {t("categoryTitle")}
        </h2>
        <p className="text-xs text-muted-foreground">{t("categorySubtitle")}</p>
      </div>

      <Card className="[--card-spacing:--spacing(4)]">
        <CardContent className="space-y-3">
          {!anyData ? (
            <p className="text-sm text-muted-foreground">
              {t("categoryNothingYet")}
            </p>
          ) : null}

          <ul className="space-y-2.5">
            {categories.map((category) => (
              <li key={category.topicSlug} className="space-y-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm text-foreground">
                    {category.topicName}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {category.percent === null
                      ? t("categoryEmpty")
                      : `${category.percent}% · ${t("categoryScore", {
                          correct: category.correct,
                          answered: category.answered,
                        })}`}
                  </span>
                </div>
                <div
                  className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                  role="progressbar"
                  aria-valuenow={category.percent ?? 0}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={category.topicName}
                >
                  <div
                    className={cn(
                      "h-full rounded-full transition-[width] duration-300",
                      category.percent === null
                        ? "bg-transparent"
                        : category.percent >= 80
                          ? "bg-[var(--status-success)]"
                          : category.percent >= 50
                            ? "bg-primary"
                            : "bg-destructive",
                    )}
                    style={{ width: `${category.percent ?? 0}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </section>
  );
}
