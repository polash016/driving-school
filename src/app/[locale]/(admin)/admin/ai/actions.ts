"use server";

import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/server/contracts/common";
import { requireUser } from "@/server/auth/require-user";
import { db } from "@/server/db";
import { toActionError } from "@/server/http/action-result";
import {
  createProvider,
  deleteProvider,
  deleteRoute,
  rotateProviderKey,
  testProvider,
  upsertRoute,
} from "@/server/services/ai/providers";

/**
 * AI provider administration (spec-05). ADMIN only: these actions hold the school's API keys.
 * No action ever returns a key — the screen works from a four-character hint.
 */

function field(formData: FormData, name: string): string {
  return String(formData.get(name) ?? "").trim();
}

export async function addProviderAction(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser("ADMIN");
  try {
    const baseUrl = field(formData, "baseUrl");
    await createProvider(db, user, {
      kind: field(formData, "kind"),
      label: field(formData, "label"),
      ...(baseUrl ? { baseUrl } : {}),
      apiKey: field(formData, "apiKey"),
    });
    revalidatePath("/admin/ai");
    return { ok: true };
  } catch (error) {
    return toActionError(error);
  }
}

export async function rotateKeyAction(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser("ADMIN");
  try {
    await rotateProviderKey(db, user, field(formData, "providerId"), field(formData, "apiKey"));
    revalidatePath("/admin/ai");
    return { ok: true };
  } catch (error) {
    return toActionError(error);
  }
}

export async function deleteProviderAction(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser("ADMIN");
  try {
    await deleteProvider(db, user, field(formData, "providerId"));
    revalidatePath("/admin/ai");
    return { ok: true };
  } catch (error) {
    return toActionError(error);
  }
}

export interface TestOutcome {
  ok: boolean;
  ms: number;
  error?: string;
}

export async function testProviderAction(
  _prev: ActionResult<TestOutcome> | undefined,
  formData: FormData,
): Promise<ActionResult<TestOutcome>> {
  const user = await requireUser("ADMIN");
  try {
    const outcome = await testProvider(
      db,
      user,
      field(formData, "providerId"),
      field(formData, "model"),
    );
    revalidatePath("/admin/ai");
    return { ok: true, data: outcome };
  } catch (error) {
    return toActionError(error);
  }
}

export async function saveRouteAction(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser("ADMIN");
  try {
    await upsertRoute(db, user, {
      task: field(formData, "task"),
      providerId: field(formData, "providerId"),
      model: field(formData, "model"),
      priority: Number(formData.get("priority") ?? 0),
    });
    revalidatePath("/admin/ai");
    return { ok: true };
  } catch (error) {
    return toActionError(error);
  }
}

export async function deleteRouteAction(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser("ADMIN");
  try {
    await deleteRoute(db, user, field(formData, "routeId"));
    revalidatePath("/admin/ai");
    return { ok: true };
  } catch (error) {
    return toActionError(error);
  }
}
