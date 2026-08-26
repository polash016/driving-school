import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Link } from "@/i18n/navigation";
import { pickBilingualText } from "@/lib/i18n-content";
import { requireUser } from "@/server/auth/require-user";
import { db } from "@/server/db";
import { ContextSheetPanel } from "@/components/admin/images/context-sheet";
import { contextSheetSchema } from "@/server/contracts/image-pipeline";
import type { AppLocale } from "../../../../../../../config/school.config";

/** One uploaded image, and what has been asked about it. */
export default async function ImageDetailPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  await requireUser("INSTRUCTOR");

  const [t, image, signRows] = await Promise.all([
    getTranslations("admin.images"),
    db.imageAsset.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        url: true,
        width: true,
        height: true,
        createdAt: true,
        exifStripped: true,
        aiContextSheet: true,
        contextVerifiedAt: true,
        uploadedBy: {
          select: {
            email: true,
            profile: { select: { firstName: true, lastName: true } },
          },
        },
        // "Questions generated from this image" — served by MasterItem_sourceImageId_idx.
        masterItems: {
          where: { deletedAt: null },
          select: { id: true, status: true, type: true, content: true },
          orderBy: { createdAt: "desc" },
          take: 50,
        },
      },
    }),
    db.sign.findMany({
      where: { isActive: true },
      select: { code: true, name: true },
      orderBy: { code: "asc" },
    }),
  ]);

  if (!image) notFound();

  // A malformed stored sheet must not take the page down — it is redrawn by re-extracting.
  const parsed = contextSheetSchema.safeParse(image.aiContextSheet);
  const signOptions = signRows.map((sign) => ({
    code: sign.code,
    name: (sign.name as { en?: string }).en ?? sign.code,
  }));

  const profile = image.uploadedBy?.profile;
  const uploaderName = profile
    ? `${profile.firstName} ${profile.lastName}`
    : (image.uploadedBy?.email ?? "—");

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-4 py-8">
      <header className="space-y-1.5">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {t("title")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("uploadedBy", {
            name: uploaderName,
          })}
          {" · "}
          {t("dimensions", {
            width: image.width ?? 0,
            height: image.height ?? 0,
          })}
        </p>
      </header>

      <Card>
        <CardContent>
          {/* eslint-disable-next-line @next/next/no-img-element -- authenticated app route */}
          <img
            src={image.url}
            alt=""
            className="max-h-[28rem] w-full rounded-[var(--radius-base)] bg-muted object-contain"
          />
        </CardContent>
      </Card>

      <ContextSheetPanel
        imageAssetId={image.id}
        imageUrl={image.url}
        sheet={parsed.success ? parsed.data : null}
        verified={Boolean(image.contextVerifiedAt)}
        signOptions={signOptions}
      />

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-foreground">
          {t("questionsFromImage")}
        </h2>
        {image.masterItems.length === 0 ? (
          <p className="text-sm/relaxed text-muted-foreground">
            {t("noQuestions")}
          </p>
        ) : (
          <ul className="space-y-1.5">
            {image.masterItems.map((item) => {
              const content = item.content as {
                en?: { stem?: string };
                nb?: { stem?: string };
              } | null;
              return (
                <li key={item.id}>
                  <Link
                    href={`/admin/questions/${item.id}`}
                    className="flex min-h-11 items-center justify-between gap-3 rounded-[var(--radius-control)] px-3 py-2 text-sm ring-1 ring-border hover:bg-muted"
                  >
                    <span className="line-clamp-1 text-foreground">
                      {pickBilingualText(
                        {
                          en: content?.en?.stem ?? "",
                          nb: content?.nb?.stem ?? "",
                        },
                        locale as AppLocale,
                      )}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {item.status}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
