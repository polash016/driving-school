import { createTranslator } from "next-intl";
import type { Locale } from "@/lib/locale";
import { db } from "@/server/db";
import { getMessages } from "@/server/services/i18n/catalogue";
import { schoolConfig } from "../../../config/school.config";
import type { MailMessage } from "./mailer";

/**
 * Bilingual auth emails (spec-03). Text comes from the same message catalogue as the UI —
 * `createTranslator` is next-intl's framework-agnostic core, so this stays out of request scope
 * and works from CLI scripts and queue workers too.
 *
 * Email clients ignore CSS variables, so the (deliberately plain) inline styles here are the one
 * place tokens cannot reach; colours are kept neutral instead of guessing at the school's theme.
 */

/**
 * The catalogue is loaded rather than statically imported (spec-15): a student whose language was
 * added from the admin panel must get their verification email in it, not in English. Built-in
 * languages still resolve from the compiled catalogues, so the auth flows keep working with no
 * database — which matters, because a password-reset email is exactly what someone needs during
 * an incident.
 */
async function t(locale: Locale) {
  return createTranslator({
    locale,
    messages: await getMessages(locale, db),
    namespace: "emails",
  });
}

interface RenderParams {
  heading: string;
  body: string;
  ctaLabel: string;
  ctaUrl: string;
  footer: string;
  fallback: string;
}

/** Plain-text and HTML bodies from one set of translated strings. */
function render(params: RenderParams): { text: string; html: string } {
  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f5f6f8;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#16181d">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:14px;padding:28px">
    <tr><td>
      <p style="margin:0 0 4px;font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:#6b7280">${escapeHtml(schoolConfig.school.shortName)}</p>
      <h1 style="margin:0 0 12px;font-size:21px;line-height:1.3">${escapeHtml(params.heading)}</h1>
      <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#374151">${escapeHtml(params.body)}</p>
      <p style="margin:0 0 20px">
        <a href="${params.ctaUrl}" style="display:inline-block;padding:12px 20px;border-radius:10px;background:#16181d;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600">${escapeHtml(params.ctaLabel)}</a>
      </p>
      <p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#6b7280">${escapeHtml(params.fallback)}</p>
      <p style="margin:0 0 20px;font-size:13px;word-break:break-all"><a href="${params.ctaUrl}" style="color:#374151">${params.ctaUrl}</a></p>
      <p style="margin:0;font-size:13px;line-height:1.6;color:#6b7280">${escapeHtml(params.footer)}</p>
    </td></tr>
  </table>
</body></html>`;

  return {
    text: `${params.heading}\n\n${params.body}\n\n${params.ctaUrl}\n\n${params.footer}`,
    html,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function verificationEmail(
  locale: Locale,
  to: string,
  firstName: string,
  url: string,
): Promise<MailMessage> {
  const translate = await t(locale);
  const heading = translate("verify.heading", { firstName });
  const body = translate("verify.body", { school: schoolConfig.school.name });
  return {
    to,
    subject: translate("verify.subject"),
    ...render({
      heading,
      body,
      ctaLabel: translate("verify.cta"),
      ctaUrl: url,
      footer: translate("verify.footer"),
      fallback: translate("common.linkFallback"),
    }),
  };
}

export async function passwordResetEmail(
  locale: Locale,
  to: string,
  firstName: string,
  url: string,
): Promise<MailMessage> {
  const translate = await t(locale);
  return {
    to,
    subject: translate("reset.subject"),
    ...render({
      heading: translate("reset.heading"),
      body: translate("reset.body", { firstName, school: schoolConfig.school.name }),
      ctaLabel: translate("reset.cta"),
      ctaUrl: url,
      footer: translate("reset.footer"),
      fallback: translate("common.linkFallback"),
    }),
  };
}

export async function inviteEmail(
  locale: Locale,
  to: string,
  url: string,
): Promise<MailMessage> {
  const translate = await t(locale);
  return {
    to,
    subject: translate("invite.subject"),
    ...render({
      heading: translate("invite.heading"),
      body: translate("invite.body", { school: schoolConfig.school.name }),
      ctaLabel: translate("invite.cta"),
      ctaUrl: url,
      footer: translate("invite.footer"),
      fallback: translate("common.linkFallback"),
    }),
  };
}
