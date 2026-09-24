import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { BookForm } from "@/components/admin/learn/book-form";
import { requireUser } from "@/server/auth/require-user";
import { db } from "@/server/db";
import { listPickableImages } from "@/server/services/images/library";
import { schoolConfig } from "../../../../../../../../config/school.config";

export default async function NewBookPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  if (!schoolConfig.featureFlags.learn) notFound();
  await requireUser("INSTRUCTOR");
  const [t, images, licenseClasses] = await Promise.all([
    getTranslations("admin.learn"),
    listPickableImages(db),
    db.licenseClass.findMany({ where: { isEnabled: true }, select: { id: true, code: true }, orderBy: { code: "asc" } }),
  ]);
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t("newBook")}</h1>
      <BookForm book={null} images={images} licenseClasses={licenseClasses} />
    </div>
  );
}
