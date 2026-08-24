import { cacheDel, keys, redis } from "@/server/redis";
import type { GradedHook, SeenStore } from "./ports";

/** Seen-window length (spec-07): variants a user saw in this period are excluded. */
const SEEN_WINDOW_DAYS = 30;
const SEEN_WINDOW_MS = SEEN_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * Redis-backed seen store: sorted set per user, score = servedAt epoch-ms.
 * Trimmed on every write; key expires with the window (sliding).
 * Invalidation trigger: time-based only.
 */
export class RedisSeenStore implements SeenStore {
  async getSeenHashes(userId: string): Promise<Set<string>> {
    const cutoff = Date.now() - SEEN_WINDOW_MS;
    const hashes = await redis.zrangebyscore(
      keys.quizSeen(userId),
      cutoff,
      "+inf",
    );
    return new Set(hashes);
  }

  async recordServed(
    userId: string,
    hashes: string[],
    at: Date,
  ): Promise<void> {
    if (hashes.length === 0) return;
    const key = keys.quizSeen(userId);
    const args = hashes.flatMap((h) => [at.getTime(), h]);
    await redis
      .multi()
      .zadd(key, ...args)
      .zremrangebyscore(key, "-inf", at.getTime() - SEEN_WINDOW_MS)
      .expire(key, SEEN_WINDOW_DAYS * 24 * 60 * 60)
      .exec();
  }
}

/** After grading: drop the dashboard aggregate (architecture §5 invalidation map). */
export const invalidateDashboardOnGraded: GradedHook = async (userId) => {
  await cacheDel(keys.dashAgg(userId));
};
