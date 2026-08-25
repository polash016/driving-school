import { getTranslations, setRequestLocale } from "next-intl/server";
import { SignRow, type EditableSign } from "@/components/admin/signs/sign-row";
import { Card, CardContent } from "@/components/ui/card";
import { Link } from "@/i18n/navigation";
import { requireUser } from "@/server/auth/require-user";
import { db } from "@/server/db";

/**
 * The sign registry, and the queue of rows a person still has to vouch for.
 *
 * `?review=1` narrows the list to provisional rows. That is the working view: the registry is
 * seeded wholesale from an extracted source, so "what has nobody checked yet" is the question a
 * reviewer actually opens this page with.
 */
export default async function SignsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ review?: string; q?: string }>;
}) {
  const { locale } = await params;
  const { review, q } = await searchParams;
  setRequestLocale(locale);
  await requireUser("INSTRUCTOR");

  const provisionalOnly = review === "1";
  const query = (q ?? "").trim();

  const [t, signs, total] = await Promise.all([
    getTranslations("admin.signs"),
    // Ordered by class then code so a reviewer works through one sign group at a time, which is
    // how the source material is organised. Served by Sign_signClass_idx.
    db.sign.findMany({
      where: {
        ...(provisionalOnly ? { provisional: true } : {}),
        ...(query
          ? {
              OR: [
                { code: { contains: query, mode: "insensitive" as const } },
                { name: { path: ["en"], string_contains: query } },
                { name: { path: ["nb"], string_contains: query } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        code: true,
        signClass: true,
        svgPath: true,
        name: true,
        meaning: true,
        isActive: true,
        provisional: true,
        sourceNote: true,
      },
      orderBy: [{ signClass: "asc" }, { code: "asc" }],
      take: 400,
    }),
    db.sign.count(),
  ]);

  const rows: EditableSign[] = signs.map((sign) => {
    const name = sign.name as { en?: string; nb?: string } | null;
    const meaning = sign.meaning as { en?: string; nb?: string } | null;
    return {
      id: sign.id,
      code: sign.code,
      signClass: sign.signClass,
      svgPath: sign.svgPath,
      nameEn: name?.en ?? "",
      nameNb: name?.nb ?? "",
      meaningEn: meaning?.en ?? "",
      meaningNb: meaning?.nb ?? "",
      isActive: sign.isActive,
      provisional: sign.provisional,
      sourceNote: sign.sourceNote,
    };
  });

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-8">
      <header className="space-y-1.5">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {t("title")}
        </h1>
        <p className="text-sm/relaxed text-muted-foreground">{t("subtitle")}</p>
      </header>

      {total === 0 ? (
        <Card>
          <CardContent className="space-y-2 text-center">
            <p className="font-medium text-foreground">{t("empty")}</p>
            <p className="text-sm/relaxed text-muted-foreground">
              {t("emptyBody")}
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <nav className="flex gap-1" aria-label={t("title")}>
              {(
                [
                  {
                    key: "all",
                    href: "/admin/signs",
                    active: !provisionalOnly,
                  },
                  {
                    key: "provisionalOnly",
                    href: "/admin/signs?review=1",
                    active: provisionalOnly,
                  },
                ] as const
              ).map((tab) => (
                <Link
                  key={tab.key}
                  href={tab.href}
                  aria-current={tab.active ? "page" : undefined}
                  className={`inline-flex min-h-11 items-center rounded-[var(--radius-control)] px-3 text-sm font-medium transition-colors ${
                    tab.active
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  }`}
                >
                  {t(tab.key)}
                </Link>
              ))}
            </nav>
            <form className="flex gap-2">
              {provisionalOnly ? (
                <input type="hidden" name="review" value="1" />
              ) : null}
              <input
                type="search"
                name="q"
                defaultValue={query}
                aria-label={t("search")}
                placeholder={t("search")}
                className="h-11 rounded-[var(--radius-control)] border border-input bg-transparent px-3 text-sm"
              />
            </form>
          </div>

          <p className="text-xs text-muted-foreground" role="status">
            {t("count", { shown: rows.length, total })}
          </p>

          <ul className="space-y-2">
            {rows.map((sign) => (
              <SignRow key={sign.id} sign={sign} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
