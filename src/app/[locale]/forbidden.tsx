import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";

/**
 * 403 boundary (Next `forbidden()`, enabled by experimental.authInterrupts).
 * Reached when a signed-in user lacks the role a route requires — spec-03 acceptance.
 */
export default function ForbiddenPage() {
  const t = useTranslations("errors");

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-4 px-4 py-10 text-center">
      <h1 className="text-xl font-semibold text-foreground">
        {t("forbiddenTitle")}
      </h1>
      <p className="text-muted-foreground">{t("forbiddenDescription")}</p>
      <Button asChild>
        <Link href="/">{t("goHome")}</Link>
      </Button>
    </div>
  );
}
