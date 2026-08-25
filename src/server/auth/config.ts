import type { NextAuthConfig } from "next-auth";
import type { Role } from "@prisma/client";
import Credentials from "next-auth/providers/credentials";
import { logger } from "@/lib/logger";
import { localePath } from "@/lib/locale-url";
import { db } from "@/server/db";
import { consumeLoginTicket } from "@/server/services/auth/credentials";
import { isSessionValid, touchSession } from "@/server/services/auth/sessions";
import { schoolConfig } from "../../../config/school.config";

/**
 * Auth.js configuration (spec-03). Deliberately thin: every credential check happens in
 * `src/server/services/auth/credentials.ts`, which hands this provider a ONE-TIME ticket
 * (DECISIONS 2026-08-24). Auth.js only mints and validates the session cookie.
 */
/** Claims this app puts on the session JWT (see src/types/next-auth.d.ts for why it is local). */
type AppClaims = { role?: Role; sid?: string };

export const authConfig = {
  // Credentials logins cannot use database sessions; revocation is enforced via `sid` below.
  session: { strategy: "jwt", maxAge: 30 * 24 * 60 * 60 },
  pages: {
    signIn: localePath(schoolConfig.locales.default, "/login"),
    error: localePath(schoolConfig.locales.default, "/login"),
  },
  providers: [
    Credentials({
      // The ticket is the only credential this provider accepts — no password reaches Auth.js.
      credentials: { ticketId: { type: "text" } },
      async authorize(credentials) {
        const ticketId =
          typeof credentials?.ticketId === "string"
            ? credentials.ticketId
            : null;
        if (!ticketId) return null;
        try {
          const user = await consumeLoginTicket(db, ticketId);
          return {
            id: user.id,
            email: user.email,
            role: user.role,
            sid: user.sessionId,
          };
        } catch (error) {
          logger.warn({ error }, "login ticket rejected");
          return null;
        }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      const claims = token as typeof token & AppClaims;
      if (user) {
        claims.role = user.role;
        claims.sid = user.sid;
        return claims;
      }
      // Returning null invalidates the session — this is the revocation chokepoint.
      if (!claims.sid || !(await isSessionValid(db, claims.sid))) return null;
      await touchSession(db, claims.sid);
      return claims;
    },
    session({ session, token }) {
      const claims = token as typeof token & AppClaims;
      session.user.id = claims.sub ?? session.user.id;
      // Fail closed: a token without a role claim gets the least-privileged role.
      session.user.role = claims.role ?? "STUDENT";
      session.user.sid = claims.sid ?? "";
      return session;
    },
  },
} satisfies NextAuthConfig;
