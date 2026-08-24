import { z } from "zod";
import { bilingualTextSchema, idSchema, localeSchema } from "./common";

/**
 * Model-level schemas mirroring prisma/schema.prisma for use at API boundaries.
 * Enum value sets are guarded against Prisma's generated enums by contracts.test.ts.
 *
 * IMPORTANT: schemas here are ADMIN/SERVER shapes. Client-bound quiz DTOs live in
 * quiz.ts and structurally exclude correctness (security invariant).
 */

// ── Enums ────────────────────────────────────────────────────────────────────
export const roleSchema = z.enum(["ADMIN", "INSTRUCTOR", "STUDENT"]);
export const quizModeSchema = z.enum(["PRACTICE", "EXAM"]);
export const itemTypeSchema = z.enum(["TEXT", "IMAGE", "SIGN"]);
export const itemStatusSchema = z.enum([
  "DRAFT",
  "IN_REVIEW",
  "APPROVED",
  "NEEDS_REVIEW",
  "RETIRED",
]);
export const provenanceSchema = z.enum(["AI", "HUMAN"]);
export const variantSourceSchema = z.enum(["TEMPLATE", "AI_VARIATION"]);
export const attemptModeSchema = z.enum(["PRACTICE", "EXAM", "TOPIC", "SIGN"]);
export const attemptStatusSchema = z.enum([
  "IN_PROGRESS",
  "SUBMITTED",
  "EXPIRED",
]);
export const imageStatusSchema = z.enum([
  "UPLOADED",
  "ANALYZING",
  "NEEDS_HUMAN_ID",
  "GENERATING",
  "IN_REVIEW",
  "READY",
  "FAILED",
]);
export const signClassSchema = z.enum([
  "FARE",
  "VIKEPLIKT_OG_FORKJORS",
  "FORBUD",
  "PABUD",
  "OPPLYSNING",
  "SERVICE",
  "VEGVISNING",
  "UNDERSKILT",
  "MARKERING",
]);
export const citationTypeSchema = z.enum(["KB_CHUNK", "FACT"]);
export const kbSourceKindSchema = z.enum([
  "LAW",
  "REGULATION",
  "CURRICULUM",
  "TEMALISTE",
  "NOTE",
]);
export const factTypeSchema = z.enum(["NUMBER", "STRING", "BOOLEAN"]);

// ── Content building blocks ─────────────────────────────────────────────────

/** One answer option as authored/rendered — key is stable, text is per-locale. */
export const optionContentSchema = z.object({
  key: z.string().min(1).max(8),
  text: z.string().min(1),
});

/** Per-locale question rendering. */
export const localizedQuestionSchema = z.object({
  stem: z.string().min(1),
  options: z.array(optionContentSchema).min(2).max(6),
});

/** Bilingual rendered question content (ItemVariant.content). Never carries correctness. */
export const variantContentSchema = z.object({
  en: localizedQuestionSchema,
  nb: localizedQuestionSchema,
});

export const legalCitationSchema = z.object({
  sourceCode: z.string().min(1), // KbSource.code, e.g. "trafikkreglene"
  ref: z.string().min(1), // "§ 7-2"
  url: z.string().url().optional(),
});

export const explanationSchema = z.object({
  en: z.string().min(1),
  nb: z.string().min(1),
  citations: z.array(legalCitationSchema),
});

// ── Curriculum ───────────────────────────────────────────────────────────────

export const licenseClassSchema = z.object({
  id: idSchema,
  code: z.string().min(1),
  name: bilingualTextSchema,
  questionCount: z.int().positive(),
  timeLimitMin: z.int().positive(),
  passMark: z.int().positive(),
  isEnabled: z.boolean(),
  sortOrder: z.int(),
});

export const topicSchema = z.object({
  id: idSchema,
  slug: z.string().min(1),
  parentId: idSchema.nullable(),
  name: bilingualTextSchema,
  description: bilingualTextSchema.nullable(),
  sortOrder: z.int(),
  isActive: z.boolean(),
});

export const signSchema = z.object({
  id: idSchema,
  code: z.string().min(1),
  signClass: signClassSchema,
  svgPath: z.string().min(1),
  name: bilingualTextSchema,
  meaning: bilingualTextSchema,
  isActive: z.boolean(),
});

