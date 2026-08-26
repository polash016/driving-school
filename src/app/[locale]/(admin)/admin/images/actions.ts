"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth/require-user";
import type { ActionResult } from "@/server/contracts/common";
import { toActionError } from "@/server/http/action-result";
import { AUDIT, auditLog } from "@/server/audit";
import { db } from "@/server/db";
import { storage } from "@/server/storage";
import { uploadImage } from "@/server/services/images/upload";
import { extractContextSheet } from "@/server/services/pipeline/vision";
import { generateImageQuestions } from "@/server/services/generation/image";
import { contextSheetSchema } from "@/server/contracts/image-pipeline";
import { schoolConfig } from "../../../../../../config/school.config";
import { ValidationError } from "@/lib/errors";

/**
 * Image library actions (spec-06).
 *
 * Uploading is per-file rather than all-or-nothing: an instructor dropping thirty photographs
 * should not lose the twenty-nine that were fine because one was a screenshot in disguise. The
 * result reports each outcome so the UI can say exactly what happened.
 */
export async function uploadImagesAction(
  _prev: ActionResult<UploadSummary> | undefined,
  formData: FormData,
): Promise<ActionResult<UploadSummary>> {
  const user = await requireUser("INSTRUCTOR");

  try {
    // The school, not us, warrants that it may use these pictures. Recorded per upload because it
    // is the record that matters if a rights question is ever raised.
    if (formData.get("attest") !== "on") {
      throw new ValidationError(
        { reason: "rights not attested" },
        "admin.images.attestRequired",
      );
    }

    const files = formData
      .getAll("files")
      .filter((entry): entry is File => entry instanceof File);
    const present = files.filter((file) => file.size > 0);
    if (present.length === 0) {
      throw new ValidationError(
        { reason: "no files" },
        "admin.images.attestRequired",
      );
    }
    if (present.length > schoolConfig.storage.maxBatch) {
      throw new ValidationError(
        { reason: "batch too large", max: schoolConfig.storage.maxBatch },
        "admin.images.attestRequired",
      );
    }

    const driver = storage();
    let uploaded = 0;
    let duplicates = 0;
    let failed = 0;

    for (const file of present) {
      try {
        const result = await uploadImage(
          db,
          driver,
          { filename: file.name, bytes: Buffer.from(await file.arrayBuffer()) },
          user.id,
        );
        uploaded++;
        if (result.duplicateOfId) duplicates++;
      } catch {
        failed++;
      }
    }

    await auditLog({
      actorId: user.id,
      action: AUDIT.imagesUploaded,
      entityType: "ImageAsset",
      meta: { uploaded, duplicates, failed },
    });

    revalidatePath("/admin/images");
    return { ok: true, data: { uploaded, duplicates, failed } };
  } catch (error) {
    return toActionError(error);
  }
}

export type UploadSummary = {
  uploaded: number;
  duplicates: number;
  failed: number;
};

/**
 * Soft delete. The bytes stay: a retired question still points at this row, and an exam already
 * sat must keep rendering exactly what the student saw (spec-04b).
 */
export async function deleteImageAction(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser("INSTRUCTOR");
  try {
    const id = String(formData.get("id") ?? "");
    await db.imageAsset.update({
      where: { id },
      data: { deletedAt: new Date() },
      select: { id: true },
    });
    await auditLog({
      actorId: user.id,
      action: AUDIT.imageDeleted,
      entityType: "ImageAsset",
      entityId: id,
    });
    revalidatePath("/admin/images");
    return { ok: true };
  } catch (error) {
    return toActionError(error);
  }
}

/**
 * Read the picture into a context sheet (spec-06, mode 2).
 *
 * Runs inline rather than on a queue: this stack has none, and the work is one admin waiting on
 * their own action. Progress lives on `ImageAsset.status`, which is what its status index is for.
 */
export async function extractContextSheetAction(
  _prev: ActionResult<{ settled: boolean; unresolved: string[] }> | undefined,
  formData: FormData,
): Promise<ActionResult<{ settled: boolean; unresolved: string[] }>> {
  const user = await requireUser("INSTRUCTOR");
  const id = String(formData.get("imageAssetId") ?? "");
  try {
    const { settled, unresolved } = await extractContextSheet(db, storage(), id);
    await auditLog({
      actorId: user.id,
      action: AUDIT.imagesUploaded,
      entityType: "ImageAsset",
      entityId: id,
      meta: { step: "context-sheet", settled, unresolved: unresolved.length },
    });
    revalidatePath("/admin/images");
    return { ok: true, data: { settled, unresolved } };
  } catch (error) {
    await db.imageAsset
      .update({ where: { id }, data: { status: "FAILED" }, select: { id: true } })
      .catch(() => undefined);
    return toActionError(error);
  }
}

/**
 * Store the admin's corrections and mark the picture's facts confirmed.
 *
 * Confirming is what turns a perception step into ground truth for every question drawn from this
 * image afterwards. It is optional by deliberate decision — `generateFromImageAction` will run
 * without it — but the batch records which way it went.
 */
export async function confirmContextSheetAction(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser("INSTRUCTOR");
  try {
    const id = String(formData.get("imageAssetId") ?? "");
    const sheet = contextSheetSchema.parse(JSON.parse(String(formData.get("sheet") ?? "{}")));
    await db.imageAsset.update({
      where: { id },
      data: { aiContextSheet: sheet, contextVerifiedAt: new Date(), status: "READY" },
      select: { id: true },
    });
    await auditLog({
      actorId: user.id,
      action: AUDIT.imagesUploaded,
      entityType: "ImageAsset",
      entityId: id,
      meta: { step: "context-sheet-confirmed", signs: sheet.signs.length },
    });
    revalidatePath("/admin/images");
    return { ok: true };
  } catch (error) {
    return toActionError(error);
  }
}

/** Draft questions from the picture. Works confirmed or not; the batch records which. */
export async function generateFromImageAction(
  _prev: ActionResult<{ batchId: string; accepted: number; answerDisputed: number; factsVerified: boolean }> | undefined,
  formData: FormData,
): Promise<ActionResult<{ batchId: string; accepted: number; answerDisputed: number; factsVerified: boolean }>> {
  const user = await requireUser("INSTRUCTOR");
  try {
    const outcome = await generateImageQuestions(db, user, {
      imageAssetId: String(formData.get("imageAssetId") ?? ""),
      count: Math.min(10, Math.max(1, Number(formData.get("count") ?? 5))),
    });
    revalidatePath("/admin/images");
    revalidatePath("/admin/review");
    return {
      ok: true,
      data: {
        batchId: outcome.batchId,
        accepted: outcome.accepted,
        answerDisputed: outcome.answerDisputed,
        factsVerified: outcome.factsVerified,
      },
    };
  } catch (error) {
    return toActionError(error);
  }
}
