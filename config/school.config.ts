import { z } from "zod";
import { localeSchema as bcp47LocaleSchema } from "../src/lib/locale";

/**
 * School deployment config — THE single place a school's identity and policy
 * defaults live. Contains no secrets (safe to import anywhere); secrets live in env.
 *
 * Runtime-changeable policies live in the DB Setting table (spec-11); license-class
 * parameters live in the LicenseClass table (spec-02) — values here are seed defaults.
 */

/**
 * Shape only — which languages actually exist is runtime data in the `Language` table (spec-15).
 * The list below is the COMPILED FALLBACK: the two languages whose catalogues and content ship
 * inside the app, and therefore the ones that keep working when the database is unreachable.
 */
const localeSchema = bcp47LocaleSchema;

export const schoolConfigSchema = z
  .object({
    school: z.object({
      name: z.string().min(1),
      shortName: z.string().min(1),
      orgNr: z.string().regex(/^\d{9}$/),
      domain: z.string().min(1),
      contactEmail: z.email(),
    }),
    branding: z.object({
      logoLight: z.string().startsWith("/"),
      logoDark: z.string().startsWith("/"),
    }),
    locales: z.object({
      /** The compiled-in languages. Added languages live in the DB, not here. */
      supported: z.array(localeSchema).nonempty(),
      default: localeSchema,
      /**
       * IANA zone every server-rendered date is formatted in. Without it next-intl falls back
       * to the server's own zone, so a container in another region would show students the
       * wrong times ("last active", exam timestamps).
       */
      timeZone: z
        .string()
        .refine(
          (zone) => Intl.supportedValuesOf("timeZone").includes(zone),
          "must be an IANA time zone",
        ),
    }),
    licenseClassSeeds: z
      .array(
        z.object({
          code: z.string().min(1),
          questionCount: z.int().positive(),
          timeLimitMin: z.int().positive(),
          passMark: z.int().positive(),
        }),
      )
      .nonempty(),
    featureFlags: z.object({
      signTest: z.boolean(),
      /** Vipps Login (spec-03 ships the adapter stub only; the flow lands in a later spec). */
      vippsLogin: z.boolean(),
      trailerCalculator: z.boolean(),
      passGuarantee: z.boolean(),
      studentPayments: z.boolean(),
    }),
    ai: z.object({
      /** Model ids resolved by the OmniRoute gateway — never inline model strings in code. */
      models: z.object({
        vision: z.string().min(1),
        generation: z.string().min(1),
        validation: z.string().min(1),
        embedding: z.string().min(1),
        /** Translation runs at volume, so it is routed separately from generation on purpose. */
        translation: z.string().min(1),
      }),
      dailyBudgetUsd: z.number().positive(),
      /**
       * Deadline on every provider request (spec-19 layer 0). A person reloads a hung page; an
       * unattended worker has nobody to give up, so the adapter must. Generous on purpose: the
       * self-hosted model measured 0.5 s one day and 29.7 s the next for the same call, and a
       * 5-unit translation batch asks for 8192 tokens.
       */
      requestTimeoutMs: z.number().int().positive(),
      /** "Test connection" budget. A healthy OmniRoute ping measured 7–13 s; 29.7 s under load. */
      pingTimeoutMs: z.number().int().positive(),
      /** Units per translation call. 20 fits the output window with headroom for Latin scripts;
       *  non-Latin scripts start at half and the runner halves further on truncation. */
      translationBatchSize: z.number().int().min(1).max(50),
      /** Output cap per translation call. Must not exceed the routed model's own cap — Gemini 2.0
       *  Flash-Lite rejects >8192 with a non-retryable 400. Raise only after verifying the route. */
      translationMaxTokens: z.number().int().min(1024),
      /** Batches in flight inside one run. Keep ≤ (DB pool − 2). */
      translationParallelSlots: z.number().int().min(1).max(8),
      /** A 429 is waited out on the same route — 5 s, 10 s, 20 s, 40 s with jitter — before the
       *  chain moves on. Per-minute quotas recover; falling through only wastes the next route's
       *  quota too. */
      rateLimitRetries: z.number().int().min(0).max(8),
      rateLimitBaseDelayMs: z.number().int().min(250),
    }),
    /**
     * Where uploaded question images live (spec-06 amendment D3). The driver is config, not code,
     * so a school can start on a VPS directory and move to object storage without a rewrite.
     *
     * Credentials are NEVER here — they come from the environment (see `storageEnv` below).
     * Nothing in this block is a secret; it is committed and read on the client-safe path.
     */
    storage: z.object({
      driver: z.enum(["local", "s3"]),
      /**
       * Absolute or repo-relative directory for the `local` driver. Deliberately OUTSIDE
       * `public/`: these bytes are served through an authenticated route, never as static files.
       */
      localDir: z.string().min(1),
      /** `s3` driver only. Endpoint is set for S3-compatible stores (MinIO, Hetzner, Backblaze). */
      bucket: z.string().optional(),
      region: z.string().optional(),
      endpoint: z.string().optional(),
      /** Reject anything larger at the boundary, before a byte is written. */
      maxUploadBytes: z.int().positive(),
      /** Batch ceiling for one upload request. */
      maxBatch: z.int().positive(),
    }),
    examPolicyDefaults: z.object({
      focusLossPolicy: z.enum(["warn", "log", "autosubmit"]),
      attemptCooldownMin: z.int().nonnegative(),
    }),
  })
  .strict();

export type SchoolConfig = z.infer<typeof schoolConfigSchema>;
export type AppLocale = z.infer<typeof localeSchema>;

export const schoolConfig: SchoolConfig = Object.freeze(
  schoolConfigSchema.parse({
    school: {
      name: "TeoriPro Trafikkskole",
      shortName: "TeoriPro",
      orgNr: "999999999",
      domain: "demo.teoripro.no",
      contactEmail: "post@demo.teoripro.no",
    },
    branding: {
      logoLight: "/logo.svg",
      logoDark: "/logo-dark.svg",
    },
    locales: {
      supported: ["en", "nb"],
      default: "en",
      timeZone: "Europe/Oslo",
    },
    licenseClassSeeds: [
      { code: "B", questionCount: 45, timeLimitMin: 90, passMark: 38 },
    ],
    featureFlags: {
      signTest: true,
      vippsLogin: false,
      trailerCalculator: true,
      passGuarantee: false,
      studentPayments: false,
    },
    ai: {
      models: {
        vision: "vision-default",
        generation: "generation-default",
        validation: "validation-default",
        embedding: "embedding-default",
        translation: "translation-default",
      },
      dailyBudgetUsd: 20,
      requestTimeoutMs: 180_000,
      pingTimeoutMs: 60_000,
      translationBatchSize: 20,
      translationMaxTokens: 8192,
      translationParallelSlots: 3,
      rateLimitRetries: 4,
      rateLimitBaseDelayMs: 5_000,
    },
    storage: {
      driver: "local",
      localDir: process.env.STORAGE_LOCAL_DIR ?? "storage",
      bucket: process.env.STORAGE_BUCKET,
      region: process.env.STORAGE_REGION,
      endpoint: process.env.STORAGE_ENDPOINT,
      maxUploadBytes: 15 * 1024 * 1024,
      maxBatch: 50,
    },
    examPolicyDefaults: {
      focusLossPolicy: "warn",
      attemptCooldownMin: 0,
    },
  }),
);
