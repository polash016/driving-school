import { describe, expect, it } from "vitest";
import {
  currentTotpCode,
  generateTotpSecret,
  totpUri,
  verifyTotpCode,
} from "./totp";

/** RFC 6238 reference secret ("12345678901234567890" in base32) with its published codes. */
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("TOTP", () => {
  it("matches the RFC 6238 SHA-1 test vectors", () => {
    // T = 59s → 94287082 (8 digits); the 6-digit truncation is the last six.
    expect(currentTotpCode(RFC_SECRET, new Date(59_000))).toBe("287082");
    expect(currentTotpCode(RFC_SECRET, new Date(1_111_111_109_000))).toBe("081804");
  });

  it("accepts the current code and rejects an unrelated one", () => {
    const secret = generateTotpSecret();
    const at = new Date("2026-08-24T10:00:00Z");
    expect(verifyTotpCode(secret, currentTotpCode(secret, at), at)).toBe(true);
    expect(verifyTotpCode(secret, "000000", at)).toBe(false);
  });

  it("tolerates one step of clock skew but not two", () => {
    const secret = generateTotpSecret();
    const at = new Date("2026-08-24T10:00:00Z");
    const code = currentTotpCode(secret, at);

    expect(verifyTotpCode(secret, code, new Date(at.getTime() + 30_000))).toBe(true);
    expect(verifyTotpCode(secret, code, new Date(at.getTime() - 30_000))).toBe(true);
    expect(verifyTotpCode(secret, code, new Date(at.getTime() + 90_000))).toBe(false);
  });

  it("rejects malformed input without throwing", () => {
    const secret = generateTotpSecret();
    expect(verifyTotpCode(secret, "12345")).toBe(false);
    expect(verifyTotpCode(secret, "abcdef")).toBe(false);
    expect(verifyTotpCode(secret, "")).toBe(false);
  });

  it("builds an otpauth URI an authenticator app can read", () => {
    const uri = totpUri(RFC_SECRET, "kari@example.no");
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain("secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });

  it("generates distinct base32 secrets", () => {
    const secrets = new Set(Array.from({ length: 50 }, generateTotpSecret));
    expect(secrets.size).toBe(50);
    for (const secret of secrets) expect(secret).toMatch(/^[A-Z2-7]+$/);
  });
});
