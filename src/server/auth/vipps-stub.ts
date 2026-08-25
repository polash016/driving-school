import type { OIDCConfig } from "next-auth/providers";
import { InternalError } from "@/lib/errors";
import { schoolConfig } from "../../../config/school.config";

/**
 * ─── VIPPS LOGIN — NOT IMPLEMENTED ───────────────────────────────────────────────────
 *
 * Spec-03 ships this adapter stub and the `vippsLogin` feature flag only; the working flow
 * is a later spec. Nothing here is wired into `authConfig`, and the flag ships `false`.
 *
 * What the real implementation needs (do not guess these at integration time):
 *  - A Vipps merchant account with Login enabled, and `VIPPS_CLIENT_ID` / `VIPPS_CLIENT_SECRET`
 *    added to `src/lib/env.ts` (test issuer: apitest.vipps.no, production: api.vipps.no).
 *  - The Prisma adapter plus an `Account` table — spec-03 deliberately runs credentials-only
 *    without them (DECISIONS 2026-08-24), so enabling OIDC is a schema change, not a config flip.
 *  - An account-linking rule: Vipps returns a verified phone number and name, NOT necessarily
 *    the email the school invited. Linking must go through the invite, never by trusting a
 *    matching email address.
 *  - Norwegian consent/scope review (`openid name phoneNumber email`) — collect the minimum.
 */

export const vippsLoginEnabled = schoolConfig.featureFlags.vippsLogin;

/**
 * Placeholder provider factory. Calling it is a programming error until the flow is built —
 * it throws rather than silently returning a half-configured provider.
 */
export function vippsProvider(): OIDCConfig<Record<string, unknown>> {
  throw new InternalError({
    reason: "Vipps Login is not implemented yet (spec-03 stub)",
  });
}

/** Providers to append to `authConfig` once Vipps lands. Empty by design today. */
export function optionalProviders(): [] {
  return [];
}
