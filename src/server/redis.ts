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
  /** Embedded search query, keyed by query hash. Invalidated by: expiry only. */
  kbQueryEmbedding: (hash: string) => `tp:kb:qemb:${hash}`,
  /** Facts snapshot. Invalidated by: fact edit. */
  kbFacts: () => `tp:kb:facts`,
  /** Runtime security policy (admin 2FA requirement). Invalidated by: policy save. */
  securityPolicy: () => `tp:cfg:security`,
  /** DB Setting rows. Invalidated by: settings save. */
  settings: () => `tp:cfg:settings`,
  /**
   * Question-bank accuracy aggregate, one entry per (grouping, window). Invalidated by bumping
   * `qbStatsVersion` — the key space is too large to enumerate for a DEL, so writes move the
   * version and stale entries fall out on their own TTL.
   */
  qbStats: (version: number, groupBy: string, sinceDays: number) =>
    `tp:qb:stats:v${version}:${groupBy}:${sinceDays}`,
  /** Monotonic version for the accuracy aggregate. Bumped by: transition, upsert, import. */
  qbStatsVersion: () => `tp:qb:stats:version`,
  /** Resolved AI routes per task (encrypted keys). Invalidated by: any provider/route change. */
  aiRoutes: (task: string) => `tp:ai:routes:${task}`,
  /** The language registry (spec-15). Invalidated by: any Language mutation. */
  i18nRegistry: () => `tp:i18n:registry`,
  /** Assembled UI message catalogue per locale. Invalidated by: a UI_MESSAGE translation write. */
  i18nMessages: (locale: string) => `tp:i18n:msg:${locale}`,
  /** Topic/class/sign names resolved for one locale. Invalidated by: taxonomy or translation edit. */
  i18nTaxonomy: (locale: string) => `tp:i18n:taxonomy:${locale}`,
  /** Rate-limit counter (window-expiring). */
  rateLimit: (route: string, key: string) => `tp:rl:${route}:${key}`,
  /** AI spend counter per day (cost guard). */
  aiSpend: (isoDate: string) => `tp:ai:spend:${isoDate}`,
  /** Session-valid flag for a UserSession id. Invalidated by: revoke, logout, password change. */
  authSession: (sessionId: string) => `tp:auth:sess:${sessionId}`,
  /** One-time login ticket consumed by the Auth.js credentials provider (GETDEL). */
  authTicket: (ticketId: string) => `tp:auth:ticket:${ticketId}`,
  /** lastSeenAt write throttle per session (SET NX). Invalidated by: expiry only. */
  authSeen: (sessionId: string) => `tp:auth:seen:${sessionId}`,
  /** Pending (unconfirmed) TOTP secret during 2FA setup. Invalidated by: confirm, expiry. */
  totpSetup: (userId: string) => `tp:auth:totp:${userId}`,
  /** Already-used TOTP code (replay guard, one validation window). Invalidated by: expiry. */
  totpUsed: (userId: string, code: string) => `tp:auth:totpused:${userId}:${code}`,
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
