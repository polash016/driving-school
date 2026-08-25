import { ZodError } from "zod";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import type { ActionError } from "@/server/contracts/common";

/**
 * Maps a thrown error onto the wire shape server actions return (spec-03).
 * `AppError.meta` and stack traces stay in the logs — clients only ever receive a code and an
 * i18n key (architecture §8).
 */
export function toActionError(error: unknown): ActionError {
  if (error instanceof ZodError) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of error.issues) {
      const field = issue.path.join(".");
      if (field) fieldErrors[field] = "errors.validation";
    }
    logger.warn({ issues: error.issues }, "action input rejected");
    return {
      ok: false,
      code: "VALIDATION",
      messageKey: "errors.validation",
      ...(Object.keys(fieldErrors).length > 0 ? { fieldErrors } : {}),
    };
  }

  if (error instanceof AppError) {
    logger.warn(
      { code: error.code, messageKey: error.messageKey, meta: error.meta },
      "action failed",
    );
    return { ok: false, code: error.code, messageKey: error.messageKey };
  }

  logger.error({ error }, "unhandled action error");
  return { ok: false, code: "INTERNAL", messageKey: "errors.internal" };
}
