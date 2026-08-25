"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/server/auth/require-user";
import type { ActionResult } from "@/server/contracts/common";
import { toActionError } from "@/server/http/action-result";
import { AUDIT, auditLog } from "@/server/audit";
import { db } from "@/server/db";

/**
 * Sign registry review (spec-05/10).
 *
 * The registry is seeded from an extracted source with AI-drafted meanings, so every row starts
 * `provisional`. This is where a person corrects it and takes responsibility for it — which is
 * the human sign-off that `pnpm signs:questions` relies on when it inserts sign questions as
 * approved without the usual two-person review.
 */
const saveSignSchema = z
  .object({
    id: z.string().min(1),
    /** Editable so a school can replace a placeholder with the real skiltforskriften code. */
    code: z.string().min(1).max(16),
    nameEn: z.string().min(1).max(160),
    nameNb: z.string().min(1).max(160),
    meaningEn: z.string().min(1).max(400),
    meaningNb: z.string().min(1).max(400),
    isActive: z.boolean(),
    /** Ticking "reviewed" clears the flag; it is never set back on from this screen. */
    reviewed: z.boolean(),
  })
  .strict();

export async function saveSignAction(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser("INSTRUCTOR");
  try {
    const input = saveSignSchema.parse({
      id: String(formData.get("id") ?? ""),
      code: String(formData.get("code") ?? "").trim(),
      nameEn: String(formData.get("nameEn") ?? "").trim(),
      nameNb: String(formData.get("nameNb") ?? "").trim(),
      meaningEn: String(formData.get("meaningEn") ?? "").trim(),
      meaningNb: String(formData.get("meaningNb") ?? "").trim(),
      isActive: formData.get("isActive") === "on",
      reviewed: formData.get("reviewed") === "on",
    });

    await db.sign.update({
      where: { id: input.id },
      data: {
        code: input.code,
        name: { en: input.nameEn, nb: input.nameNb },
        meaning: { en: input.meaningEn, nb: input.meaningNb },
        isActive: input.isActive,
        ...(input.reviewed ? { provisional: false } : {}),
      },
      select: { id: true },
    });

    await auditLog({
      actorId: user.id,
      action: AUDIT.signUpdated,
      entityType: "Sign",
      entityId: input.id,
      meta: { code: input.code, reviewed: input.reviewed },
    });

    revalidatePath("/admin/signs");
    return { ok: true };
  } catch (error) {
    return toActionError(error);
  }
}
