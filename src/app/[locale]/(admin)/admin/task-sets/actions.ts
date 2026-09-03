"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth/require-user";
import { AUDIT, auditLog } from "@/server/audit";
import type { ActionResult } from "@/server/contracts/common";
import { toActionError } from "@/server/http/action-result";
import { taskSetService } from "@/server/services/task-sets";
import { schoolConfig } from "../../../../../../config/school.config";

/**
 * Task set administration (spec-16).
 *
 * Building and publishing are deliberately two actions. A build only proposes slices; an admin
 * reads each one's composition and warnings and then decides. Nothing a student sits has gone
 * unread by a person.
 */

export async function buildTaskSetsAction(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser("ADMIN");
  // Which class to partition comes from the form, defaulting to the school's primary class —
  // a school teaching more than one class must be able to build sets for each.
  const licenseClassCode =
    String(formData.get("licenseClassCode") ?? "").trim() ||
    schoolConfig.licenseClassSeeds[0].code;
  try {
    const result = await taskSetService.build({ licenseClassCode }, user.id);
    await auditLog({
      actorId: user.id,
      action: AUDIT.taskSetsBuilt,
      entityType: "TaskSetBuild",
      entityId: result.buildId,
      meta: {
        sets: result.sets.length,
        itemsPlaced: result.itemsPlaced,
        warnings: result.warnings.length,
      },
    });
  } catch (error) {
    return toActionError(error);
  }
  revalidatePath("/admin/task-sets");
  return { ok: true };
}

export async function publishTaskSetsAction(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser("ADMIN");
  const buildId = String(formData.get("buildId") ?? "");
  try {
    await taskSetService.publish({ buildId });
    await auditLog({
      actorId: user.id,
      action: AUDIT.taskSetsPublished,
      entityType: "TaskSetBuild",
      entityId: buildId,
    });
  } catch (error) {
    return toActionError(error);
  }
  // Both boards change: the admin list, and every student's grid.
  revalidatePath("/admin/task-sets");
  revalidatePath("/task-sets");
  revalidatePath("/");
  return { ok: true };
}
