import { describe, expect, it } from "vitest";
import { InternalError } from "@/lib/errors";
import {
  decryptSecret,
  emailRateKey,
  encryptSecret,
  generateToken,
  hashToken,
  normalizeEmail,
} from "./crypto";

describe("auth crypto", () => {
  it("generates unguessable, URL-safe tokens", () => {
    const tokens = new Set(Array.from({ length: 200 }, generateToken));
    expect(tokens.size).toBe(200);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });

  it("hashes tokens deterministically and irreversibly", () => {
    const token = generateToken();
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).not.toContain(token);
  });

  it("round-trips an encrypted TOTP secret", () => {
    const secret = "JBSWY3DPEHPK3PXP";
    const encrypted = encryptSecret(secret);

    expect(encrypted).not.toContain(secret);
    expect(encrypted.startsWith("v1.")).toBe(true);
    expect(decryptSecret(encrypted)).toBe(secret);
  });

  it("produces a different ciphertext each time (random IV)", () => {
    expect(encryptSecret("JBSWY3DPEHPK3PXP")).not.toBe(
      encryptSecret("JBSWY3DPEHPK3PXP"),
    );
  });

  it("refuses tampered ciphertext (GCM auth tag)", () => {
    const encrypted = encryptSecret("JBSWY3DPEHPK3PXP");
    const [version, iv, tag, ciphertext] = encrypted.split(".");
    const flipped = `${ciphertext.slice(0, -2)}${ciphertext.slice(-2) === "AA" ? "AB" : "AA"}`;

    expect(() =>
      decryptSecret([version, iv, tag, flipped].join(".")),
    ).toThrow();
    expect(() => decryptSecret("garbage")).toThrow(InternalError);
  });

  it("normalises emails and derives a stable non-reversible rate-limit key", () => {
    expect(normalizeEmail("  Kari@Example.NO ")).toBe("kari@example.no");
    expect(emailRateKey("Kari@Example.no")).toBe(
      emailRateKey("kari@example.no"),
    );
    expect(emailRateKey("kari@example.no")).not.toContain("kari");
    expect(emailRateKey("kari@example.no")).toHaveLength(32);
  });
});
