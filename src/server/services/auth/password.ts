import { hash, verify, type Algorithm } from "@node-rs/argon2";
import { ValidationError } from "@/lib/errors";
import { logger } from "@/lib/logger";

/**
 * Password hashing and policy (spec-03).
 *
 * argon2id with the OWASP baseline parameters: 19 MiB memory, 2 iterations, 1 lane.
 * These are asserted by password.test.ts against the encoded hash header, so a silent
 * downgrade fails the build.
 */
/** Algorithm.Argon2id — inlined as a literal: ambient const enums cannot be imported under isolatedModules. */
const ARGON2ID = 2 as Algorithm;

export const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19456, // KiB = 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

/** Minimum length also enforced by `passwordSchema` in contracts/auth.ts. */
export const MIN_PASSWORD_LENGTH = 10;

/**
 * Passwords that pass a 10-char length check but are still trivially guessable.
 * Norwegian entries included — this deployment's users type Norwegian.
 */
const COMMON_PASSWORDS = new Set([
  "password12",
  "password123",
  "passord123",
  "passord1234",
  "1234567890",
  "12345678910",
  "qwertyuiop",
  "qwerty12345",
  "iloveyou12",
  "letmein123",
  "welcome123",
  "adminadmin",
  "administrator",
  "teoripro123",
  "trafikkskole",
  "norge12345",
  "fotball123",
  "sommer2026",
  "vinter2026",
]);

export async function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, ARGON2_OPTIONS);
}

/** Constant-time verification; a malformed stored hash is a failure, never a crash. */
export async function verifyPassword(
  storedHash: string,
  plaintext: string,
): Promise<boolean> {
  try {
    return await verify(storedHash, plaintext, ARGON2_OPTIONS);
  } catch (error) {
    logger.warn({ error }, "password verification failed to run");
    return false;
  }
}

/**
 * Server-side policy check (client validation is UX sugar only).
 * Throws ValidationError carrying the specific bilingual message key.
 */
export function assertPasswordPolicy(password: string, email?: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new ValidationError(
      { field: "password", reason: "too short" },
      "auth.errors.passwordTooShort",
    );
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    throw new ValidationError(
      { field: "password", reason: "common" },
      "auth.errors.passwordTooCommon",
    );
  }
  const localPart = email?.split("@")[0]?.trim().toLowerCase();
  if (localPart && localPart.length >= 3 && password.toLowerCase().includes(localPart)) {
    throw new ValidationError(
      { field: "password", reason: "contains email" },
      "auth.errors.passwordSameAsEmail",
    );
  }
}
