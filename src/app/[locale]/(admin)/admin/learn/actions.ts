"use server";

import { revalidatePath } from "next/cache";
import { AUDIT, auditLog } from "@/server/audit";
import { requireUser } from "@/server/auth/require-user";
import type { ActionResult } from "@/server/contracts/common";
import {
  deleteLearnInputSchema,
  reorderChaptersInputSchema,
  transitionLearnInputSchema,
  type LearnStatus,
} from "@/server/contracts/learn";
import { db } from "@/server/db";
import { toActionError } from "@/server/http/action-result";
import { uploadImage } from "@/server/services/images/upload";
import { learnService } from "@/server/services/learn";
import { draftDocument } from "@/server/services/learn/draft";
import { rateLimit } from "@/server/rate-limit";
import type { DraftResult } from "@/server/contracts/learn";
import { storage } from "@/server/storage";
import { schoolConfig } from "../../../../../../config/school.config";

/**
 * Learn administration (spec-23). Instructors author and publish; only an admin deletes.
 * Every mutation: requireUser → service → audit → revalidate the screens that changed.
 */

function revalidateStudentLearn() {
  revalidatePath("/learn");
  revalidatePath("/learn/books/[slug]", "page");
  revalidatePath("/learn/read/[slug]", "page");
  revalidatePath("/");
}

function parsePayload(formData: FormData): unknown {
  const raw = String(formData.get("payload") ?? "");
  return raw ? JSON.parse(raw) : {};
}

export async function upsertBookAction(
  _prev: ActionResult<{ id: string }> | undefined,
  formData: FormData,
): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser("INSTRUCTOR");
  try {
    const result = await learnService.upsertBook(parsePayload(formData), user.id);
    await auditLog({ actorId: user.id, action: AUDIT.learnBookUpserted, entityType: "LearnBook", entityId: result.id });
    revalidatePath("/admin/learn");
    revalidateStudentLearn();
    return { ok: true, data: result };
  } catch (error) {
    return toActionError(error);
  }
}

export async function reorderChaptersAction(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser("INSTRUCTOR");
  try {
    const input = reorderChaptersInputSchema.parse(parsePayload(formData));
    await learnService.reorderChapters(input, user.id);
    await auditLog({
      actorId: user.id,
      action: AUDIT.learnChaptersReordered,
      entityType: "LearnBook",
      entityId: input.bookId,
      meta: { count: input.documentIds.length },
    });
    revalidatePath("/admin/learn");
    revalidateStudentLearn();
    return { ok: true };
  } catch (error) {
    return toActionError(error);
  }
}

export async function upsertDocumentAction(
  _prev: ActionResult<{ id: string; version: number }> | undefined,
  formData: FormData,
): Promise<ActionResult<{ id: string; version: number }>> {
  const user = await requireUser("INSTRUCTOR");
  try {
    const result = await learnService.upsertDocument(parsePayload(formData), user.id);
    await auditLog({
      actorId: user.id,
      action: AUDIT.learnDocumentUpserted,
      entityType: "LearnDocument",
      entityId: result.id,
      meta: { version: result.version },
    });
    revalidatePath("/admin/learn");
    revalidateStudentLearn();
    return { ok: true, data: result };
  } catch (error) {
    return toActionError(error);
  }
}

export async function transitionLearnAction(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser("INSTRUCTOR");
  try {
    const input = transitionLearnInputSchema.parse({
      entity: String(formData.get("entity") ?? ""),
      id: String(formData.get("id") ?? ""),
      to: String(formData.get("to") ?? "") as LearnStatus,
    });
    if (input.entity === "BOOK") {
      await learnService.transitionBook(input.id, input.to, user.id);
    } else {
      await learnService.transitionDocument(input.id, input.to, user.id);
    }
    await auditLog({
      actorId: user.id,
      action: input.entity === "BOOK" ? AUDIT.learnBookTransitioned : AUDIT.learnDocumentTransitioned,
      entityType: input.entity === "BOOK" ? "LearnBook" : "LearnDocument",
      entityId: input.id,
      meta: { to: input.to },
    });
    revalidatePath("/admin/learn");
    revalidateStudentLearn();
    return { ok: true };
  } catch (error) {
    return toActionError(error);
  }
}

export async function deleteLearnAction(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser("ADMIN");
  try {
    const input = deleteLearnInputSchema.parse({
      entity: String(formData.get("entity") ?? ""),
      id: String(formData.get("id") ?? ""),
    });
    if (input.entity === "BOOK") await learnService.deleteBook(input.id, user.id);
    else await learnService.deleteDocument(input.id, user.id);
    await auditLog({
      actorId: user.id,
      action: AUDIT.learnDeleted,
      entityType: input.entity === "BOOK" ? "LearnBook" : "LearnDocument",
      entityId: input.id,
    });
    revalidatePath("/admin/learn");
    revalidateStudentLearn();
    return { ok: true };
  } catch (error) {
    return toActionError(error);
  }
}

/** One picture for a document, through the same gate as every other upload (attestation, sniff, dedupe). */
export async function uploadLearnImageAction(
  _prev: ActionResult<{ id: string; url: string; duplicateOfId: string | null }> | undefined,
  formData: FormData,
): Promise<ActionResult<{ id: string; url: string; duplicateOfId: string | null }>> {
  const user = await requireUser("INSTRUCTOR");
  try {
    const file = formData.get("file");
    const attest = formData.get("attest") === "on" || formData.get("attest") === "true";
    if (!(file instanceof File) || file.size === 0) {
      return { ok: false, code: "VALIDATION", messageKey: "admin.learn.image.attestRequired" };
    }
    if (!attest) {
      return { ok: false, code: "VALIDATION", messageKey: "admin.learn.image.attestRequired" };
    }
    if (file.size > schoolConfig.storage.maxUploadBytes) {
      return { ok: false, code: "VALIDATION", messageKey: "admin.learn.image.tooLarge" };
    }
    const result = await uploadImage(
      db,
      storage(),
      { filename: file.name, bytes: Buffer.from(await file.arrayBuffer()) },
      user.id,
    );
    revalidatePath("/admin/images");
    return { ok: true, data: { id: result.id, url: result.url, duplicateOfId: result.duplicateOfId ?? null } };
  } catch (error) {
    return toActionError(error);
  }
}

/**
 * Draft a chapter or article with the AI (spec-23 C8). Synchronous, like the two existing
 * generation actions: the result is an editable proposal, nothing is stored until the admin saves.
 */
export async function draftDocumentAction(
  _prev: ActionResult<DraftResult> | undefined,
  formData: FormData,
): Promise<ActionResult<DraftResult>> {
  const user = await requireUser("INSTRUCTOR");
  try {
    await rateLimit("learnDraft", user.id);
    const result = await draftDocument(db, user, parsePayload(formData));
    await auditLog({
      actorId: user.id,
      action: AUDIT.learnDocumentDrafted,
      entityType: "LearnDocument",
      meta: {
        excerpts: result.excerptCount,
        modelVersion: result.modelVersion,
        promptVersion: result.promptVersion,
        warnings: result.warnings,
        unresolved: result.unresolvedCitations.length,
      },
    });
    return { ok: true, data: result };
  } catch (error) {
    return toActionError(error);
  }
}
