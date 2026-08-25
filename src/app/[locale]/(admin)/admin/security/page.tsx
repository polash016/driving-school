import { getTranslations, setRequestLocale } from "next-intl/server";
import { SecurityPolicyForm } from "@/components/admin/security-policy-form";
import { requireUser } from "@/server/auth/require-user";
import { db } from "@/server/db";
import { getSecurityPolicy } from "@/server/services/auth/security-policy";

/** Deployment security policy (spec-03 amendment): the admin two-factor requirement. */
export default async function SecurityPolicyPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireUser("ADMIN");

  const [t, policy, adminsWithout2fa] = await Promise.all([
    getTranslations("admin.security"),
    getSecurityPolicy(db),
    db.user.count({ where: { role: "ADMIN", totpSecret: null, deletedAt: null, isActive: true } }),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-8">
      <header className="space-y-1.5">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">{t("title")}</h1>
        <p className="text-sm/relaxed text-muted-foreground">{t("subtitle")}</p>
      </header>
      <SecurityPolicyForm policy={policy} adminsWithout2fa={adminsWithout2fa} />
    </div>
  );
}
