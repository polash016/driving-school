"use server";

import { revalidatePath } from "next/cache";
import type { Invite, CsvImportResult } from "@/server/contracts/auth";
import type { ActionResult } from "@/server/contracts/common";
import { requireUser } from "@/server/auth/require-user";
import { db } from "@/server/db";
import { toActionError } from "@/server/http/action-result";
import { createInvite, revokeInvite } from "@/server/services/auth/invites";
import { importStudentsCsv } from "@/server/services/auth/csv-import";
import { schoolConfig, type AppLocale } from "../../../../../../config/school.config";

/** Invite administration (spec-03 minimal surface; spec-11 expands it). */

function localeOf(formData: FormData): AppLocale {
  const value = String(formData.get("locale") ?? "");
  return (schoolConfig.locales.supported as readonly string[]).includes(value)
    ? (value as AppLocale)
    : schoolConfig.locales.default;
}

export async function createInviteAction(
  _prev: ActionResult<Invite> | undefined,
  formData: FormData,
): Promise<ActionResult<Invite>> {
  const user = await requireUser("ADMIN");
  try {
    const groupId = String(formData.get("groupId") ?? "");
    const maxUses = Number(formData.get("maxUses") ?? 1);
    const invite = await createInvite(
      db,
      user.id,
      {
        role: String(formData.get("role") ?? "STUDENT"),
        ...(groupId ? { groupId } : {}),
        maxUses: Number.isFinite(maxUses) && maxUses > 0 ? maxUses : 1,
        expiresInDays: Number(formData.get("expiresInDays") ?? 14),
      },
      { locale: localeOf(formData) },
    );
    revalidatePath("/admin/invites");
    return { ok: true, data: invite };
  } catch (error) {
    return toActionError(error);
  }
}

export async function revokeInviteAction(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser("ADMIN");
  try {
    await revokeInvite(db, user.id, String(formData.get("inviteId") ?? ""));
    revalidatePath("/admin/invites");
    return { ok: true };
  } catch (error) {
    return toActionError(error);
  }
}

export async function importStudentsAction(
  _prev: ActionResult<CsvImportResult> | undefined,
  formData: FormData,
): Promise<ActionResult<CsvImportResult>> {
  const user = await requireUser("ADMIN");
  try {
    const file = formData.get("file");
    const groupId = String(formData.get("groupId") ?? "");
    const csv = file instanceof File ? await file.text() : String(file ?? "");
    const result = await importStudentsCsv(
      db,
      user.id,
      { csv, ...(groupId ? { groupId } : {}), expiresInDays: 14 },
      { locale: localeOf(formData) },
    );
    revalidatePath("/admin/invites");
    return { ok: true, data: result };
  } catch (error) {
    return toActionError(error);
  }
}
