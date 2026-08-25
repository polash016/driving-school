import { Secret, TOTP } from "otpauth";
import { schoolConfig } from "../../../../config/school.config";

/**
 * TOTP (RFC 6238) — required for ADMIN, optional for INSTRUCTOR (spec-03).
 * Pure module: the encrypted-at-rest secret and replay protection live in the
 * credentials service; this file only generates and validates codes.
 */

const DIGITS = 6;
const PERIOD_SEC = 30;
/** ±1 step tolerates clock skew between phone and server without widening the attack window. */
const VALIDATION_WINDOW = 1;

function totpFor(secretBase32: string, label: string): TOTP {
  return new TOTP({
    issuer: schoolConfig.school.shortName,
    label,
    algorithm: "SHA1", // authenticator apps default to SHA1; changing it breaks existing enrolments
    digits: DIGITS,
    period: PERIOD_SEC,
    secret: Secret.fromBase32(secretBase32),
  });
}

export function generateTotpSecret(): string {
  return new Secret({ size: 20 }).base32;
}

/** otpauth:// URI for the QR code shown during setup. */
export function totpUri(secretBase32: string, accountLabel: string): string {
  return totpFor(secretBase32, accountLabel).toString();
}

export function verifyTotpCode(
  secretBase32: string,
  code: string,
  at?: Date,
): boolean {
  const token = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(token)) return false;
  const delta = totpFor(secretBase32, "verify").validate({
    token,
    timestamp: at?.getTime(),
    window: VALIDATION_WINDOW,
  });
  return delta !== null;
}

/** Current code for a secret — used by tests and the CLI, never in a request path. */
export function currentTotpCode(secretBase32: string, at?: Date): string {
  return totpFor(secretBase32, "generate").generate({ timestamp: at?.getTime() });
}
