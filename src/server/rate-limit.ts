import { RateLimitError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { keys, redis } from "@/server/redis";

/**
 * Fixed-window rate limiting on Redis (spec-03; spec-12 reuses it for the route manifest).
 * Counter key comes from `keys.rateLimit` — never hand-written at call sites.
 *
 * Fails OPEN: if Redis is unreachable the request proceeds with a warn log. A cache outage
 * must not lock a school out of its own app; abuse protection degrades, availability does not.
 */

export interface RateLimitRule {
  readonly limit: number;
  readonly windowSec: number;
}

/** Every auth route's budget in one place (spec-03 acceptance: 5/min/IP on auth endpoints). */
export const RATE_LIMITS = {
  loginIp: { limit: 5, windowSec: 60 },
  loginEmail: { limit: 10, windowSec: 900 },
  registerIp: { limit: 5, windowSec: 60 },
  passwordResetIp: { limit: 5, windowSec: 60 },
  passwordResetEmail: { limit: 3, windowSec: 3600 },
  tokenConsumeIp: { limit: 10, windowSec: 60 },
  totpUser: { limit: 5, windowSec: 60 },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitRoute = keyof typeof RATE_LIMITS;

export interface RateLimitResult {
  count: number;
  remaining: number;
}

/**
 * Counts one hit against `route:key` and throws `RateLimitError` once the window budget is
 * exhausted. INCR + EXPIRE run in one pipeline, so the window starts with the first hit.
 */
export async function rateLimit(
  route: RateLimitRoute,
  key: string,
  rule: RateLimitRule = RATE_LIMITS[route],
): Promise<RateLimitResult> {
  const cacheKey = keys.rateLimit(route, key);
  try {
    const [[, count]] = (await redis
      .multi()
      .incr(cacheKey)
      .expire(cacheKey, rule.windowSec, "NX")
      .exec()) as [[Error | null, number], [Error | null, number]];

    if (count > rule.limit) {
      throw new RateLimitError({ route, limit: rule.limit, count });
    }
    return { count, remaining: rule.limit - count };
  } catch (error) {
    if (error instanceof RateLimitError) throw error;
    logger.warn({ route, error }, "rate limit unavailable — failing open");
    return { count: 0, remaining: rule.limit };
  }
}

/** Clears a counter early (e.g. after a successful login, so one typo does not cost the window). */
export async function resetRateLimit(
  route: RateLimitRoute,
  key: string,
): Promise<void> {
  try {
    await redis.del(keys.rateLimit(route, key));
  } catch (error) {
    logger.warn({ route, error }, "rate limit reset failed");
  }
}
