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

export const verifyEmailInputSchema = z
  .object({ token: z.string().min(1) })
  .strict();

export const resendVerificationInputSchema = z
  .object({ email: z.email() })
  .strict();

export const changePasswordInputSchema = z
  .object({ currentPassword: z.string().min(1), newPassword: passwordSchema })
  .strict();

export const confirmTotpInputSchema = z
  .object({ code: z.string().length(6) })
  .strict();

export const completeTotpSetupInputSchema = z
  .object({ ticketId: z.string().min(1), code: z.string().length(6) })
  .strict();

export const revokeSessionInputSchema = z
  .object({ sessionId: idSchema })
  .strict();

export const revokeInviteInputSchema = z.object({ inviteId: idSchema }).strict();

export const importStudentsInputSchema = z
  .object({
    csv: z.string().min(1).max(1_000_000),
    groupId: idSchema.optional(),
    expiresInDays: z.int().min(1).max(90).default(14),
  })
  .strict();

/** 2FA enrolment payload — the secret is shown once, at setup time, and never again. */
export const totpSetupSchema = z
  .object({
    secret: z.string().min(16),
    otpauthUri: z.string().startsWith("otpauth://"),
    qrDataUrl: z.string().startsWith("data:image/"),
  })
  .strict();

export const csvImportRowResultSchema = z
  .object({
    email: z.string(),
    status: z.enum(["invited", "exists", "invalid"]),
    messageKey: z.string(),
  })
  .strict();

export const csvImportResultSchema = z
  .object({
    invited: z.int().min(0),
    skipped: z.int().min(0),
    rows: z.array(csvImportRowResultSchema),
  })
  .strict();

/** The session shape exposed to server code — mirrors SessionUser in src/server/authz.ts. */
export const sessionUserSchema = z
  .object({ id: idSchema, email: z.email(), role: roleSchema })
  .strict();

/** Login outcome: either a one-time ticket for Auth.js, or a required 2FA enrolment step. */
export const loginTicketSchema = z
  .object({ ticketId: z.string().min(1) })
  .strict();

export type RegisterViaInviteInput = z.infer<typeof registerViaInviteInputSchema>;
export type LoginInput = z.infer<typeof loginInputSchema>;
export type CreateInviteInput = z.infer<typeof createInviteInputSchema>;
export type Invite = z.infer<typeof inviteSchema>;
export type SessionInfo = z.infer<typeof sessionInfoSchema>;
export type TotpSetup = z.infer<typeof totpSetupSchema>;
export type CsvImportResult = z.infer<typeof csvImportResultSchema>;
export type SessionUserDto = z.infer<typeof sessionUserSchema>;
