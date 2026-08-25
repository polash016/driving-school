import { getTranslations } from "next-intl/server";
import { logoutAction } from "@/app/[locale]/(auth)/actions";
import { Button } from "@/components/ui/button";
import { getSessionUser } from "@/server/auth";
import { Link } from "@/i18n/navigation";

/**
 * Header auth affordance: a way in when signed out, and a way to the account (and out) when
 * signed in. Rendered on the server so no session detail reaches the client bundle.
 */
export async function AccountMenu({ locale }: { locale: string }) {
  const [user, t] = await Promise.all([
    getSessionUser(),
    getTranslations("nav"),
  ]);

  if (!user) {
    return (
      <Button asChild variant="ghost" size="sm" className="min-h-11">
        <Link href="/login">{t("login")}</Link>
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-1">
      {user.role !== "STUDENT" ? (
        <Button asChild variant="ghost" size="sm" className="min-h-11">
          <Link href="/admin/invites">{t("admin")}</Link>
        </Button>
      ) : null}
      <Button asChild variant="ghost" size="sm" className="min-h-11">
        <Link href="/account/history">{t("history")}</Link>
      </Button>
      <Button asChild variant="ghost" size="sm" className="min-h-11">
        <Link href="/account/security">{t("account")}</Link>
      </Button>
      <form action={logoutAction}>
        <input type="hidden" name="locale" value={locale} />
        <Button type="submit" variant="ghost" size="sm" className="min-h-11">
          {t("logout")}
        </Button>
      </form>
    </div>
  );
}
