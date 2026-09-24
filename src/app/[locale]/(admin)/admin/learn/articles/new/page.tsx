import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { DocumentEditor } from "@/components/admin/learn/document-editor";
import { pickBilingualText } from "@/lib/i18n-content";
import { requireUser } from "@/server/auth/require-user";
import { db } from "@/server/db";
import { schoolConfig } from "../../../../../../../../config/school.config";
import { editorData } from "../_shared";

export default async function NewDocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const [{ locale }, query] = await Promise.all([params, searchParams]);
  setRequestLocale(locale);
  if (!schoolConfig.featureFlags.learn) notFound();
  await requireUser("INSTRUCTOR");

  const kind = query.kind === "CHAPTER" && query.bookId ? ("CHAPTER" as const) : ("ARTICLE" as const);
  const book =
    kind === "CHAPTER"
      ? await db.learnBook.findFirst({ where: { id: query.bookId!, deletedAt: null }, select: { id: true, title: true } })
      : null;
  if (kind === "CHAPTER" && !book) notFound();

  const [t, data] = await Promise.all([getTranslations("admin.learn"), editorData(locale)]);
  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 px-4 py-6">
      <h1 className="text-2xl font-semibold tracking-tight">{kind === "CHAPTER" ? t("newChapter") : t("newArticle")}</h1>
      <DocumentEditor
        document={null}
        defaults={{ kind, bookId: book?.id ?? null, bookTitle: book ? pickBilingualText(book.title, locale) : null }}
        readingWpm={schoolConfig.learn.readingWpm}
        {...data}
      />
    </div>
  );
}
