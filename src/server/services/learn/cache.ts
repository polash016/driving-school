import { cacheGet, cacheSet, keys, redis } from "@/server/redis";
import { logger } from "@/lib/logger";

/**
 * Read caches for the Learn section (spec-23): one monotonic version, bumped on every write, so
 * the key space never has to be enumerated for a DEL — stale entries simply fall out on TTL.
 */
export const LEARN_CACHE_TTL_SECONDS = 60 * 60;

export async function learnVersion(): Promise<number> {
  try {
    const raw = await redis.get(keys.learnVersion());
    return raw ? Number(raw) || 0 : 0;
  } catch (error) {
    logger.warn({ error }, "learnVersion read failed — serving uncached");
    return -1;
  }
}

/** Every book/document write, transition or reorder ends here. Fails open. */
export async function invalidateLearn(): Promise<void> {
  try {
    await redis.incr(keys.learnVersion());
  } catch (error) {
    logger.warn({ error }, "learnVersion bump failed");
  }
}

/** Read-through cache; a negative version (Redis down) means "do not cache at all". */
export async function cachedLearn<T>(
  build: (version: number) => string,
  load: () => Promise<T>,
): Promise<T> {
  const version = await learnVersion();
  if (version < 0) return load();
  const key = build(version);
  const hit = await cacheGet<T>(key);
  if (hit !== null) return hit;
  const value = await load();
  await cacheSet(key, value, LEARN_CACHE_TTL_SECONDS);
  return value;
}
