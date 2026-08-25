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
      timeZone: z.string().refine(
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
    },
    examPolicyDefaults: {
      focusLossPolicy: "warn",
      attemptCooldownMin: 0,
    },
  }),
);
