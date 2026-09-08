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
      body: translate("reset.body", {
        firstName,
        school: schoolConfig.school.name,
      }),
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

/**
 * Run outcome mail (spec-19).
 *
 * A full language is a multi-hour run, so nobody is watching when it lands. These three say what
 * happened in one line and hand over a link to the language's own page, which is where every
 * follow-up action lives — review the flagged rows, restart a stalled repair, read the error.
 *
 * The link is built for the RECIPIENT's locale, not the run's: the admin reading this is a
 * Norwegian school's staff member, and the language being translated is the one they are least
 * likely to read the admin panel in.
 */
export async function runFinishedEmail(
  locale: Locale,
  to: string,
  p: {
    language: string;
    url: string;
    completed: number;
    flagged: number;
    failed: number;
  },
): Promise<MailMessage> {
  const translate = await t(locale);
  return {
    to,
    subject: translate("i18nRun.finished.subject", { language: p.language }),
    ...render({
      heading: translate("i18nRun.finished.heading", { language: p.language }),
      body: translate("i18nRun.finished.body", {
        completed: String(p.completed),
        flagged: String(p.flagged),
        failed: String(p.failed),
      }),
      ctaLabel: translate("i18nRun.cta"),
      ctaUrl: p.url,
      footer: translate("i18nRun.footer"),
      fallback: translate("common.linkFallback"),
    }),
  };
}

export async function runFailedEmail(
  locale: Locale,
  to: string,
  p: { language: string; url: string; error: string },
): Promise<MailMessage> {
  const translate = await t(locale);
  return {
    to,
    subject: translate("i18nRun.failed.subject", { language: p.language }),
    ...render({
      heading: translate("i18nRun.failed.heading"),
      // Truncated: a worker error can carry a whole provider payload, and a mail body is not
      // where anybody debugs one. The full text is on the run row and in the logs.
      body: translate("i18nRun.failed.body", { error: p.error.slice(0, 200) }),
      ctaLabel: translate("i18nRun.cta"),
      ctaUrl: p.url,
      footer: translate("i18nRun.footer"),
      fallback: translate("common.linkFallback"),
    }),
  };
}

/**
 * The end of a repair chain, in both of its shapes.
 *
 * `stalled` is the one worth telling apart: the repair fixed nothing at all, which almost always
 * means the AI provider was down rather than that the units are unfixable — so the admin is told
 * to start it again rather than to go and review three hundred rows by hand.
 */
export async function repairOutcomeEmail(
  locale: Locale,
  to: string,
  p: { language: string; url: string; remaining: number; stalled: boolean },
): Promise<MailMessage> {
  const translate = await t(locale);
  const remaining = String(p.remaining);
  return {
    to,
    subject: translate("i18nRun.repair.subject", {
      language: p.language,
      remaining,
    }),
    ...render({
      heading: translate("i18nRun.repair.heading"),
      body: translate(
        p.stalled ? "i18nRun.repair.bodyStalled" : "i18nRun.repair.body",
        { remaining },
      ),
      ctaLabel: translate("i18nRun.cta"),
      ctaUrl: p.url,
      footer: translate("i18nRun.footer"),
      fallback: translate("common.linkFallback"),
    }),
  };
}
