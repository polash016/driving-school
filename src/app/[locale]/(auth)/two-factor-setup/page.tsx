import { cookies } from "next/headers";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { AuthShell } from "@/components/auth/auth-shell";
import { TotpSetupForm } from "@/components/auth/totp-setup-form";
import { redirect } from "@/i18n/navigation";
import { db } from "@/server/db";
import { pendingTotpSetup } from "@/server/services/auth/credentials";
import { totpSetupPayload } from "@/server/services/auth/totp-enrolment";

/**
 * Forced 2FA enrolment for ADMIN (spec-03): reached only mid-login, holding the httpOnly
 * setup ticket. No session exists yet — the ticket is the entire authority here.
 */
export default async function TwoFactorSetupPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("auth.twoFactor");

  const ticketId = (await cookies()).get("tp_totp_setup")?.value;
  const pending = ticketId ? await pendingTotpSetup(db, ticketId) : null;
  if (!pending) {
    redirect({ href: "/login", locale });
    return null;
  }

  const payload = await totpSetupPayload(pending.secret, pending.email);

  return (
    <AuthShell title={t("setupTitle")} subtitle={t("setupIntroAdmin")}>
      <TotpSetupForm qrDataUrl={payload.qrDataUrl} secret={payload.secret} />
    </AuthShell>
  );
}
