import { getTranslations, setRequestLocale } from "next-intl/server";
import { AuthShell } from "@/components/auth/auth-shell";
import { FormAlert } from "@/components/auth/form-alert";
import { RegisterForm } from "@/components/auth/register-form";
import { Link } from "@/i18n/navigation";
import { db } from "@/server/db";
import { previewInvite } from "@/server/services/auth/invites";
import { schoolConfig } from "../../../../../config/school.config";

/**
 * Invite-only registration (spec-03). Without a usable invite token there is no form at all —
 * this is the whole gate on account creation.
 */
export default async function RegisterPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ invite?: string }>;
}) {
  const [{ locale }, { invite }] = await Promise.all([params, searchParams]);
  setRequestLocale(locale);
  const t = await getTranslations("auth.register");
  const tAuth = await getTranslations("auth");

  const preview = invite ? await previewInvite(db, invite) : null;

  if (!invite || !preview?.valid) {
    return (
      <AuthShell title={t("missingInviteTitle")}>
        <div className="space-y-4">
          <FormAlert>
            {invite ? tAuth("errors.inviteInvalid") : t("missingInviteBody")}
          </FormAlert>
          <Link
            href="/login"
            className="inline-flex min-h-11 items-center rounded-md text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            {t("haveAccount")}
          </Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={t("title")}
      subtitle={t("subtitle", { school: schoolConfig.school.name })}
    >
      <RegisterForm inviteToken={invite} presetEmail={preview.email ?? undefined} />
    </AuthShell>
  );
}
