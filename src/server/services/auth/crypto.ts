import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { env } from "@/lib/env";
import { InternalError } from "@/lib/errors";

/**
 * Auth cryptography primitives (spec-03). Framework-agnostic.
 *
 * - Emailed tokens (verify / reset) are random 256-bit values; only their sha256 hash is stored,
 *   so a database leak cannot be replayed against the app.
 * - The TOTP secret is encrypted at rest with a key derived from AUTH_SECRET (HKDF-SHA256),
 *   so it is useless without the deployment's signing secret.
 */

const ENCRYPTION_INFO = "teoripro:totp:v1";
const CIPHER = "aes-256-gcm";
const IV_BYTES = 12;

function encryptionKey(): Buffer {
  return Buffer.from(
    hkdfSync("sha256", env().AUTH_SECRET, "teoripro-auth-salt", ENCRYPTION_INFO, 32),
  );
}

/** URL-safe single-use token for verification and reset links. */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Stored form of an emailed token — the plaintext never touches the database. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Stable, non-reversible key for per-email rate-limit counters, so Redis never
 * holds an address in plaintext.
 */
export function emailRateKey(email: string): string {
  return createHash("sha256")
    .update(email.trim().toLowerCase())
    .digest("hex")
    .slice(0, 32);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** AES-256-GCM, formatted `v1.<iv>.<tag>.<ciphertext>` (all base64url). */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(CIPHER, encryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptSecret(payload: string): string {
  const [version, iv, tag, ciphertext] = payload.split(".");
  if (version !== "v1" || !iv || !tag || !ciphertext) {
    throw new InternalError({ reason: "malformed encrypted secret" });
  }
  const decipher = createDecipheriv(
    CIPHER,
    encryptionKey(),
    Buffer.from(iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
