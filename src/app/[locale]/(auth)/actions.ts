"use server";

import { cookies } from "next/headers";
import { env } from "@/lib/env";
import { TotpSetupRequiredError } from "@/lib/errors";
import { localePath } from "@/lib/locale-url";
import { redirect } from "@/i18n/navigation";
import {
  getCurrentSessionId,
  getSessionUser,
  signIn,
  signOut,
} from "@/server/auth";
import type { ActionError, ActionResult } from "@/server/contracts/common";
import { db } from "@/server/db";
import { toActionError } from "@/server/http/action-result";
import { requestContext } from "@/server/http/request-context";
import { rateLimit } from "@/server/rate-limit";
import {
  completeTotpSetup,
  verifyCredentials,
} from "@/server/services/auth/credentials";
import { emailRateKey } from "@/server/services/auth/crypto";
import {
  resendVerification,
  verifyEmail,
} from "@/server/services/auth/email-verification";
import {
  requestPasswordReset,
  resetPassword,
} from "@/server/services/auth/password-reset";
import { registerViaInvite } from "@/server/services/auth/registration";
import { endSession } from "@/server/services/auth/sessions";
import type { AppLocale } from "../../../../config/school.config";
import { schoolConfig } from "../../../../config/school.config";

/**
 * Public auth server actions (spec-03). Each one: parse the form → rate limit → call the
 * service → return a typed `ActionResult`. No business logic lives here, and no error detail
 * beyond a code and an i18n key ever reaches the client.
 *
 * These routes are intentionally NOT behind `requireUser()` — they are the way in.
 * `src/app/auth-coverage.test.ts` knows this file is public by design.
 */

const TOTP_SETUP_COOKIE = "tp_totp_setup";

function formLocale(formData: FormData): AppLocale {
  const value = String(formData.get("locale") ?? "");
  return (schoolConfig.locales.supported as readonly string[]).includes(value)
    ? (value as AppLocale)
    : schoolConfig.locales.default;
}

function field(formData: FormData, name: string): string {
  return String(formData.get(name) ?? "").trim();
}

export async function loginAction(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const locale = formLocale(formData);
  const ctx = await requestContext();
  let ticketId: string;

  try {
    const totpCode = field(formData, "totpCode");
    const result = await verifyCredentials(
      db,
      {
        email: field(formData, "email"),
        password: String(formData.get("password") ?? ""),
        ...(totpCode ? { totpCode } : {}),
      },
      ctx,
    );
    ticketId = result.ticketId;
  } catch (error) {
    if (error instanceof TotpSetupRequiredError) {
      // Forced admin enrolment: hand the ticket over in an httpOnly cookie, never in the URL.
      (await cookies()).set(TOTP_SETUP_COOKIE, error.ticketId, {
        httpOnly: true,
        sameSite: "lax",
        // Follow the deployment's scheme, not NODE_ENV: a production build served over
        // plain http (local e2e, an internal preview) would never receive a Secure cookie.
        secure: env().APP_BASE_URL.startsWith("https:"),
        path: "/",
        maxAge: 600,
      });
      redirect({ href: "/two-factor-setup", locale });
      // redirect() throws; this keeps the action total for the type checker.
      return { ok: false, code: error.code, messageKey: error.messageKey };
    }
    return toActionError(error);
  }

  await signIn("credentials", { ticketId, redirect: false });
  redirect({ href: "/", locale });
  return { ok: true };
}

export async function completeTotpSetupAction(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const locale = formLocale(formData);
  const ctx = await requestContext();
  const cookieStore = await cookies();
  const ticketId = cookieStore.get(TOTP_SETUP_COOKIE)?.value;

  let loginTicket: string;
  try {
    if (!ticketId) {
      return {
        ok: false,
        code: "UNAUTHENTICATED",
        messageKey: "auth.errors.sessionExpired",
      } satisfies ActionError;
    }
    const result = await completeTotpSetup(
      db,
      ticketId,
      field(formData, "code"),
      ctx,
    );
    loginTicket = result.ticketId;
  } catch (error) {
    return toActionError(error);
  }

  cookieStore.delete(TOTP_SETUP_COOKIE);
  await signIn("credentials", { ticketId: loginTicket, redirect: false });
  redirect({ href: "/", locale });
  return { ok: true };
}

export async function registerAction(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const ctx = await requestContext();
  try {
    await rateLimit("registerIp", ctx.ip ?? "unknown");
    await registerViaInvite(
      db,
      {
        inviteToken: field(formData, "inviteToken"),
        email: field(formData, "email"),
        password: String(formData.get("password") ?? ""),
        firstName: field(formData, "firstName"),
        lastName: field(formData, "lastName"),
        preferredLocale: formLocale(formData),
      },
      ctx,
    );
    return { ok: true };
  } catch (error) {
    return toActionError(error);
  }
}

export async function forgotPasswordAction(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const ctx = await requestContext();
  const email = field(formData, "email");
  try {
    await rateLimit("passwordResetIp", ctx.ip ?? "unknown");
    await rateLimit("passwordResetEmail", emailRateKey(email));
    await requestPasswordReset(db, { email }, ctx);
  } catch (error) {
    // Everything except a rate-limit block reports success: whether an address exists is
    // not something this endpoint may reveal.
    const mapped = toActionError(error);
    if (mapped.code === "RATE_LIMITED" || mapped.code === "VALIDATION")
      return mapped;
  }
  return { ok: true };
}

export async function resetPasswordAction(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const ctx = await requestContext();
  try {
    await rateLimit("tokenConsumeIp", ctx.ip ?? "unknown");
    await resetPassword(
      db,
      {
        token: field(formData, "token"),
        password: String(formData.get("password") ?? ""),
      },
      ctx,
    );
    return { ok: true };
  } catch (error) {
    return toActionError(error);
  }
}

export async function verifyEmailAction(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const ctx = await requestContext();
  try {
    await rateLimit("tokenConsumeIp", ctx.ip ?? "unknown");
    await verifyEmail(db, field(formData, "token"), ctx);
    return { ok: true };
  } catch (error) {
    return toActionError(error);
  }
}

export async function resendVerificationAction(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const ctx = await requestContext();
  const email = field(formData, "email");
  try {
    await rateLimit("passwordResetIp", ctx.ip ?? "unknown");
    await rateLimit("passwordResetEmail", emailRateKey(email));
    await resendVerification(db, email);
  } catch (error) {
    const mapped = toActionError(error);
    if (mapped.code === "RATE_LIMITED" || mapped.code === "VALIDATION")
      return mapped;
  }
  return { ok: true };
}

export async function logoutAction(formData: FormData): Promise<void> {
  const locale = formLocale(formData);
  const [user, sessionId] = await Promise.all([
    getSessionUser(),
    getCurrentSessionId(),
  ]);
  // Clear the server-side session too — dropping the cookie alone would leave the row usable.
  if (user && sessionId) {
    await endSession(db, user.id, sessionId, await requestContext());
  }
  await signOut({ redirectTo: localePath(locale, "/login") });
}
