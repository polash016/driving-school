import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { RateLimitError } from "@/lib/errors";
import { keys, redis } from "@/server/redis";
import { RATE_LIMITS, rateLimit, resetRateLimit } from "./rate-limit";

/**
 * Spec-03 acceptance: "Rate limiting on auth endpoints (Redis, 5/min/IP)".
 * Runs against the real Redis from docker-compose.dev.yml — a fake would prove nothing about
 * the INCR/EXPIRE pipeline that actually enforces the window.
 */
const available = await redis
  .connect()
  .then(() => true)
  .catch(() => redis.status === "ready" || redis.status === "connecting");

const d = describe.skipIf(!available);

afterAll(async () => {
  await redis.quit().catch(() => undefined);
});

d("rateLimit", () => {
  it("allows exactly the configured budget, then throws", async () => {
    const key = randomUUID();
    expect(RATE_LIMITS.loginIp).toEqual({ limit: 5, windowSec: 60 });

    for (let attempt = 1; attempt <= 5; attempt++) {
      const result = await rateLimit("loginIp", key);
      expect(result.count).toBe(attempt);
      expect(result.remaining).toBe(5 - attempt);
    }
    await expect(rateLimit("loginIp", key)).rejects.toBeInstanceOf(RateLimitError);
    await redis.del(keys.rateLimit("loginIp", key));
  });

  it("sets the window on the first hit and does not extend it on later hits", async () => {
    const key = randomUUID();
    await rateLimit("loginIp", key, { limit: 3, windowSec: 60 });
    const firstTtl = await redis.ttl(keys.rateLimit("loginIp", key));

    await rateLimit("loginIp", key, { limit: 3, windowSec: 600 });
    const secondTtl = await redis.ttl(keys.rateLimit("loginIp", key));

    expect(firstTtl).toBeGreaterThan(0);
    expect(secondTtl).toBeLessThanOrEqual(firstTtl);
    await redis.del(keys.rateLimit("loginIp", key));
  });

  it("counts each route independently", async () => {
    const key = randomUUID();
    await rateLimit("loginIp", key);
    const other = await rateLimit("registerIp", key);
    expect(other.count).toBe(1);
    await redis.del(keys.rateLimit("loginIp", key), keys.rateLimit("registerIp", key));
  });

  it("resets a counter after a successful login", async () => {
    const key = randomUUID();
    await rateLimit("loginIp", key);
    await rateLimit("loginIp", key);
    await resetRateLimit("loginIp", key);
    expect((await rateLimit("loginIp", key)).count).toBe(1);
    await redis.del(keys.rateLimit("loginIp", key));
  });

  it("fails open when Redis is unreachable — a cache outage must not lock users out", async () => {
    const spy = vi.spyOn(redis, "multi").mockImplementation(() => {
      throw new Error("connection refused");
    });
    await expect(rateLimit("loginIp", randomUUID())).resolves.toEqual({
      count: 0,
      remaining: 5,
    });
    spy.mockRestore();
  });
});
