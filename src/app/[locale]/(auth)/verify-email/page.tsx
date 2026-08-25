import { getTranslations, setRequestLocale } from "next-intl/server";
import { AuthShell } from "@/components/auth/auth-shell";
import { FormAlert } from "@/components/auth/form-alert";
import { VerifyEmailForm } from "@/components/auth/verify-email-form";
import { Link } from "@/i18n/navigation";

export default async function VerifyEmailPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ token?: string }>;
}) {
  const [{ locale }, { token }] = await Promise.all([params, searchParams]);
  setRequestLocale(locale);
  const t = await getTranslations("auth.verify");

  if (!token) {
    return (
      <AuthShell title={t("failedTitle")}>
        <div className="space-y-4">
          <FormAlert>{t("failedBody")}</FormAlert>
          <Link
            href="/login"
            className="inline-flex min-h-11 items-center rounded-md text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            {t("toLogin")}
          </Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title={t("title")}>
      <VerifyEmailForm token={token} />
    </AuthShell>
  );
}
