import { getTranslations, setRequestLocale } from "next-intl/server";
import { ChangePasswordForm } from "@/components/auth/change-password-form";
import { SessionList } from "@/components/auth/session-list";
import { TwoFactorCard } from "@/components/auth/two-factor-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getCurrentSessionId } from "@/server/auth";
import { requireUser } from "@/server/auth/require-user";
import { db } from "@/server/db";
import { listSessions } from "@/server/services/auth/sessions";

/** Account security: password, two-factor, and the devices holding a session. */
export default async function SecurityPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const user = await requireUser();
  const [t, currentSessionId] = await Promise.all([
    getTranslations("auth.account"),
    getCurrentSessionId(),
  ]);

  const [sessions, account] = await Promise.all([
    listSessions(db, user.id, currentSessionId),
    db.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { totpSecret: true },
    }),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-5 px-4 py-8">
      <header className="space-y-1.5">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {t("securityTitle")}
        </h1>
        <p className="text-sm/relaxed text-muted-foreground">
          {t("securitySubtitle")}
        </p>
      </header>

      <Card className="[--card-spacing:--spacing(5)]">
        <CardHeader>
          <CardTitle className="text-base">{t("passwordTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <ChangePasswordForm />
        </CardContent>
      </Card>

      <Card className="[--card-spacing:--spacing(5)]">
        <CardHeader>
          <CardTitle className="text-base">{t("twoFactorTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <TwoFactorCard
            enabled={Boolean(account.totpSecret)}
            required={user.role === "ADMIN"}
          />
        </CardContent>
      </Card>

      <Card className="[--card-spacing:--spacing(5)]">
        <CardHeader>
          <CardTitle className="text-base">{t("sessionsTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <SessionList sessions={sessions} />
        </CardContent>
      </Card>
    </div>
  );
}
