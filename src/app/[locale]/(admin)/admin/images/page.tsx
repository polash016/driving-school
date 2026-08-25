import { getTranslations, setRequestLocale } from "next-intl/server";
import { UploadForm } from "@/components/admin/images/upload-form";
import { Card, CardContent } from "@/components/ui/card";
import { Link } from "@/i18n/navigation";
import { requireUser } from "@/server/auth/require-user";
import { db } from "@/server/db";
import { schoolConfig } from "../../../../../../config/school.config";

/**
 * The image library (spec-06).
 *
 * Registry-backed sign graphics are deliberately NOT listed here: they are managed in
 * /admin/signs, where a person can correct the name and meaning that make them useful. This page
 * is for photographs a school uploads.
 */
export default async function ImagesPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireUser("INSTRUCTOR");

  const [t, images] = await Promise.all([
    getTranslations("admin.images"),
    // Served by ImageAsset_status_createdAt_idx. Sign assets live under a `signs/` key prefix and
    // belong to the registry screen, so they are excluded here.
    db.imageAsset.findMany({
      where: {
        deletedAt: null,
        NOT: { storagePath: { startsWith: "signs/" } },
      },
      select: {
        id: true,
        url: true,
        width: true,
        height: true,
        createdAt: true,
        _count: { select: { masterItems: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 120,
    }),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-8">
      <header className="space-y-1.5">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {t("title")}
        </h1>
        <p className="text-sm/relaxed text-muted-foreground">{t("subtitle")}</p>
      </header>

      <UploadForm
        accept="image/jpeg,image/png,image/webp"
        maxMb={Math.round(schoolConfig.storage.maxUploadBytes / (1024 * 1024))}
        maxBatch={schoolConfig.storage.maxBatch}
      />

      {images.length === 0 ? (
        <Card>
          <CardContent className="space-y-2 text-center">
            <p className="font-medium text-foreground">{t("empty")}</p>
            <p className="text-sm/relaxed text-muted-foreground">
              {t("emptyBody")}
            </p>
          </CardContent>
        </Card>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {images.map((image) => (
            <li key={image.id}>
              <Link
                href={`/admin/images/${image.id}`}
                className="block rounded-[var(--radius-base)] ring-1 ring-border transition-colors hover:ring-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- authenticated app route, not a static asset */}
                <img
                  src={image.url}
                  alt=""
                  loading="lazy"
                  className="h-32 w-full rounded-t-[var(--radius-base)] bg-muted object-cover"
                />
                <div className="space-y-0.5 px-2.5 py-2 text-xs text-muted-foreground">
                  <p>
                    {t("dimensions", {
                      width: image.width ?? 0,
                      height: image.height ?? 0,
                    })}
                  </p>
                  <p>
                    {image._count.masterItems > 0
                      ? t("questionsFromImage")
                      : t("noQuestions")}
                  </p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
