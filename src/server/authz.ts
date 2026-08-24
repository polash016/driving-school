import type { Role } from "@prisma/client";
import { AuthError, ForbiddenError } from "@/lib/errors";

/**
 * THE authorization chokepoint (architecture blueprint §7.2).
 * Every protected route handler / server action calls `authorize()` first.
 * No inline role checks anywhere else — the spec-12 route-inventory test
 * enforces coverage.
 *
 * Session issuance is spec-03 (Auth.js); this module owns only the decision.
 */

export interface SessionUser {
  id: string;
  role: Role;
  email: string;
}

const ROLE_RANK: Record<Role, number> = {
  STUDENT: 0,
  INSTRUCTOR: 1,
  ADMIN: 2,
};

/**
 * Asserts an authenticated session with at least the required role.
 * ADMIN ⊃ INSTRUCTOR ⊃ STUDENT.
 */
export function authorize(
  session: SessionUser | null | undefined,
  requiredRole: Role = "STUDENT",
): SessionUser {
  if (!session) throw new AuthError();
  if (ROLE_RANK[session.role] < ROLE_RANK[requiredRole]) {
    throw new ForbiddenError({ required: requiredRole, actual: session.role });
  }
  return session;
}

/**
 * Ownership guard for user-scoped resources (attempts, dashboards):
 * students may only touch their own rows; INSTRUCTOR+ passes through
 * (group scoping is enforced by the service layer, spec-11).
 */
export function authorizeOwner(
  session: SessionUser | null | undefined,
  ownerId: string,
): SessionUser {
  const user = authorize(session, "STUDENT");
  if (user.id !== ownerId && ROLE_RANK[user.role] < ROLE_RANK.INSTRUCTOR) {
    throw new ForbiddenError({ resourceOwner: ownerId });
  }
  return user;
}
