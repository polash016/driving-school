"use server";

import { requireUser } from "@/server/auth/require-user";
import type { ActionResult } from "@/server/contracts/common";
import { toActionError } from "@/server/http/action-result";
import { learnService } from "@/server/services/learn";

/** Save where a student got to. No revalidation: progress is per user and the home card re-reads on navigation. */
export async function recordReadingProgressAction(
  input: { documentId: string; positionPct: number; markRead: boolean },
): Promise<ActionResult<{ readAt: string | null; positionPct: number }>> {
  const user = await requireUser();
  try {
    const result = await learnService.recordProgress(user.id, input);
    return { ok: true, data: { readAt: result.readAt?.toISOString() ?? null, positionPct: result.positionPct } };
  } catch (error) {
    return toActionError(error);
  }
}
