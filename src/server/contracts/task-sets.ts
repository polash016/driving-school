import { z } from "zod";
import { idSchema } from "./common";

/**
 * Task set contracts (spec-16). Input AND output are parsed — a set's numbers reach a student as
 * "45 questions, pass at 38", so a malformed row must fail at the boundary rather than render as
 * a confident wrong promise.
 */

export const taskSetStatusSchema = z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]);

export const buildTaskSetsInputSchema = z
  .object({ licenseClassCode: z.string().min(1) })
  .strict();
export type BuildTaskSetsInput = z.infer<typeof buildTaskSetsInputSchema>;

export const publishTaskSetsInputSchema = z
  .object({ buildId: idSchema })
  .strict();
export type PublishTaskSetsInput = z.infer<typeof publishTaskSetsInputSchema>;

/** What an admin reads before publishing: is this slice actually a fair paper's worth? */
export const sliceCompositionSchema = z.object({
  topicCounts: z.record(z.string(), z.number().int()),
  typeCounts: z.record(z.string(), z.number().int()),
  avgDifficulty: z.number(),
  warnings: z.array(z.string()),
});
export type SliceComposition = z.infer<typeof sliceCompositionSchema>;

export const taskSetSummarySchema = z.object({
  id: idSchema,
  number: z.int().min(1),
  status: taskSetStatusSchema,
  poolSize: z.int().min(1),
  paperSize: z.int().min(1),
  passMark: z.int().min(1),
  timeLimitSec: z.int().min(1),
  composition: sliceCompositionSchema,
});
export type TaskSetSummary = z.infer<typeof taskSetSummarySchema>;

export const buildResultSchema = z.object({
  buildId: idSchema,
  sets: z.array(taskSetSummarySchema),
  itemsPlaced: z.int().min(0),
  orphaned: z.array(idSchema),
  warnings: z.array(z.string()),
});
export type BuildResult = z.infer<typeof buildResultSchema>;

export const adminBuildSchema = z.object({
  id: idSchema,
  createdAt: z.date(),
  published: z.boolean(),
  requestedByEmail: z.string().nullable(),
  warnings: z.array(z.string()),
  sets: z.array(taskSetSummarySchema),
});
export type AdminBuild = z.infer<typeof adminBuildSchema>;

/** One numbered tile, as the student's grid needs it. Carries no correctness, ever. */
export const studentTaskSetSchema = z.object({
  id: idSchema,
  number: z.int().min(1),
  poolSize: z.int().min(1),
  paperSize: z.int().min(1),
  passMark: z.int().min(1),
  timeLimitSec: z.int().min(1),
  attempts: z.int().min(0),
  bestCorrect: z.number().int().nullable(),
  bestOutOf: z.number().int().nullable(),
  passed: z.boolean(),
  /** Set when this student left an attempt at this set open — the tile offers Resume. */
  inProgressAttemptId: idSchema.nullable(),
});
export type StudentTaskSet = z.infer<typeof studentTaskSetSchema>;

export const studentTaskSetBoardSchema = z.object({
  sets: z.array(studentTaskSetSchema),
  passedCount: z.int().min(0),
  totalCount: z.int().min(0),
  /** The lowest number not yet passed — what the homepage hero points at. */
  nextNumber: z.number().int().nullable(),
});
export type StudentTaskSetBoard = z.infer<typeof studentTaskSetBoardSchema>;

/** One past sitting, for the start sheet's history list. */
export const taskSetAttemptSchema = z.object({
  id: idSchema,
  startedAt: z.date(),
  submittedAt: z.date().nullable(),
  status: z.enum(["IN_PROGRESS", "SUBMITTED", "EXPIRED"]),
  correctCount: z.number().int().nullable(),
  outOf: z.int().min(1),
  passed: z.boolean().nullable(),
});
export type TaskSetAttempt = z.infer<typeof taskSetAttemptSchema>;
