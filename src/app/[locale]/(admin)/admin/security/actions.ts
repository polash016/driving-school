"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth/require-user";
import type { ActionResult } from "@/server/contracts/common";
import { db } from "@/server/db";
import { toActionError } from "@/server/http/action-result";
import { setSecurityPolicy } from "@/server/services/auth/security-policy";

/** Deployment security policy (ADMIN only, audited). */
export async function saveSecurityPolicyAction(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser("ADMIN");
  try {
    await setSecurityPolicy(db, user, {
      adminTwoFactorRequired: formData.get("adminTwoFactorRequired") === "on",
      aiApprovalsRequired: Number(formData.get("aiApprovalsRequired") ?? 2),
    });
    revalidatePath("/admin/security");
    revalidatePath("/account/security");
    return { ok: true };
  } catch (error) {
    return toActionError(error);
  }
}
