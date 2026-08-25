import { getTranslations, setRequestLocale } from "next-intl/server";
import { CsvImportForm } from "@/components/admin/csv-import-form";
import { InviteCreateForm } from "@/components/admin/invite-create-form";
import { InviteList } from "@/components/admin/invite-list";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/server/auth/require-user";
import { db } from "@/server/db";
import { listInvites } from "@/server/services/auth/invites";
import { listGroupOptions } from "@/server/services/groups";
import type { AppLocale } from "../../../../../../config/school.config";

/**
 * Minimal invite administration (spec-03, DECISIONS 2026-08-24): enough to onboard a class
 * today. Desktop-first — the 390px rule covers the student panel, not the admin panel.
 * Spec-11 restyles this and adds the rest of the admin surface.
 */
export default async function AdminInvitesPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireUser("ADMIN");

  const [t, invites, groups] = await Promise.all([
    getTranslations("admin.invites"),
    listInvites(db, { page: 1, pageSize: 20 }, locale as AppLocale),
    listGroupOptions(db),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-8">
      <header className="space-y-1.5">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {t("title")}
        </h1>
        <p className="text-sm/relaxed text-muted-foreground">{t("subtitle")}</p>
      </header>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="[--card-spacing:--spacing(5)]">
          <CardHeader>
            <CardTitle className="text-base">{t("createTitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            <InviteCreateForm groups={groups} />
          </CardContent>
        </Card>

        <Card className="[--card-spacing:--spacing(5)]">
          <CardHeader>
            <CardTitle className="text-base">{t("csvTitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            <CsvImportForm groups={groups} />
          </CardContent>
        </Card>
      </div>

      <Card className="[--card-spacing:--spacing(5)]">
        <CardHeader>
          <CardTitle className="text-base">{t("listTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <InviteList invites={invites.items} now={new Date()} />
        </CardContent>
      </Card>
    </div>
  );
}
