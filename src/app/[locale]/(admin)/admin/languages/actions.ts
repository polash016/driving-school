"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { ConflictError } from "@/lib/errors";
import { requireUser } from "@/server/auth/require-user";
import type { SessionUser } from "@/server/authz";
import type { ActionResult } from "@/server/contracts/common";
import { db } from "@/server/db";
import { toActionError } from "@/server/http/action-result";
import {
  createLanguage,
  updateLanguage,
} from "@/server/services/i18n/languages";
import {
  requestCancel,
  requestPause,
  resumeRun,
  runDetail,
  startBackgroundRun,
  type RunDetail,
} from "@/server/services/i18n/run-control";
import {
  bulkApproveTranslations,
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
    const run = await db.translationRun.findUnique({
      where: { id: runId },
      select: { enqueuedAt: true },
    });
    if (run?.enqueuedAt)
      throw new ConflictError({ runId }, "admin.languages.errors.runEnqueued");
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

export interface BulkApproveOutcome {
  approved: number;
  skipped: number;
}

/**
 * Approve every clean machine translation for a language in one act.
 *
 * A language has 534 UI strings; approving those one at a time is not a workflow anybody finishes.
 * It deliberately refuses anything a check flagged — those are the findings the checks exist for,
 * and clearing them in bulk would waste them.
 */
export async function bulkApproveAction(
  _prev: ActionResult<BulkApproveOutcome> | undefined,
  formData: FormData,
): Promise<ActionResult<BulkApproveOutcome>> {
  const user = await requireUser("INSTRUCTOR");
  try {
    const locale = String(formData.get("code") ?? "");
    const outcome = await bulkApproveTranslations(db, user, {
      locale,
      ...(optionalString(formData, "entity")
        ? { entity: optionalString(formData, "entity") }
        : {}),
      includeFlagged: false,
    });
    revalidatePath(`/admin/languages/${locale}`);
    revalidatePath("/admin/languages");
    return { ok: true, data: outcome };
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

export interface StartOutcome {
  runId: string;
  plannedUnits: number;
  estimatedUsd: number;
}

/** Plan AND enqueue in one act — the worker picks it up on its next poll. */
export async function startBackgroundRunAction(
  _prev: ActionResult<StartOutcome> | undefined,
  formData: FormData,
): Promise<ActionResult<StartOutcome>> {
  const user = await requireUser("ADMIN");
  try {
    const only = optionalString(formData, "only");
    const plan = await startBackgroundRun(db, user, {
      locale: String(formData.get("code") ?? ""),
      ...(only ? { only: [only as TranslatableEntity] } : {}),
    });
    revalidatePath("/admin/languages");
    revalidatePath(`/admin/languages/${plan.locale}`);
    return {
      ok: true,
      data: {
        runId: plan.runId,
        plannedUnits: plan.plannedUnits,
        estimatedUsd: plan.estimatedUsd,
      },
    };
  } catch (error) {
    return toActionError(error);
  }
}

/**
 * Re-translate what QA flagged, in the background.
 *
 * The worker chains a repair after every run of its own accord; this is the way back in when that
 * chain stopped — a repair that fixed nothing (the provider was down) deliberately does not plan
 * another, so somebody has to say "try again" once it is back.
 */
export async function startRepairRunAction(
  _prev: ActionResult<StartOutcome> | undefined,
  formData: FormData,
): Promise<ActionResult<StartOutcome>> {
  const user = await requireUser("ADMIN");
  try {
    const plan = await startBackgroundRun(db, user, {
      locale: String(formData.get("code") ?? ""),
      kind: "REPAIR",
    });
    revalidatePath("/admin/languages");
    revalidatePath(`/admin/languages/${plan.locale}`);
    return {
      ok: true,
      data: {
        runId: plan.runId,
        plannedUnits: plan.plannedUnits,
        estimatedUsd: plan.estimatedUsd,
      },
    };
  } catch (error) {
    return toActionError(error);
  }
}

function runControl(fn: (actor: SessionUser, runId: string) => Promise<void>) {
  return async (
    _prev: ActionResult | undefined,
    formData: FormData,
  ): Promise<ActionResult> => {
    const user = await requireUser("ADMIN");
    try {
      await fn(user, String(formData.get("runId") ?? ""));
      revalidatePath("/admin/languages");
      return { ok: true };
    } catch (error) {
      return toActionError(error);
    }
  };
}
export const pauseRunAction = runControl((actor, runId) =>
  requestPause(db, actor, runId),
);
export const resumeRunAction = runControl((actor, runId) =>
  resumeRun(db, actor, runId),
);
export const cancelRunAction = runControl((actor, runId) =>
  requestCancel(db, actor, runId),
);

/** Read-only, no revalidation: polled every 3 s by the progress panel. */
export async function runDetailAction(
  runId: string,
): Promise<ActionResult<RunDetail>> {
  await requireUser("ADMIN");
  try {
    return { ok: true, data: await runDetail(db, runId) };
  } catch (error) {
    return toActionError(error);
  }
}
