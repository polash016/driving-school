import { getTranslations, setRequestLocale } from "next-intl/server";
import { AuthShell } from "@/components/auth/auth-shell";
import { FormAlert } from "@/components/auth/form-alert";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import { Link } from "@/i18n/navigation";

export default async function ResetPasswordPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ token?: string }>;
}) {
  const [{ locale }, { token }] = await Promise.all([params, searchParams]);
  setRequestLocale(locale);
  const t = await getTranslations("auth.reset");

  if (!token) {
    return (
      <AuthShell title={t("missingTokenTitle")}>
        <div className="space-y-4">
          <FormAlert>{t("missingTokenBody")}</FormAlert>
          <Link
            href="/forgot-password"
            className="inline-flex min-h-11 items-center rounded-md text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            {t("requestNew")}
          </Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title={t("title")} subtitle={t("subtitle")}>
      <ResetPasswordForm token={token} />
    </AuthShell>
  );
}
