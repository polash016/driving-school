import { getTranslations } from "next-intl/server";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { db } from "@/server/db";
import { translationsAcrossLanguages } from "@/server/services/i18n/review";

/**
 * One question in every language it exists in (spec-15).
 *
 * The point of this panel is a teacher who reads Arabic being able to check an Arabic question
 * against the English without hunting through a review queue for it. Rows are keyed by option key,
 * so a swapped or missing option is visible without reading a word.
 */
export async function QuestionLanguages({
  masterItemId,
  source,
}: {
  masterItemId: string;
  source: { stem: string; options: { key: string; text: string }[] };
}) {
  const [t, translations] = await Promise.all([
    getTranslations("admin.languages"),
    translationsAcrossLanguages(db, "MASTER_ITEM", masterItemId),
  ]);

  if (translations.length === 0) return null;

  return (
    <Card className="[--card-spacing:--spacing(4)]">
      <CardContent className="space-y-3">
        <h2 className="text-sm font-medium text-foreground">
          {t("inEveryLanguage")}
        </h2>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[36rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th
                  scope="col"
                  className="p-2 font-medium text-muted-foreground"
                >
                  {t("field")}
                </th>
                <th
                  scope="col"
                  className="p-2 font-medium text-muted-foreground"
                  lang="en"
                >
                  English
                </th>
                {translations.map((translation) => (
                  <th
                    key={translation.locale}
                    scope="col"
                    className="p-2 font-medium text-muted-foreground"
                    lang={translation.locale}
                  >
                    {translation.nativeName}
                    <span
                      className={cn(
                        "ms-1.5 rounded-full px-1.5 py-0.5 text-[0.625rem]",
                        translation.status === "APPROVED"
                          ? "bg-[var(--status-success-soft)] text-[var(--status-success)]"
                          : "bg-muted text-muted-foreground",
                      )}
                    >
                      {translation.status}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-border/60 align-top">
                <th
                  scope="row"
                  className="p-2 text-start font-normal text-muted-foreground"
                >
                  {t("stemRow")}
                </th>
                <td className="p-2 text-foreground" lang="en">
                  {source.stem}
                </td>
                {translations.map((translation) => {
                  const value = translation.value as { stem?: string };
                  return (
                    <td
                      key={translation.locale}
                      className="p-2 text-foreground"
                      lang={translation.locale}
                      dir={translation.direction === "RTL" ? "rtl" : "ltr"}
                    >
                      {value.stem ?? "—"}
                    </td>
                  );
                })}
              </tr>

              {/* Keyed off the source options, always: a translation cannot add or drop a row. */}
              {source.options.map((option) => (
                <tr
                  key={option.key}
                  className="border-b border-border/60 align-top"
                >
                  <th
                    scope="row"
                    className="p-2 text-start font-mono text-xs font-normal text-muted-foreground"
                  >
                    {option.key}
                  </th>
                  <td className="p-2 text-muted-foreground" lang="en">
                    {option.text}
                  </td>
                  {translations.map((translation) => {
                    const value = translation.value as {
                      options?: { key: string; text: string }[];
                    };
                    const text = value.options?.find(
                      (o) => o.key === option.key,
                    )?.text;
                    return (
                      <td
                        key={translation.locale}
                        className={cn(
                          "p-2",
                          text
                            ? "text-muted-foreground"
                            : "text-destructive italic",
                        )}
                        lang={translation.locale}
                        dir={translation.direction === "RTL" ? "rtl" : "ltr"}
                      >
                        {text ?? t("optionMissing")}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
