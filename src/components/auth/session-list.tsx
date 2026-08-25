"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useActionState } from "react";
import { revokeSessionAction } from "@/app/[locale]/(account)/account/actions";
import { FormAlert } from "@/components/auth/form-alert";
import { SubmitButton } from "@/components/auth/submit-button";
import type { SessionInfo } from "@/server/contracts/auth";
import type { ActionResult } from "@/server/contracts/common";

/** Active sessions with a per-row sign-out. Empty state = "this is your only session". */
export function SessionList({ sessions }: { sessions: SessionInfo[] }) {
  const t = useTranslations("auth.account");
  const tErrors = useTranslations();
  const format = useFormatter();
  const [state, formAction] = useActionState<ActionResult | undefined, FormData>(
    revokeSessionAction,
    undefined,
  );

  const others = sessions.filter((session) => !session.current);

  return (
    <div className="space-y-3">
      {state?.ok === false ? (
        <FormAlert>{tErrors(state.messageKey)}</FormAlert>
      ) : null}
      {state?.ok ? <FormAlert tone="success">{t("revoked")}</FormAlert> : null}

      <ul className="divide-y divide-border">
        {sessions.map((session) => (
          <li
            key={session.id}
            className="flex items-center justify-between gap-3 py-3"
          >
            <div className="min-w-0 space-y-0.5">
              <p className="truncate text-sm font-medium text-foreground">
                {session.userAgent
                  ? shortenUserAgent(session.userAgent)
                  : t("unknownDevice")}
                {session.current ? (
                  <span className="ml-2 rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-accent-foreground">
                    {t("current")}
                  </span>
                ) : null}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("lastSeen", {
                  when: format.dateTime(
                    new Date(session.lastSeenAt ?? session.createdAt),
                    { dateStyle: "medium", timeStyle: "short" },
                  ),
                })}
              </p>
            </div>
            {session.current ? null : (
              <form action={formAction}>
                <input type="hidden" name="sessionId" value={session.id} />
                <SubmitButton label={t("revoke")} variant="ghost" />
              </form>
            )}
          </li>
        ))}
      </ul>

      {others.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("sessionsEmpty")}</p>
      ) : null}
    </div>
  );
}

/** "Mozilla/5.0 (Linux; Android 13; Pixel 7) …" → "Pixel 7" style hint, never the raw string. */
function shortenUserAgent(userAgent: string): string {
  const match = userAgent.match(/\(([^)]+)\)/);
  return (match?.[1] ?? userAgent).split(";").slice(-1)[0]?.trim() || userAgent;
}
