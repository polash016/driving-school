import NextAuth from "next-auth";
import type { SessionUser } from "@/server/authz";
import { sessionUserSchema } from "@/server/contracts/auth";
import { authConfig } from "./config";

/**
 * Auth.js entry points (spec-03). Server code reads the session through `getSessionUser()`
 * and then hands it to `authorize()` — see `require-user.ts`, the single chokepoint.
 */
export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);

/** The authenticated user, or null. Output is contract-parsed like any other boundary. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await auth();
  if (!session?.user?.email) return null;
  return sessionUserSchema.parse({
    id: session.user.id,
    email: session.user.email,
    role: session.user.role,
  });
}

/** UserSession row id of the current request, for "this device" markers and revocation. */
export async function getCurrentSessionId(): Promise<string | null> {
  const session = await auth();
  return session?.user?.sid ?? null;
}
