import { z } from "zod";

/**
 * Server env validation at boot (mandate: fail fast on misconfiguration).
 * Secrets live ONLY here — never in school.config.ts and never in client bundles.
 */

/**
 * Dev/test fallback so `pnpm test` and a fresh clone run without a .env.
 * Production refuses to boot without a real AUTH_SECRET (checked below).
 */
const DEV_AUTH_SECRET = "dev-only-insecure-auth-secret-0000000000";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  // Auth (spec-03). AUTH_SECRET signs the session JWT and derives the TOTP encryption key.
  AUTH_SECRET: z.string().min(32).optional(),
  AUTH_TRUST_HOST: z.string().optional(),
  /** Absolute base URL used in emailed links (verify, reset, invites). */
  APP_BASE_URL: z.url().default("http://localhost:3000"),
  /** "smtp" = nodemailer, "capture" = in-memory sink (tests), "log" = write to the logger. */
  MAIL_TRANSPORT: z.enum(["smtp", "capture", "log"]).default("capture"),
  SMTP_URL: z.string().optional(),
  EMAIL_FROM: z.string().default("TeoriPro <no-reply@localhost>"),
  // AI gateway (OmniRoute, OpenAI-compatible). Optional at boot; the AI client
  // throws a typed error on first use if missing.
  OMNIROUTE_BASE_URL: z.string().url().optional(),
  OMNIROUTE_API_KEY: z.string().min(1).optional(),
});

export type Env = Omit<z.infer<typeof envSchema>, "AUTH_SECRET"> & {
  AUTH_SECRET: string;
};

let cached: Env | undefined;

export function env(): Env {
  if (cached) return cached;
  const parsed = envSchema.parse(process.env);

  if (parsed.NODE_ENV === "production") {
    const missing: string[] = [];
    if (!parsed.AUTH_SECRET) missing.push("AUTH_SECRET");
    if (parsed.MAIL_TRANSPORT === "smtp" && !parsed.SMTP_URL) {
      missing.push("SMTP_URL");
    }
    if (missing.length > 0) {
      throw new Error(`Missing required production env: ${missing.join(", ")}`);
    }
  }

  cached = { ...parsed, AUTH_SECRET: parsed.AUTH_SECRET ?? DEV_AUTH_SECRET };
  return cached;
}

/** Test helper: forget the memoised env after mutating process.env. */
export function resetEnvCache(): void {
  cached = undefined;
}
