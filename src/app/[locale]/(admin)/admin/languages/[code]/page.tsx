import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import {
  TranslationReview,
  type ReviewRow,
} from "@/components/admin/languages/translation-review";
import { Card, CardContent } from "@/components/ui/card";
import { Link } from "@/i18n/navigation";
import { requireUser } from "@/server/auth/require-user";
import { db } from "@/server/db";
import { languageCoverage } from "@/server/services/i18n/languages";
import { reviewQueue } from "@/server/services/i18n/review";

/**
 * One language: what still needs a human, and how far along it is.
 *
 * INSTRUCTOR, not ADMIN — the person who can judge a translation is whoever speaks the language,
 * and that is usually a teacher rather than whoever holds the admin account.
 */
export default async function LanguageReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; code: string }>;
  searchParams: Promise<{ flagged?: string }>;
}) {
  const { locale, code } = await params;
  const query = await searchParams;
  setRequestLocale(locale);
  await requireUser("INSTRUCTOR");

  const language = await db.language.findUnique({
    where: { code },
    select: { code: true, englishName: true, nativeName: true, direction: true, isBuiltIn: true },
  });
  if (!language || language.isBuiltIn) notFound();

  const [t, coverage, queue] = await Promise.all([
    getTranslations("admin.languages"),
    languageCoverage(db, code),
    reviewQueue(db, code, { limit: 30, onlyFlagged: query.flagged === "1" }),
  ]);

  const rows: ReviewRow[] = queue.map((item) => ({
    id: item.id,
    entity: item.entity,
    entityId: item.entityId,
    status: item.status,
    label: item.label,
    qaFlags: item.qaFlags,
    semanticScore: item.semanticScore,
    source: (item.source ?? null) as unknown as Record<string, unknown> | null,
    value: item.value as unknown as Record<string, unknown>,
  }));

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-8">
      <header className="space-y-1.5">
        <Link
          href="/admin/languages"
          className="inline-flex min-h-11 items-center text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          {t("backToLanguages")}
        </Link>
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {language.nativeName}{" "}
          <span className="text-base font-normal text-muted-foreground">
            {language.englishName}
          </span>
        </h1>
        <p className="text-sm/relaxed text-muted-foreground">{t("reviewSubtitle")}</p>
      </header>

      <Card className="[--card-spacing:--spacing(4)]">
        <CardContent className="space-y-2">
          <p className="text-sm text-foreground">
            {t("coverageCount", { ready: coverage.ready, total: coverage.total })} ·{" "}
            {coverage.percent}%
            {coverage.flagged > 0
              ? ` · ${t("flaggedCount", { count: coverage.flagged })}`
              : ""}
          </p>
          <ul className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-3">
            {coverage.byEntity.map((entry) => (
              <li key={entry.entity} className="tabular-nums">
                {entry.entity}: {entry.translated}/{entry.total}
                {entry.flagged > 0 ? ` (${entry.flagged} flagged)` : ""}
              </li>
            ))}
          </ul>
          <p className="flex gap-3 pt-1 text-sm">
            <Link
              href={`/admin/languages/${code}`}
              className="text-primary underline-offset-4 hover:underline"
            >
              {t("filterAll")}
            </Link>
            <Link
              href={`/admin/languages/${code}?flagged=1`}
              className="text-primary underline-offset-4 hover:underline"
            >
              {t("filterFlagged")}
            </Link>
          </p>
        </CardContent>
      </Card>

      <TranslationReview
        code={code}
        direction={language.direction === "RTL" ? "RTL" : "LTR"}
        rows={rows}
      />
    </div>
  );
}
