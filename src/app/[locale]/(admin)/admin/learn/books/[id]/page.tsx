import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { BookForm } from "@/components/admin/learn/book-form";
import { ChapterOrderList } from "@/components/admin/learn/chapter-order-list";
import { StatusBadge } from "@/components/admin/learn/status-badge";
import { TransitionButtons } from "@/components/admin/learn/transition-buttons";
import { pickBilingualText } from "@/lib/i18n-content";
import { NotFoundError } from "@/lib/errors";
import { requireUser } from "@/server/auth/require-user";
import { db } from "@/server/db";
import { listPickableImages } from "@/server/services/images/library";
import { learnService } from "@/server/services/learn";
import { schoolConfig } from "../../../../../../../../config/school.config";

export default async function EditBookPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  if (!schoolConfig.featureFlags.learn) notFound();
  const user = await requireUser("INSTRUCTOR");
  const book = await learnService.getBookAdmin(id).catch((error) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const [t, images, licenseClasses] = await Promise.all([
    getTranslations("admin.learn"),
    listPickableImages(db),
    db.licenseClass.findMany({ where: { isEnabled: true }, select: { id: true, code: true }, orderBy: { code: "asc" } }),
  ]);
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{pickBilingualText(book.title, locale)}</h1>
          <StatusBadge status={book.status} />
        </div>
        <TransitionButtons entity="BOOK" id={book.id} status={book.status} canDelete={user.role === "ADMIN"} />
      </header>
      <ChapterOrderList key={book.chapters.map((c) => c.id).join(",")} book={book} locale={locale} />
      <h2 className="sr-only">{t("book.heading")}</h2>
      <BookForm book={book} images={images} licenseClasses={licenseClasses} />
    </div>
  );
}
