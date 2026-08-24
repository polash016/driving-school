import { z } from "zod";

/**
 * School deployment config — THE single place a school's identity and policy
 * defaults live. Contains no secrets (safe to import anywhere); secrets live in env.
 *
 * Runtime-changeable policies live in the DB Setting table (spec-11); license-class
 * parameters live in the LicenseClass table (spec-02) — values here are seed defaults.
 */

const localeSchema = z.enum(["en", "nb"]);

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
      supported: z.array(localeSchema).nonempty(),
      default: localeSchema,
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
      }),
      dailyBudgetUsd: z.number().positive(),
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
    },
    licenseClassSeeds: [
      { code: "B", questionCount: 45, timeLimitMin: 90, passMark: 38 },
    ],
    featureFlags: {
      signTest: true,
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
      },
      dailyBudgetUsd: 20,
    },
    examPolicyDefaults: {
      focusLossPolicy: "warn",
      attemptCooldownMin: 0,
    },
  }),
);
