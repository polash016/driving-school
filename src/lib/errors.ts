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
  constructor(meta?: Record<string, unknown>) {
    super("errors.validation", meta);
  }
}

export class AuthError extends AppError {
  readonly code = "UNAUTHENTICATED";
  readonly httpStatus = 401;
  constructor(meta?: Record<string, unknown>) {
    super("errors.unauthenticated", meta);
  }
}

export class ForbiddenError extends AppError {
  readonly code = "FORBIDDEN";
  readonly httpStatus = 403;
  constructor(meta?: Record<string, unknown>) {
    super("errors.forbidden", meta);
  }
}

export class NotFoundError extends AppError {
  readonly code = "NOT_FOUND";
  readonly httpStatus = 404;
  constructor(meta?: Record<string, unknown>) {
    super("errors.notFound", meta);
  }
}

export class ConflictError extends AppError {
  readonly code = "CONFLICT";
  readonly httpStatus = 409;
  constructor(meta?: Record<string, unknown>) {
    super("errors.conflict", meta);
  }
}

export class RateLimitError extends AppError {
  readonly code = "RATE_LIMITED";
  readonly httpStatus = 429;
  constructor(meta?: Record<string, unknown>) {
    super("errors.rateLimited", meta);
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
