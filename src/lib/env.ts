import { z } from "zod";

/**
 * Server env validation at boot (mandate: fail fast on misconfiguration).
 * Secrets live ONLY here — never in school.config.ts and never in client bundles.
 */
const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  // AI gateway (OmniRoute, OpenAI-compatible). Optional at boot; the AI client
  // throws a typed error on first use if missing.
  OMNIROUTE_BASE_URL: z.string().url().optional(),
  OMNIROUTE_API_KEY: z.string().min(1).optional(),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function env(): Env {
  cached ??= envSchema.parse(process.env);
  return cached;
}
