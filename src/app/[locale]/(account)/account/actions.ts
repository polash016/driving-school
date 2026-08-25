"use server";

import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/server/contracts/common";
import type { TotpSetup } from "@/server/contracts/auth";
import { getCurrentSessionId } from "@/server/auth";
import { requireUser } from "@/server/auth/require-user";
import { db } from "@/server/db";
import { toActionError } from "@/server/http/action-result";
import { requestContext } from "@/server/http/request-context";
import { changePassword } from "@/server/services/auth/password-reset";
import { revokeSession } from "@/server/services/auth/sessions";
import {
  confirmTotpEnrolment,
  disableTotp,
  startTotpEnrolment,
} from "@/server/services/auth/totp-enrolment";

/** Account security actions (spec-03). Every one begins with requireUser(). */

export async function changePasswordAction(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  try {
    await changePassword(
      db,
      user.id,
      String(formData.get("currentPassword") ?? ""),
      String(formData.get("newPassword") ?? ""),
      {
        ...(await requestContext()),
        currentSessionId: (await getCurrentSessionId()) ?? undefined,
      },
    );
    revalidatePath("/account/security");
    return { ok: true };
  } catch (error) {
    return toActionError(error);
  }
}

export async function startTotpAction(): Promise<ActionResult<TotpSetup>> {
  const user = await requireUser();
  try {
    return { ok: true, data: await startTotpEnrolment(db, user) };
  } catch (error) {
    return toActionError(error);
  }
}

export async function confirmTotpAction(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  try {
    await confirmTotpEnrolment(
      db,
      user,
      String(formData.get("code") ?? "").trim(),
      await requestContext(),
    );
    revalidatePath("/account/security");
    return { ok: true };
  } catch (error) {
    return toActionError(error);
  }
}

export async function disableTotpAction(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  try {
    await disableTotp(db, user, String(formData.get("password") ?? ""), {
      ...(await requestContext()),
      currentSessionId: (await getCurrentSessionId()) ?? undefined,
    });
    revalidatePath("/account/security");
    return { ok: true };
  } catch (error) {
    return toActionError(error);
  }
}

export async function revokeSessionAction(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  try {
    await revokeSession(
      db,
      user,
      String(formData.get("sessionId") ?? ""),
      await requestContext(),
    );
    revalidatePath("/account/security");
    return { ok: true };
  } catch (error) {
    return toActionError(error);
  }
}