// ── Content (admin shapes) ───────────────────────────────────────────────────

export const masterItemSchema = z.object({
  id: idSchema,
  type: itemTypeSchema,
  status: itemStatusSchema,
  topicId: idSchema,
  licenseClassId: idSchema.nullable(),
  difficulty: z.int().min(1).max(5),
  content: z.object({
    en: localizedQuestionSchema.extend({ explanation: z.string().optional() }),
    nb: localizedQuestionSchema.extend({ explanation: z.string().optional() }),
  }),
  parameterSlots: z.unknown().nullable(),
  legalCitations: z.array(legalCitationSchema),
  version: z.int().positive(),
  createdBy: provenanceSchema,
  modelVersion: z.string().nullable(),
  promptVersion: z.string().nullable(),
  sourceImageId: idSchema.nullable(),
  reviewNote: z.string().nullable(),
});

/** ADMIN-ONLY variant shape — includes correctness; must never be returned to students. */
export const itemVariantAdminSchema = z.object({
  id: idSchema,
  masterItemId: idSchema,
  masterVersion: z.int().positive(),
  contentHash: z.string().min(1),
  content: variantContentSchema,
  correctOptionKey: z.string().min(1),
  explanation: explanationSchema,
  source: variantSourceSchema,
  isActive: z.boolean(),
});

// ── Exam structures ─────────────────────────────────────────────────────────

export const examBlueprintSchema = z.object({
  id: idSchema,
  licenseClassId: idSchema,
  name: bilingualTextSchema.nullable(),
  topicDistribution: z.record(z.string(), z.int().positive()),
  imageRatio: z.number().min(0).max(1),
  isDefault: z.boolean(),
  isActive: z.boolean(),
});

export const attemptSummarySchema = z.object({
  id: idSchema,
  mode: attemptModeSchema,
  status: attemptStatusSchema,
  licenseClassId: idSchema.nullable(),
  questionCountSnapshot: z.int().positive(),
  passMarkSnapshot: z.int().positive().nullable(),
  startedAt: z.date(),
  submittedAt: z.date().nullable(),
  correctCount: z.int().min(0).nullable(),
  passed: z.boolean().nullable(),
});

// ── Progress ────────────────────────────────────────────────────────────────

export const topicMasterySchema = z.object({
  topicId: idSchema,
  totalAnswered: z.int().min(0),
  totalCorrect: z.int().min(0),
  rollingScore: z.number().min(0).max(1),
  lastAnsweredAt: z.date().nullable(),
});

export const readinessSnapshotSchema = z.object({
  score: z.number().min(0).max(100),
  breakdown: z.record(z.string(), z.number()),
  createdAt: z.date(),
});

// ── Knowledge base ──────────────────────────────────────────────────────────

export const kbSourceSchema = z.object({
  id: idSchema,
  code: z.string().min(1),
  kind: kbSourceKindSchema,
  name: z.string().min(1),
  url: z.string().url().nullable(),
  effectiveDate: z.date().nullable(),
  version: z.string().nullable(),
  lastIngestedAt: z.date().nullable(),
});

export const kbChunkSchema = z.object({
  id: idSchema,
  sourceId: idSchema,
  ref: z.string().min(1),
  text: z.string().min(1),
  tokenCount: z.int().positive().nullable(),
  isActive: z.boolean(),
});

export const factSchema = z.object({
  key: z.string().min(1),
  value: z.string().min(1),
  valueType: factTypeSchema,
  unit: z.string().nullable(),
  description: z.string().nullable(),
  sourceRef: legalCitationSchema,
  effectiveFrom: z.date().nullable(),
});

// ── Users (safe projections — never passwordHash/totpSecret over a boundary) ──

export const userSummarySchema = z.object({
  id: idSchema,
  email: z.email(),
  role: roleSchema,
  isActive: z.boolean(),
  profile: z
    .object({
      firstName: z.string(),
      lastName: z.string(),
      preferredLocale: localeSchema,
      preferredQuizMode: quizModeSchema,
    })
    .nullable(),
});
