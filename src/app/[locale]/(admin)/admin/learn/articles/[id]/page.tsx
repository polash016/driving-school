import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { DocumentEditor } from "@/components/admin/learn/document-editor";
import { StatusBadge } from "@/components/admin/learn/status-badge";
import { TransitionButtons } from "@/components/admin/learn/transition-buttons";
import { Link } from "@/i18n/navigation";
import { NotFoundError } from "@/lib/errors";
import { pickBilingualText } from "@/lib/i18n-content";
import { requireUser } from "@/server/auth/require-user";
import { learnService } from "@/server/services/learn";
import { schoolConfig } from "../../../../../../../../config/school.config";
import { editorData } from "../_shared";

export default async function EditDocumentPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  if (!schoolConfig.featureFlags.learn) notFound();
  const user = await requireUser("INSTRUCTOR");
  const document = await learnService.getDocumentAdmin(id).catch((error) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const [t, data] = await Promise.all([getTranslations("admin.learn"), editorData(locale)]);
  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 px-4 py-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{pickBilingualText(document.title, locale)}</h1>
          <StatusBadge status={document.status} />
          {document.createdBy === "AI" ? <span className="text-xs text-muted-foreground">{t("doc.provenanceAi")}</span> : null}
          {document.book ? (
            <Link href={`/admin/learn/books/${document.book.id}`} className="text-sm underline-offset-4 hover:underline">
              {pickBilingualText(document.book.title, locale)}
            </Link>
          ) : null}
        </div>
        <TransitionButtons entity="DOCUMENT" id={document.id} status={document.status} canDelete={user.role === "ADMIN"} />
      </header>
      <DocumentEditor
        document={document}
        defaults={{ kind: document.kind, bookId: document.bookId, bookTitle: document.book ? pickBilingualText(document.book.title, locale) : null }}
        readingWpm={schoolConfig.learn.readingWpm}
        draftDefaultWords={schoolConfig.learn.draftDefaultWords}
        {...data}
      />
    </div>
  );
}
