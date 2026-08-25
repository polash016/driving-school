import type { Role } from "@prisma/client";
import { forbidden, unauthorized } from "next/navigation";
import { ForbiddenError } from "@/lib/errors";
import { authorize, type SessionUser } from "@/server/authz";
import { getSessionUser } from "./index";

/**
 * THE bridge between Next and `authorize()` (architecture §7.2): protected layouts, pages and
 * server actions call this first and nothing else performs role checks.
 *
 * Not authenticated → `unauthorized()` (401 boundary); wrong role → `forbidden()` (403
 * boundary). Both are real status codes via experimental.authInterrupts, so the acceptance
 * test asserts the status and not just the text.
 *
 * `src/app/auth-coverage.test.ts` fails the build if a protected route skips this.
 */
export async function requireUser(role: Role = "STUDENT"): Promise<SessionUser> {
  const session = await getSessionUser();
  try {
    return authorize(session, role);
  } catch (error) {
    if (error instanceof ForbiddenError) forbidden();
    unauthorized();
  }
}
