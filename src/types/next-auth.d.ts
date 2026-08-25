import type { Role } from "@prisma/client";
import type { DefaultSession } from "next-auth";

/**
 * Session/JWT shape for this app (spec-03). `sid` is the UserSession row id — the JWT is
 * useless once that row is revoked, which is how logout-everywhere works under the
 * credentials-mandated JWT strategy.
 *
 * Only `next-auth` itself is augmented here: `next-auth/jwt` merely re-exports
 * `@auth/core/jwt` (which pnpm does not expose at the project root), so JWT claims are typed
 * locally in `src/server/auth/config.ts` instead.
 */
declare module "next-auth" {
  interface User {
    role: Role;
    sid: string;
  }

  interface Session {
    user: {
      id: string;
      role: Role;
      sid: string;
    } & DefaultSession["user"];
  }
}

export {};
