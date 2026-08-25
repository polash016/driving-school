"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth/require-user";
import type { ActionResult } from "@/server/contracts/common";
import { db } from "@/server/db";
import { toActionError } from "@/server/http/action-result";
import {
  createLanguage,
  updateLanguage,
} from "@/server/services/i18n/languages";
import {
  editTranslation,
  reviewTranslation,
} from "@/server/services/i18n/review";
import {
  executeRun,
  planRun,
  type RunProgress,
} from "@/server/services/i18n/runs";
import type { TranslatableEntity } from "@prisma/client";

/**
 * Admin actions for languages and translations (spec-15).
 *
 * `requireUser` sits outside every try, because it works through `forbidden()`/`unauthorized()`
 * interrupts that must not be swallowed as an error result.
 *
 * ADMIN adds languages and starts runs; INSTRUCTOR reviews — the person who reads the language is
 * usually a teacher, not whoever holds the admin account.
 */

function optionalString(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export async function addLanguageAction(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser("ADMIN");
  try {
    await createLanguage(db, user, {
      code: String(formData.get("code") ?? "")
        .trim()
        .toLowerCase(),
      englishName: String(formData.get("englishName") ?? "").trim(),
      nativeName: String(formData.get("nativeName") ?? "").trim(),
      shortLabel: String(formData.get("shortLabel") ?? "").trim(),
      direction: formData.get("direction") === "RTL" ? "RTL" : "LTR",
      requiresApproval: formData.get("requiresApproval") !== "off",
      ...(optionalString(formData, "styleNote")
        ? { styleNote: optionalString(formData, "styleNote") }
        : {}),
    });
    revalidatePath("/admin/languages");
    return { ok: true };
  } catch (error) {
    return toActionError(error);
  }
}

export async function updateLanguageAction(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser("ADMIN");
  try {
    const code = String(formData.get("code") ?? "");
    await updateLanguage(db, user, {
      code,
      ...(formData.has("requiresApproval")
        ? { requiresApproval: formData.get("requiresApproval") === "true" }
        : {}),
      ...(formData.has("studentVisible")
        ? { studentVisible: formData.get("studentVisible") === "true" }
        : {}),
      ...(formData.has("qaSampleRate")
        ? { qaSampleRate: Number(formData.get("qaSampleRate")) }
        : {}),
    });
    revalidatePath("/admin/languages");
    revalidatePath(`/admin/languages/${code}`);
    return { ok: true };
  } catch (error) {
    return toActionError(error);
  }
}

export interface PlanOutcome {
  runId: string;
  plannedUnits: number;
  estimatedUsd: number;
  byEntity: Record<string, number>;
}

/**
 * Work out what a run would do, and what it would cost. Makes no AI call, which is exactly why it
 * is safe from a request path.
 */
export async function planRunAction(
  _prev: ActionResult<PlanOutcome> | undefined,
  formData: FormData,
): Promise<ActionResult<PlanOutcome>> {
  const user = await requireUser("ADMIN");
  try {
    const only = optionalString(formData, "only");
    const plan = await planRun(db, String(formData.get("code") ?? ""), {
      kind: only ? "SINGLE_ENTITY" : "SYNC",
      ...(only ? { only: [only as TranslatableEntity] } : {}),
      startedById: user.id,
    });
    revalidatePath(`/admin/languages/${plan.locale}`);
    return {
      ok: true,
      data: {
        runId: plan.runId,
        plannedUnits: plan.plannedUnits,
        estimatedUsd: plan.estimatedUsd,
        byEntity: plan.byEntity,
      },
    };
  } catch (error) {
    return toActionError(error);
  }
}

/**
 * Translate a bounded slice.
 *
 * Bounded on purpose: a request handler is the wrong place to hold a ten-minute AI run open. The
 * screen presses this repeatedly and watches the counters, and `pnpm i18n:translate` does the same
 * work unattended for a whole bank.
 */
export async function runSliceAction(
  _prev: ActionResult<RunProgress> | undefined,
  formData: FormData,
): Promise<ActionResult<RunProgress>> {
  const user = await requireUser("ADMIN");
  try {
    const runId = String(formData.get("runId") ?? "");
    const progress = await executeRun(db, runId, {
      leaseOwner: `admin-${user.id.slice(0, 8)}-${randomUUID().slice(0, 6)}`,
      maxUnits: Number(formData.get("maxUnits") ?? 25),
    });
    revalidatePath(`/admin/languages/${formData.get("code") ?? ""}`);
    return { ok: true, data: progress };
  } catch (error) {
    return toActionError(error);
  }
}

export async function reviewTranslationAction(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser("INSTRUCTOR");
  try {
    await reviewTranslation(db, user, {
      id: String(formData.get("id") ?? ""),
      action: formData.get("action") === "REJECT" ? "REJECT" : "APPROVE",
      ...(optionalString(formData, "note")
        ? { note: optionalString(formData, "note") }
        : {}),
    });
    revalidatePath(`/admin/languages/${formData.get("code") ?? ""}`);
    return { ok: true };
  } catch (error) {
    return toActionError(error);
  }
}

export async function editTranslationAction(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser("INSTRUCTOR");
  try {
    await editTranslation(db, user, {
      id: String(formData.get("id") ?? ""),
      value: JSON.parse(String(formData.get("value") ?? "{}")),
      ...(optionalString(formData, "note")
        ? { note: optionalString(formData, "note") }
        : {}),
    });
    revalidatePath(`/admin/languages/${formData.get("code") ?? ""}`);
    return { ok: true };
  } catch (error) {
    return toActionError(error);
  }
}
