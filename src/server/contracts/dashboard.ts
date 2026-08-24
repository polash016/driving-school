import { z } from "zod";
import { idSchema, localeSchema } from "./common";
import { attemptModeSchema, attemptStatusSchema } from "./models";

/**
 * Student dashboard aggregate (spec-09) — served from ONE cached read
 * (`tp:dash:agg:<userId>`, invalidated on submit/homework change).
 */

export const dashboardStatsSchema = z
  .object({
    passRate: z.number().min(0).max(1).nullable(), // null = no exams yet
    passRateTrend: z.enum(["UP", "DOWN", "FLAT"]).nullable(),
    examsPassed: z.int().min(0),
    streakDays: z.int().min(0),
    readinessScore: z.number().min(0).max(100).nullable(),
  })
  .strict();

export const dashboardTopicSchema = z
  .object({
    topicSlug: z.string(),
    name: z.string(), // localized server-side
    masteryPercent: z.int().min(0).max(100).nullable(), // null = not started (neutral pill, never a red bar)
    totalAnswered: z.int().min(0),
  })
  .strict();

export const dashboardAttemptSchema = z
  .object({
    id: idSchema,
    mode: attemptModeSchema,
    status: attemptStatusSchema,
    startedAt: z.date(),
    correctCount: z.int().min(0).nullable(),
    questionCount: z.int().min(1),
    passed: z.boolean().nullable(),
    /** Exactly ONE clear action per card (spec-09): resume in-progress, review finished. */
    action: z.enum(["RESUME", "REVIEW"]),
  })
  .strict();

export const dashboardHomeworkSchema = z
  .object({
    id: idSchema,
    title: z.string(),
    deadline: z.date(),
    completed: z.boolean(),
  })
  .strict();

export const dashboardAggregateSchema = z
  .object({
    locale: localeSchema,
    stats: dashboardStatsSchema,
    homework: dashboardHomeworkSchema.nullable(),
    topics: z.array(dashboardTopicSchema),
    recentAttempts: z.array(dashboardAttemptSchema).max(10),
    mistakeDeckDueCount: z.int().min(0),
  })
  .strict();
export type DashboardAggregate = z.infer<typeof dashboardAggregateSchema>;
