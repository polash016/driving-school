import { getTranslations, setRequestLocale } from "next-intl/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/server/auth/require-user";
import { db } from "@/server/db";
import { accuracyStats } from "@/server/services/question-bank/stats";

/**
 * AI accuracy (spec-04 amendment): how often a human keeps what the AI wrote, by model, prompt
 * version or topic — and the ranked reasons behind rejections.
 */
export default async function AccuracyPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ groupBy?: string; sinceDays?: string }>;
}) {
  const [{ locale }, query] = await Promise.all([params, searchParams]);
  setRequestLocale(locale);
  await requireUser("INSTRUCTOR");

  const groupBy = ["model", "prompt", "topic"].includes(query.groupBy ?? "")
    ? (query.groupBy as "model" | "prompt" | "topic")
    : "model";
  const sinceDays = Number(query.sinceDays ?? 90);

  const [t, stats] = await Promise.all([
    getTranslations("admin.accuracy"),
    accuracyStats(db, { groupBy, sinceDays }),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-8">
      <header className="space-y-1.5">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">{t("title")}</h1>
        <p className="text-sm/relaxed text-muted-foreground">{t("subtitle")}</p>
      </header>

      <form className="flex flex-wrap items-end gap-3">
        <label className="space-y-1.5 text-sm font-medium">
          {t("groupBy")}
          <select
            name="groupBy"
            defaultValue={groupBy}
            className="h-11 w-full rounded-[var(--radius-control)] border border-input bg-transparent px-3 text-sm"
          >
            <option value="model">{t("groupModel")}</option>
            <option value="prompt">{t("groupPrompt")}</option>
            <option value="topic">{t("groupTopic")}</option>
          </select>
        </label>
        <label className="space-y-1.5 text-sm font-medium">
          {t("window")}
          <select
            name="sinceDays"
            defaultValue={String(sinceDays)}
            className="h-11 w-full rounded-[var(--radius-control)] border border-input bg-transparent px-3 text-sm"
          >
            {[7, 30, 90, 365].map((days) => (
              <option key={days} value={days}>
                {t("days", { days })}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="inline-flex min-h-11 items-center rounded-[var(--radius-control)] bg-primary px-4 text-sm font-medium text-primary-foreground"
        >
          {t("groupBy")}
        </button>
      </form>

      {stats.rows.length === 0 ? (
        <p className="rounded-[var(--radius-base)] border border-dashed border-border p-8 text-center text-muted-foreground">
          {t("empty")}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-[var(--radius-base)] bg-card shadow-card ring-1 ring-foreground/5">
          <table className="w-full min-w-[42rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th scope="col" className="p-3 font-medium">{t("columnKey")}</th>
                <th scope="col" className="p-3 font-medium">{t("columnReviewed")}</th>
                <th scope="col" className="p-3 font-medium">{t("columnApproved")}</th>
                <th scope="col" className="p-3 font-medium">{t("columnRate")}</th>
                <th scope="col" className="p-3 font-medium">{t("columnMedian")}</th>
              </tr>
            </thead>
            <tbody>
              {stats.rows.map((row) => (
                <tr key={row.key} className="border-b border-border/60 last:border-0">
                  <td className="p-3 font-medium text-foreground">{row.label}</td>
                  <td className="p-3 text-muted-foreground">{row.reviewed}</td>
                  <td className="p-3 text-muted-foreground">{row.approved}</td>
                  <td className="p-3">
                    <span className="font-medium text-foreground">
                      {Math.round(row.rate * 100)}%
                    </span>
                  </td>
                  <td className="p-3 text-muted-foreground">
                    {row.medianHoursToReview === null
                      ? "—"
                      : t("hours", { hours: Math.round(row.medianHoursToReview) })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="grid gap-5 md:grid-cols-2">
        <Card className="[--card-spacing:--spacing(5)]">
          <CardHeader>
            <CardTitle className="text-base">{t("reasonsTitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            {stats.reasons.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("noReasons")}</p>
            ) : (
              <ul className="space-y-2">
                {stats.reasons.map((reason) => (
                  <li key={reason.reason} className="flex items-center justify-between gap-3">
                    <span className="text-sm text-foreground">{reason.reason}</span>
                    <span className="text-sm text-muted-foreground">{reason.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card className="[--card-spacing:--spacing(5)]">
          <CardHeader>
            <CardTitle className="text-base">{t("totalsTitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              {Object.entries(stats.totals).map(([key, value]) => (
                <li key={key} className="flex items-center justify-between gap-3">
                  <span className="text-foreground">{key}</span>
                  <span className="text-muted-foreground">{value}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
