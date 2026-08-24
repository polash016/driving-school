import Redis from "ioredis";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

/**
 * Redis singleton + typed cache helpers (architecture blueprint §5).
 * ALL cache keys are built by the `keys` helpers below — never hand-written
 * strings at call sites, so the invalidation map stays auditable.
 */
const globalForRedis = globalThis as unknown as { redis?: Redis };

export const redis =
  globalForRedis.redis ??
  new Redis(env().REDIS_URL, {
    maxRetriesPerRequest: 2,
    lazyConnect: true,
  });

if (process.env.NODE_ENV !== "production") globalForRedis.redis = redis;

/** Central key registry — one line per cached domain, with its invalidation trigger. */
export const keys = {
  /** Ready variant ids per master item. Invalidated by: warmer add, assembly consume, item retire. */
  quizPool: (masterItemId: string) => `tp:quiz:pool:${masterItemId}`,
  /** Recently-served contentHashes per user (sorted set, trimmed on write). */
  quizSeen: (userId: string) => `tp:quiz:seen:${userId}`,
  /** Dashboard aggregate. Invalidated by: exam submit, homework change. */
  dashAgg: (userId: string) => `tp:dash:agg:${userId}`,
  /** Facts snapshot. Invalidated by: fact edit. */
  kbFacts: () => `tp:kb:facts`,
  /** DB Setting rows. Invalidated by: settings save. */
  settings: () => `tp:cfg:settings`,
  /** Rate-limit counter (window-expiring). */
  rateLimit: (route: string, key: string) => `tp:rl:${route}:${key}`,
  /** AI spend counter per day (cost guard). */
  aiSpend: (isoDate: string) => `tp:ai:spend:${isoDate}`,
} as const;

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const raw = await redis.get(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch (error) {
    // Cache must never take the request down — fall through to the source read.
    logger.warn({ key, error }, "cacheGet failed");
    return null;
  }
}

export async function cacheSet(
  key: string,
  value: unknown,
  ttlSeconds: number,
): Promise<void> {
  try {
    await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
  } catch (error) {
    logger.warn({ key, error }, "cacheSet failed");
  }
}

export async function cacheDel(...cacheKeys: string[]): Promise<void> {
  try {
    if (cacheKeys.length > 0) await redis.del(...cacheKeys);
  } catch (error) {
    logger.warn({ cacheKeys, error }, "cacheDel failed");
  }
}
