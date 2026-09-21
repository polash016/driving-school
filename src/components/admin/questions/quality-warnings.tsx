import { getTranslations } from "next-intl/server";
import type { QualityIssue } from "@/server/services/question-bank/validation";

/**
 * The quality gate's WARNINGS, shown to the reviewer (spec-22).
 *
 * Until this existed, `checkItemQuality` computed warnings and every single call site threw them
 * away — so a warning was, in practice, a value nobody ever saw. Errors block approval and surface
 * as a `ValidationError`; warnings are the half of the gate that is meant to inform a judgement
 * rather than override it, and that only works if a human is shown them.
 *
 * Deliberately not a blocker and deliberately not dismissible: a reviewer who reads "the question
 * is 19 words long — the limit is 15" and approves anyway IS the override. There is nothing to
 * click.
 */
export async function QualityWarnings({ issues }: { issues: QualityIssue[] }) {
  if (issues.length === 0) return null;
  const t = await getTranslations("admin.quality");

  return (
    <section
      aria-labelledby="quality-warnings-heading"
      className="rounded-[var(--radius-control)] border border-[var(--status-warning)] bg-[var(--status-warning-soft)] px-4 py-3"
    >
      <h2
        id="quality-warnings-heading"
        className="text-sm font-semibold text-[var(--status-warning-fg)]"
      >
        {t("warningsTitle")}
      </h2>
      <ul className="mt-2 space-y-1.5">
        {issues.map((issue, index) => (
          <li
            key={`${issue.code}-${issue.locale ?? "all"}-${index}`}
            className="flex flex-wrap items-baseline gap-x-2 text-sm/relaxed text-[var(--status-warning-fg)]"
          >
            {issue.locale ? (
              <span className="rounded bg-black/10 px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide">
                {issue.locale}
              </span>
            ) : null}
            <span>
              {/* The message key is an i18n key by contract; `values` carries its ICU args. */}
              {t(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                issue.messageKey.replace(/^admin\.quality\./, "") as any,
                (issue.values ?? {}) as Record<string, string | number>,
              )}
            </span>
            {issue.detail ? (
              <span className="text-xs opacity-80">“{issue.detail}”</span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
