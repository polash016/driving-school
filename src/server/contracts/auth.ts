import { z } from "zod";
import { idSchema, localeSchema } from "./common";
import { roleSchema } from "./models";

/** Auth & onboarding contracts (spec-03). Passwords never appear in outputs. */

export const passwordSchema = z.string().min(10).max(128);

export const registerViaInviteInputSchema = z
  .object({
    inviteToken: z.string().min(1),
    email: z.email(),
    password: passwordSchema,
    firstName: z.string().min(1).max(100),
    lastName: z.string().min(1).max(100),
    preferredLocale: localeSchema,
  })
  .strict();

export const loginInputSchema = z
  .object({
    email: z.email(),
    password: z.string().min(1),
    totpCode: z.string().length(6).optional(),
  })
  .strict();

export const requestPasswordResetInputSchema = z
  .object({ email: z.email() })
  .strict();

export const resetPasswordInputSchema = z
  .object({ token: z.string().min(1), password: passwordSchema })
  .strict();

export const createInviteInputSchema = z
  .object({
    role: roleSchema.default("STUDENT"),
    groupId: idSchema.optional(),
    maxUses: z.int().min(1).max(500).optional(), // omit = single-use
    expiresInDays: z.int().min(1).max(90).default(14),
  })
  .strict();

export const inviteSchema = z
  .object({
    id: idSchema,
    token: z.string(),
    url: z.string(),
    role: roleSchema,
    groupId: idSchema.nullable(),
    maxUses: z.int().nullable(),
    usedCount: z.int().min(0),
    expiresAt: z.date().nullable(),
    revokedAt: z.date().nullable(),
  })
  .strict();

export const csvImportRowSchema = z
  .object({
    email: z.email(),
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    groupName: z.string().optional(),
  })
  .strict();

export const sessionInfoSchema = z
  .object({
    id: idSchema,
    createdAt: z.date(),
    lastSeenAt: z.date().nullable(),
    userAgent: z.string().nullable(),
    current: z.boolean(),
  })
  .strict();
