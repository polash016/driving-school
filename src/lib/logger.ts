import pino from "pino";

/**
 * Structured server logger. Full error detail (stack, meta) goes here ONLY —
 * clients receive typed, bilingual, user-safe messages (src/lib/errors.ts).
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: ["*.password", "*.passwordHash", "*.totpSecret", "*.token"],
    censor: "[redacted]",
  },
});
