import { CheckCircleIcon } from "@phosphor-icons/react/dist/ssr";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { NotFoundError } from "@/lib/errors";
import { requireUser } from "@/server/auth/require-user";
import { learnService } from "@/server/services/learn";
import { schoolConfig } from "../../../../../../../config/school.config";

export default async function BookPage({ params }: { params: Promise<{ locale: string; slug: string }> }) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  if (!schoolConfig.featureFlags.learn) notFound();
  const user = await requireUser();
  const page = await learnService.bookPage(locale, user.id, slug).catch((error) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const t = await getTranslations("learn");
  const pct = page.chapters.length === 0 ? 0 : Math.round((page.readCount / page.chapters.length) * 100);

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col gap-5 px-4 py-6">
      <Link href="/learn" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
        ← {t("backToHub")}
      </Link>
      <header className="flex gap-4">
        <div className="aspect-[2/3] w-24 shrink-0 overflow-hidden rounded-[var(--radius-control)] bg-muted">
          {page.book.coverImageId ? (
            // eslint-disable-next-line @next/next/no-img-element -- app-served, private image route
            <img src={`/api/images/${page.book.coverImageId}`} alt={t("bookCover", { title: page.book.title })} className="size-full object-cover" />
          ) : (
            <div className="size-full" style={{ backgroundImage: "var(--gradient-hero)" }} aria-hidden />
          )}
        </div>
        <div className="min-w-0 space-y-1.5">
          <h1 className="text-[1.4rem] font-bold leading-tight tracking-[-0.02em] text-foreground">{page.book.title}</h1>
          {page.book.description ? <p className="text-sm/relaxed text-muted-foreground">{page.book.description}</p> : null}
          {!page.book.inLocale ? <p className="text-xs text-muted-foreground">{t("notInLocale")}</p> : null}
        </div>
      </header>

      {page.chapters.length > 0 ? (
        <section className="glass space-y-2 rounded-[calc(var(--radius-base)+6px)] p-4">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={t("chaptersRead", { read: page.readCount, total: page.chapters.length })}>
            <div className="h-full rounded-full bg-[var(--status-success)]" style={{ width: `${pct}%` }} />
          </div>
          <p className="text-xs text-muted-foreground">{t("chaptersRead", { read: page.readCount, total: page.chapters.length })}</p>
          {page.nextUnreadSlug ? (
            <Button asChild size="lg" className="w-full">
              <Link href={`/learn/read/${page.nextUnreadSlug}`}>{page.readCount === 0 ? t("startReading") : t("continueBook")}</Link>
            </Button>
          ) : null}
        </section>
      ) : (
        <p className="text-sm text-muted-foreground">{t("emptyTopic")}</p>
      )}

      <ol aria-label={t("chapterList")} className="glass divide-y divide-border rounded-[calc(var(--radius-base)+6px)]">
        {page.chapters.map((chapter) => (
          <li key={chapter.id}>
            <Link href={`/learn/read/${chapter.slug}`} className="flex min-h-14 items-center gap-3 px-4 py-2 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]">
              <span className="w-6 text-sm tabular-nums text-muted-foreground">{chapter.chapterOrder}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-medium text-foreground">{chapter.title}</span>
                <span className="block text-xs text-muted-foreground">{t("readMinutes", { minutes: chapter.readMinutes })}</span>
              </span>
              {chapter.readAt ? (
                <CheckCircleIcon weight="fill" className="size-5 text-[var(--status-success)]" aria-label={t("markedRead")} />
              ) : chapter.positionPct > 0 ? (
                <span className="text-xs tabular-nums text-muted-foreground">{chapter.positionPct}%</span>
              ) : null}
            </Link>
          </li>
        ))}
      </ol>
    </div>
  );
}
