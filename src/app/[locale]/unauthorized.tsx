import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";

/** 401 boundary (Next `unauthorized()`): the route needs a session and there is none. */
export default function UnauthorizedPage() {
  const t = useTranslations("errors");

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-4 px-4 py-10 text-center">
      <h1 className="text-xl font-semibold text-foreground">
        {t("unauthorizedTitle")}
      </h1>
      <p className="text-muted-foreground">{t("unauthorizedDescription")}</p>
      <Button asChild>
        <Link href="/login">{t("goToLogin")}</Link>
      </Button>
    </div>
  );
}
