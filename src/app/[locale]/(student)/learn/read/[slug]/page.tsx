import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { after } from "next/server";
import { Markdown } from "@/components/learn/markdown";
import { ReaderShell } from "@/components/learn/reader-shell";
import { NotFoundError } from "@/lib/errors";
import { requireUser } from "@/server/auth/require-user";
import { learnService } from "@/server/services/learn";
import { schoolConfig } from "../../../../../../../config/school.config";

export async function generateMetadata({ params }: { params: Promise<{ locale: string; slug: string }> }) {
  const { locale, slug } = await params;
  const user = await requireUser();
  const doc = await learnService.reader(locale, user.id, slug).catch(() => null);
  return { title: doc ? `${doc.title} · ${schoolConfig.school.name}` : schoolConfig.school.name };
}

/** The reader (spec-23): server-rendered markdown inside the client shell that tracks progress. */
export default async function ReaderPage({ params }: { params: Promise<{ locale: string; slug: string }> }) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  if (!schoolConfig.featureFlags.learn) notFound();
  const user = await requireUser();
  const doc = await learnService.reader(locale, user.id, slug).catch((error) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const [t, book] = await Promise.all([
    getTranslations("learn"),
    doc.book ? learnService.bookPage(locale, user.id, doc.book.slug) : Promise.resolve(null),
  ]);
  after(() => learnService.touchOpened(user.id, doc.id));

  return (
    <ReaderShell
      doc={doc}
      chapters={(book?.chapters ?? []).map((c) => ({ slug: c.slug, title: c.title, chapterOrder: c.chapterOrder, readAt: Boolean(c.readAt) }))}
    >
      <article className="pt-5">
        <header className="space-y-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {doc.book ? `${doc.book.title} · ${t("chapterOf", { n: doc.book.chapterOrder, total: doc.book.chapterCount })}` : doc.topic.name}
          </p>
          <h1 className="text-[1.75rem] font-bold leading-[1.15] tracking-[-0.025em] text-foreground text-pretty">{doc.title}</h1>
          {doc.summary ? <p className="text-[1.0625rem]/relaxed text-muted-foreground">{doc.summary}</p> : null}
          <p className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
            <span>{t("readMinutes", { minutes: doc.readMinutes })}</span>
            {doc.progress.updatedSinceRead ? <span>· {t("updatedSinceRead")}</span> : null}
            {!doc.inLocale ? <span>· {t("notInLocale")}</span> : null}
          </p>
          {doc.heroImageId ? (
            // eslint-disable-next-line @next/next/no-img-element -- app-served, private image route
            <img src={`/api/images/${doc.heroImageId}`} alt="" className="-mx-4 w-[calc(100%+2rem)] max-w-none bg-muted" />
          ) : null}
        </header>
        <div className="mt-6" lang={doc.servedLocale}>
          <Markdown source={doc.bodyMarkdown} />
        </div>
        {doc.citations.length > 0 ? (
          <footer className="mt-8 rounded-[calc(var(--radius-base)+6px)] bg-muted/60 p-4">
            <h2 className="text-sm font-semibold text-foreground">{t("sources")}</h2>
            <ul className="mt-1 space-y-0.5 text-sm text-muted-foreground">
              {doc.citations.map((c, i) => (
                <li key={i}>{t("sourceRef", { source: c.sourceName, ref: c.ref })}</li>
              ))}
            </ul>
          </footer>
        ) : null}
      </article>
    </ReaderShell>
  );
}
