"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import {
  addProviderAction,
  deleteProviderAction,
  deleteRouteAction,
  rotateKeyAction,
  saveRouteAction,
  testProviderAction,
  type TestOutcome,
} from "@/app/[locale]/(admin)/admin/ai/actions";
import { Field } from "@/components/auth/field";
import { FormAlert } from "@/components/auth/form-alert";
import { SubmitButton } from "@/components/auth/submit-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { ActionResult } from "@/server/contracts/common";
import type {
  ProviderSummary,
  RouteSummary,
} from "@/server/services/ai/providers";

/**
 * Keys and routing (spec-05). The key field is write-only: it is sent, never rendered back. The
 * screen identifies a provider by the last four characters and nothing else.
 */

const KINDS = ["GOOGLE", "ANTHROPIC", "OPENAI_COMPATIBLE"] as const;
const TASKS = ["VISION", "GENERATION", "VALIDATION", "EMBEDDING", "IMAGE", "TRANSLATION"] as const;

export function AiProviderPanel({
  providers,
  routes,
}: {
  providers: ProviderSummary[];
  routes: RouteSummary[];
}) {
  const t = useTranslations("admin.ai");
  const tErrors = useTranslations();
  const format = useFormatter();
  const [kind, setKind] = useState<(typeof KINDS)[number]>("GOOGLE");

  const [addState, addAction] = useActionState<ActionResult | undefined, FormData>(
    addProviderAction,
    undefined,
  );
  const [testState, testAction] = useActionState<
    ActionResult<TestOutcome> | undefined,
    FormData
  >(testProviderAction, undefined);
  const [routeState, routeAction] = useActionState<ActionResult | undefined, FormData>(
    saveRouteAction,
    undefined,
  );
  const [rotateState, rotateAction] = useActionState<ActionResult | undefined, FormData>(
    rotateKeyAction,
    undefined,
  );
  const [removeState, removeAction] = useActionState<ActionResult | undefined, FormData>(
    deleteProviderAction,
    undefined,
  );
  const [removeRouteState, removeRouteAction] = useActionState<
    ActionResult | undefined,
    FormData
  >(deleteRouteAction, undefined);

  return (
    <div className="space-y-5">
      <Card className="[--card-spacing:--spacing(5)]">
        <CardHeader>
          <CardTitle className="text-base">{t("addTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">{t("addHint")}</p>
          {addState?.ok === false ? (
            <FormAlert>{tErrors(addState.messageKey)}</FormAlert>
          ) : null}
          {addState?.ok ? <FormAlert tone="success">{t("added")}</FormAlert> : null}

          <form action={addAction} className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1.5 text-sm font-medium">
              {t("kind")}
              <select
                name="kind"
                value={kind}
                onChange={(event) => setKind(event.target.value as (typeof KINDS)[number])}
                className="h-11 w-full rounded-[var(--radius-control)] border border-input bg-transparent px-3 text-sm"
              >
                {KINDS.map((option) => (
                  <option key={option} value={option}>
                    {t(`kinds.${option}`)}
                  </option>
                ))}
              </select>
            </label>
            <Field label={t("label")} name="label" required />
            <Field
              label={t("baseUrl")}
              name="baseUrl"
              type="url"
              required={kind === "OPENAI_COMPATIBLE"}
              hint={
                kind === "OPENAI_COMPATIBLE" ? t("baseUrlRequired") : t("baseUrlOptional")
              }
            />
            <Field
              label={t("apiKey")}
              name="apiKey"
              type="password"
              autoComplete="off"
              required
              hint={t("apiKeyHint")}
            />
            <div className="md:col-span-2">
              <SubmitButton label={t("add")} />
            </div>
          </form>
        </CardContent>
      </Card>

      <Card className="[--card-spacing:--spacing(5)]">
        <CardHeader>
          <CardTitle className="text-base">{t("providersTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {providers.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("noProviders")}</p>
          ) : (
            <ul className="divide-y divide-border">
              {providers.map((provider) => (
                <li key={provider.id} className="space-y-2 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-foreground">
                        {provider.label}{" "}
                        <span className="text-xs font-normal text-muted-foreground">
                          {t(`kinds.${provider.kind}`)} · {provider.keyHint}
                        </span>
                      </p>
                      {provider.lastCheckedAt ? (
                        <p
                          className={cn(
                            "text-xs",
                            provider.lastCheckOk
                              ? "text-[var(--status-success)]"
                              : "text-destructive",
                          )}
                        >
                          {provider.lastCheckOk ? t("checkOk") : t("checkFailed")} ·{" "}
                          {format.dateTime(provider.lastCheckedAt, {
                            dateStyle: "short",
                            timeStyle: "short",
                          })}
                          {provider.lastCheckError ? ` · ${provider.lastCheckError}` : ""}
                        </p>
                      ) : (
                        <p className="text-xs text-muted-foreground">{t("neverChecked")}</p>
                      )}
                    </div>

                    <form action={removeAction}>
                      <input type="hidden" name="providerId" value={provider.id} />
                      <SubmitButton label={t("remove")} variant="ghost" />
                    </form>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <form action={testAction} className="flex items-end gap-2">
                      <input type="hidden" name="providerId" value={provider.id} />
                      <Field
                        label={t("testModel")}
                        name="model"
                        placeholder="gemini-2.0-flash"
                        required
                        className="w-56"
                      />
                      <SubmitButton label={t("test")} variant="outline" />
                    </form>

                    <form action={rotateAction} className="flex items-end gap-2">
                      <input type="hidden" name="providerId" value={provider.id} />
                      <Field
                        label={t("newKey")}
                        name="apiKey"
                        type="password"
                        autoComplete="off"
                        required
                        className="w-56"
                      />
                      <SubmitButton label={t("rotate")} variant="outline" />
                    </form>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {testState?.ok === false ? (
            <FormAlert>{tErrors(testState.messageKey)}</FormAlert>
          ) : null}
          {testState?.ok ? (
            <FormAlert tone={testState.data.ok ? "success" : "error"}>
              {testState.data.ok
                ? t("testOk", { ms: testState.data.ms })
                : t("testFailed", { error: testState.data.error ?? "" })}
            </FormAlert>
          ) : null}
          {rotateState?.ok ? <FormAlert tone="success">{t("rotated")}</FormAlert> : null}
          {removeState?.ok === false ? (
            <FormAlert>{tErrors(removeState.messageKey)}</FormAlert>
          ) : null}
        </CardContent>
      </Card>

      <Card className="[--card-spacing:--spacing(5)]">
        <CardHeader>
          <CardTitle className="text-base">{t("routesTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">{t("routesHint")}</p>

          {routeState?.ok === false ? (
            <FormAlert>{tErrors(routeState.messageKey)}</FormAlert>
          ) : null}
          {routeState?.ok ? <FormAlert tone="success">{t("routeSaved")}</FormAlert> : null}
          {removeRouteState?.ok === false ? (
            <FormAlert>{tErrors(removeRouteState.messageKey)}</FormAlert>
          ) : null}

          {routes.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("noRoutes")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[36rem] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th scope="col" className="p-2 font-medium">{t("task")}</th>
                    <th scope="col" className="p-2 font-medium">{t("provider")}</th>
                    <th scope="col" className="p-2 font-medium">{t("model")}</th>
                    <th scope="col" className="p-2 font-medium">{t("priority")}</th>
                    <th scope="col" className="p-2" />
                  </tr>
                </thead>
                <tbody>
                  {routes.map((route) => (
                    <tr key={route.id} className="border-b border-border/60 last:border-0">
                      <td className="p-2 text-foreground">{t(`tasks.${route.task}`)}</td>
                      <td className="p-2 text-muted-foreground">{route.providerLabel}</td>
                      <td className="p-2 font-mono text-xs text-muted-foreground">
                        {route.model}
                      </td>
                      <td className="p-2 text-muted-foreground">{route.priority}</td>
                      <td className="p-2 text-right">
                        <form action={removeRouteAction}>
                          <input type="hidden" name="routeId" value={route.id} />
                          <SubmitButton label={t("removeRoute")} variant="ghost" />
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {providers.length > 0 ? (
            <form action={routeAction} className="grid gap-3 md:grid-cols-[1fr_1fr_1fr_auto_auto] md:items-end">
              <label className="space-y-1.5 text-sm font-medium">
                {t("task")}
                <select
                  name="task"
                  className="h-11 w-full rounded-[var(--radius-control)] border border-input bg-transparent px-3 text-sm"
                >
                  {TASKS.map((task) => (
                    <option key={task} value={task}>
                      {t(`tasks.${task}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1.5 text-sm font-medium">
                {t("provider")}
                <select
                  name="providerId"
                  className="h-11 w-full rounded-[var(--radius-control)] border border-input bg-transparent px-3 text-sm"
                >
                  {providers.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.label}
                    </option>
                  ))}
                </select>
              </label>
              <Field label={t("model")} name="model" required />
              <Field
                label={t("priority")}
                name="priority"
                type="number"
                min={0}
                max={100}
                defaultValue={0}
                className="w-24"
              />
              <SubmitButton label={t("addRoute")} />
            </form>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
