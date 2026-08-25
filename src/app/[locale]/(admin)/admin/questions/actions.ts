"use server";

import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/server/contracts/common";
import type { ImportResult } from "@/server/contracts/question-bank";
import { redirect } from "@/i18n/navigation";
import { requireUser } from "@/server/auth/require-user";
import { db } from "@/server/db";
import { schoolConfig, type AppLocale } from "../../../../../../config/school.config";
import { toActionError } from "@/server/http/action-result";
import {
  attachItemsToBatch,
  createBatch,
  detachItem,
} from "@/server/services/question-bank/batches";
import { exportItems, importItems, itemsToCsv } from "@/server/services/question-bank/io";
import { generateTheoryQuestions } from "@/server/services/generation/theory";
import { deleteItem, upsertItem } from "@/server/services/question-bank/items";
import {
  bulkAction,
  transitionItem,
  type BulkOutcome,
} from "@/server/services/question-bank/transitions";

/** What the review UI needs to know: did this move the question, or just record my approval? */
export interface TransitionOutcome {
  applied: boolean;
  approvalsRecorded: number | null;
  approvalsRequired: number | null;
}

/**
 * Question-bank actions (spec-04). INSTRUCTOR authors and reviews; ADMIN additionally imports,
 * exports, bulk-acts and deletes. Every one starts with `requireUser()` — the coverage test
 * enforces that.
 */

function localeOf(formData: FormData): AppLocale {
  const value = String(formData.get("locale") ?? "");
  return (schoolConfig.locales.supported as readonly string[]).includes(value)
    ? (value as AppLocale)
    : schoolConfig.locales.default;
}

function optionalString(formData: FormData, name: string): string | undefined {
  const value = String(formData.get(name) ?? "").trim();
  return value.length > 0 ? value : undefined;
}

/** The editor posts one JSON blob: the form is too nested for flat form fields. */
export async function saveItemAction(
  _prev: ActionResult<{ id: string }> | undefined,
  formData: FormData,
): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser("INSTRUCTOR");
  try {
    const payload = JSON.parse(String(formData.get("payload") ?? "{}"));
    const saved = await upsertItem(db, user, payload);
    revalidatePath("/admin/questions");
    return { ok: true, data: { id: saved.id } };
  } catch (error) {
    return toActionError(error);
  }
}

export async function transitionItemAction(
  _prev: ActionResult<TransitionOutcome> | undefined,
  formData: FormData,
): Promise<ActionResult<TransitionOutcome>> {
  const user = await requireUser("INSTRUCTOR");
  try {
    const result = await transitionItem(db, user, {
      id: String(formData.get("id") ?? ""),
      to: String(formData.get("to") ?? ""),
      reason: optionalString(formData, "reason"),
      note: optionalString(formData, "note"),
    });
    revalidatePath("/admin/questions");
    revalidatePath("/admin/review");
    return {
      ok: true,
      data: {
        applied: result.applied,
        approvalsRecorded: result.approvals?.recorded ?? null,
        approvalsRequired: result.approvals?.required ?? null,
      },
    };
  } catch (error) {
    return toActionError(error);
  }
}

export async function bulkActionAction(
  _prev: ActionResult<BulkOutcome[]> | undefined,
  formData: FormData,
): Promise<ActionResult<BulkOutcome[]>> {
  const user = await requireUser("ADMIN");
  try {
    const outcomes = await bulkAction(db, user, {
      ids: formData.getAll("ids").map(String),
      action: String(formData.get("action") ?? ""),
      topicId: optionalString(formData, "topicId"),
    });
    revalidatePath("/admin/questions");
    return { ok: true, data: outcomes };
  } catch (error) {
    return toActionError(error);
  }
}

export async function deleteItemAction(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser("ADMIN");
  const locale = localeOf(formData);
  try {
    await deleteItem(db, user, String(formData.get("id") ?? ""));
  } catch (error) {
    return toActionError(error);
  }

  // Leave the page before it re-renders: the editor would try to load an item that no longer
  // exists and fail with a generic error, which is what a delete looked like from the UI.
  revalidatePath("/admin/questions");
  redirect({ href: "/admin/questions", locale });
  return { ok: true };
}

export async function importItemsAction(
  _prev: ActionResult<ImportResult> | undefined,
  formData: FormData,
): Promise<ActionResult<ImportResult>> {
  const user = await requireUser("ADMIN");
  try {
    const file = formData.get("file");
    const payload = file instanceof File ? await file.text() : String(file ?? "");
    const format = file instanceof File && file.name.endsWith(".json") ? "json" : "csv";
    const result = await importItems(db, user, { format, payload });
    revalidatePath("/admin/questions");
    return { ok: true, data: result };
  } catch (error) {
    return toActionError(error);
  }
}

export async function exportItemsAction(): Promise<ActionResult<{ csv: string }>> {
  await requireUser("ADMIN");
  try {
    return { ok: true, data: { csv: itemsToCsv(await exportItems(db, {})) } };
  } catch (error) {
    return toActionError(error);
  }
}

export async function createSetAction(
  _prev: ActionResult<{ id: string }> | undefined,
  formData: FormData,
): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser("INSTRUCTOR");
  try {
    const batch = await createBatch(db, user, {
      kind: "MANUAL",
      topicId: optionalString(formData, "topicId"),
      notes: optionalString(formData, "notes"),
    });
    revalidatePath("/admin/sets");
    return { ok: true, data: { id: batch.id } };
  } catch (error) {
    return toActionError(error);
  }
}

export async function attachToSetAction(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser("INSTRUCTOR");
  try {
    await attachItemsToBatch(db, user, {
      batchId: String(formData.get("batchId") ?? ""),
      itemIds: formData.getAll("itemIds").map(String),
    });
    revalidatePath("/admin/sets");
    return { ok: true };
  } catch (error) {
    return toActionError(error);
  }
}

export async function detachFromSetAction(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser("INSTRUCTOR");
  try {
    await detachItem(db, user, { itemId: String(formData.get("itemId") ?? "") });
    revalidatePath("/admin/sets");
    return { ok: true };
  } catch (error) {
    return toActionError(error);
  }
}

/** What the generate panel reports back after a run. */
export interface GenerationSummary {
  batchId: string;
  requested: number;
  returned: number;
  accepted: number;
  rejected: number;
}

/**
 * Generate draft questions for a topic with AI (spec-05/06). ADMIN only — it spends the school's
 * AI quota. Everything produced lands as a DRAFT in a new set and goes through the normal review
 * queue; an AI-written question still needs two reviewers before a student can see it.
 */
export async function generateQuestionsAction(
  _prev: ActionResult<GenerationSummary> | undefined,
  formData: FormData,
): Promise<ActionResult<GenerationSummary>> {
  const user = await requireUser("ADMIN");
  try {
    const outcome = await generateTheoryQuestions(db, user, {
      topicId: String(formData.get("topicId") ?? ""),
      count: Math.min(10, Math.max(1, Number(formData.get("count") ?? 5))),
    });
    revalidatePath("/admin/sets");
    revalidatePath("/admin/questions");
    return {
      ok: true,
      data: {
        batchId: outcome.batchId,
        requested: outcome.requested,
        returned: outcome.returned,
        accepted: outcome.accepted,
        rejected: outcome.rejected.length,
      },
    };
  } catch (error) {
    return toActionError(error);
  }
}
