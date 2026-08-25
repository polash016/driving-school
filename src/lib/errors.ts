/**
 * Typed error taxonomy (architecture blueprint §8).
 * `messageKey` points into the i18n "errors" namespace → user-safe bilingual text.
 * `meta` is for structured logs only and must never be serialized to clients.
 */
export abstract class AppError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;
  readonly messageKey: string;
  readonly meta?: Record<string, unknown>;

  constructor(messageKey: string, meta?: Record<string, unknown>) {
    super(messageKey);
    this.name = new.target.name;
    this.messageKey = messageKey;
    this.meta = meta;
  }
}

export class ValidationError extends AppError {
  readonly code = "VALIDATION";
  readonly httpStatus = 400;
  /** `messageKey` overrides the default user-facing message with a more specific one. */
  constructor(meta?: Record<string, unknown>, messageKey = "errors.validation") {
    super(messageKey, meta);
  }
}

export class AuthError extends AppError {
  readonly code = "UNAUTHENTICATED";
  readonly httpStatus = 401;
  /** `messageKey` overrides the default user-facing message with a more specific one. */
  constructor(meta?: Record<string, unknown>, messageKey = "errors.unauthenticated") {
    super(messageKey, meta);
  }
}

export class ForbiddenError extends AppError {
  readonly code = "FORBIDDEN";
  readonly httpStatus = 403;
  /** `messageKey` overrides the default user-facing message with a more specific one. */
  constructor(meta?: Record<string, unknown>, messageKey = "errors.forbidden") {
    super(messageKey, meta);
  }
}

export class NotFoundError extends AppError {
  readonly code = "NOT_FOUND";
  readonly httpStatus = 404;
  /** `messageKey` overrides the default user-facing message with a more specific one. */
  constructor(meta?: Record<string, unknown>, messageKey = "errors.notFound") {
    super(messageKey, meta);
  }
}

export class ConflictError extends AppError {
  readonly code = "CONFLICT";
  readonly httpStatus = 409;
  /** `messageKey` overrides the default user-facing message with a more specific one. */
  constructor(meta?: Record<string, unknown>, messageKey = "errors.conflict") {
    super(messageKey, meta);
  }
}

export class RateLimitError extends AppError {
  readonly code = "RATE_LIMITED";
  readonly httpStatus = 429;
  /** `messageKey` overrides the default user-facing message with a more specific one. */
  constructor(meta?: Record<string, unknown>, messageKey = "errors.rateLimited") {
    super(messageKey, meta);
  }
}

/**
 * Credentials were correct but the account has 2FA enabled and no valid code was supplied —
 * the login UI shows the code step (spec-03).
 */
export class TotpRequiredError extends AppError {
  readonly code = "TOTP_REQUIRED";
  readonly httpStatus = 401;
  constructor(meta?: Record<string, unknown>) {
    super("auth.errors.totpRequired", meta);
  }
}

/**
 * An ADMIN whose 2FA is not provisioned yet: enrolment must finish before any session is
 * issued. Carries the one-time setup ticket the enrolment step consumes.
 */
export class TotpSetupRequiredError extends AppError {
  readonly code = "TOTP_SETUP_REQUIRED";
  readonly httpStatus = 401;
  readonly ticketId: string;
  constructor(ticketId: string, meta?: Record<string, unknown>) {
    super("auth.errors.totpSetupRequired", meta);
    this.ticketId = ticketId;
  }
}

/** Invalid exam-state transition (answer after submit, resume an expired attempt, …). */
export class ExamStateError extends AppError {
  readonly code = "EXAM_STATE";
  readonly httpStatus = 409;
  constructor(meta?: Record<string, unknown>) {
    super("errors.examState", meta);
  }
}

export class AiPipelineError extends AppError {
  readonly code = "AI_PIPELINE";
  readonly httpStatus = 502;
  constructor(meta?: Record<string, unknown>) {
    super("errors.internal", meta); // users never see pipeline detail
  }
}

export class InternalError extends AppError {
  readonly code = "INTERNAL";
  readonly httpStatus = 500;
  constructor(meta?: Record<string, unknown>) {
    super("errors.internal", meta);
  }
}
