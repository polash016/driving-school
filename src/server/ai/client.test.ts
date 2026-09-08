import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ProviderError, ProviderTruncatedError } from "@/server/ai/providers";
import { schoolConfig } from "../../../config/school.config";
import { logger } from "@/lib/logger";

/**
 * Truncation is a REQUEST fault (the prompt is too large for the cap), not a provider fault: every
 * other configured route would truncate at the same cap or reject the request outright. So
 * `withFallback` must let a ProviderTruncatedError through unwrapped and untried on route 2 — the
 * runner (spec-19a Task 8) catches it by class and halves the batch instead.
 *
 * A genuinely retryable ProviderError (quota, 5xx) must still walk the fallback chain as before.
 */

const chat1 = vi.fn();
const chat2 = vi.fn();

vi.mock("@/server/services/ai/providers", () => ({
  resolveRoutes: async () => [
    {
      routeId: "r1",
      providerId: "p1",
      providerLabel: "one",
      kind: "OPENAI_COMPATIBLE",
      model: "m1",
      apiKey: "k",
      baseUrl: "https://one.test/v1",
    },
    {
      routeId: "r2",
      providerId: "p2",
      providerLabel: "two",
      kind: "OPENAI_COMPATIBLE",
      model: "m2",
      apiKey: "k",
      baseUrl: "https://two.test/v1",
    },
  ],
}));

vi.mock("@/server/ai/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/ai/providers")>();
  return {
    ...actual,
    adapterFor: () => ({
      kind: "OPENAI_COMPATIBLE",
      chat: (credentials: { baseUrl: string }, request: unknown) =>
        (credentials.baseUrl.includes("one") ? chat1 : chat2)(
          credentials,
          request,
        ),
      ping: async () => undefined,
    }),
  };
});

const { aiJson, retryDelayMs } = await import("./client");

const prompt = {
  id: "t",
  version: "1",
  render: () => "x",
};

describe("withFallback", () => {
  beforeEach(() => {
    chat1.mockReset();
    chat2.mockReset();
  });

  it("rethrows ProviderTruncatedError unwrapped and never tries route 2", async () => {
    const truncated = new ProviderTruncatedError(8192, 8192);
    chat1.mockRejectedValueOnce(truncated);

    await expect(
      aiJson({
        task: "translation",
        prompt,
        vars: {},
        schema: z.object({ ok: z.boolean() }),
      }),
    ).rejects.toBe(truncated);

    expect(chat2).not.toHaveBeenCalled();
  });

  it("a retryable ProviderError still moves to route 2", async () => {
    chat1.mockRejectedValueOnce(new ProviderError("down", 503, true));
    chat2.mockResolvedValueOnce({
      text: '{"ok":true}',
      model: "m2",
      promptTokens: 1,
      completionTokens: 1,
    });

    const result = await aiJson({
      task: "translation",
      prompt,
      vars: {},
      schema: z.object({ ok: z.boolean() }),
    });

    expect(result.data.ok).toBe(true);
    expect(result.providerLabel).toBe("two");
  });
});

describe("retryDelayMs", () => {
  it("follows the base × 2^attempt ladder and caps at 60s", () => {
    expect(retryDelayMs(0, 0.5)).toBe(schoolConfig.ai.rateLimitBaseDelayMs);
    expect(retryDelayMs(7, 0.5)).toBe(60_000);
  });
});

/**
 * A 429 is a per-minute quota, not a dead route: yesterday's incident (spec-19a) showed that
 * falling straight through to the next route on a 429 just spends that route's quota too, and the
 * runner's immediate retry sweep burns all three attempts inside the same minute. The fix waits on
 * the SAME route — base × 2^attempt with jitter, capped at 60s — before the chain moves on.
 */
describe("rate limits", () => {
  const { rateLimitRetries, rateLimitBaseDelayMs } = schoolConfig.ai;
  // The ladder this run's config actually produces at jitter pinned to the midpoint (1.0x) —
  // derived, not hardcoded, so a future change to rateLimitRetries/rateLimitBaseDelayMs doesn't
  // silently desync the test from the config it is meant to exercise.
  const delayLadder = Array.from({ length: rateLimitRetries }, (_, attempt) =>
    Math.min(rateLimitBaseDelayMs * 2 ** attempt, 60_000),
  );

  beforeEach(() => {
    chat1.mockReset();
    chat2.mockReset();
    vi.useFakeTimers();
    // Jitter is 0.8–1.2x the base delay; stubbing Math.random at the midpoint makes every wait
    // land exactly on the ladder above instead of a range, so timer advances can be deterministic.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Walks the microtask queue until a timer has actually been scheduled (or resolved past). */
  async function settle() {
    for (let i = 0; i < 50 && vi.getTimerCount() === 0; i++)
      await Promise.resolve();
  }

  it("a 429 is retried on the same route and succeeds without touching route 2", async () => {
    chat1.mockRejectedValueOnce(new ProviderError("quota exceeded", 429, true));
    chat1.mockRejectedValueOnce(new ProviderError("quota exceeded", 429, true));
    chat1.mockResolvedValueOnce({
      text: '{"ok":true}',
      model: "m1",
      promptTokens: 1,
      completionTokens: 1,
    });
    const warnSpy = vi.spyOn(logger, "warn");

    const promise = aiJson({
      task: "translation",
      prompt,
      vars: {},
      schema: z.object({ ok: z.boolean() }),
    });

    await settle();
    await vi.advanceTimersByTimeAsync(delayLadder[0]);
    await settle();
    await vi.advanceTimersByTimeAsync(delayLadder[1]);

    const result = await promise;

    expect(chat1).toHaveBeenCalledTimes(3);
    expect(chat2).not.toHaveBeenCalled();
    expect(result.data.ok).toBe(true);
    // The classify() widening (300 -> 600) is only worth anything if the body actually reaches a
    // log — assert the rate-limit warn carries the 429's message, not just that it was called.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining("quota exceeded"),
      }),
      "rate limited — waiting on the same route",
    );
  });

  it("after rateLimitRetries 429s the chain moves to the next route", async () => {
    for (let i = 0; i < rateLimitRetries + 1; i++) {
      chat1.mockRejectedValueOnce(new ProviderError("quota", 429, true));
    }
    chat2.mockResolvedValueOnce({
      text: '{"ok":true}',
      model: "m2",
      promptTokens: 1,
      completionTokens: 1,
    });

    const promise = aiJson({
      task: "translation",
      prompt,
      vars: {},
      schema: z.object({ ok: z.boolean() }),
    });

    await settle();
    for (const delay of delayLadder) {
      await vi.advanceTimersByTimeAsync(delay);
      await settle();
    }

    const result = await promise;

    expect(chat1).toHaveBeenCalledTimes(rateLimitRetries + 1);
    expect(chat2).toHaveBeenCalledTimes(1);
    expect(result.providerLabel).toBe("two");
  });

  it("a 5xx still moves to the next route immediately", async () => {
    chat1.mockRejectedValueOnce(new ProviderError("down", 503, true));
    chat2.mockResolvedValueOnce({
      text: '{"ok":true}',
      model: "m2",
      promptTokens: 1,
      completionTokens: 1,
    });

    const promise = aiJson({
      task: "translation",
      prompt,
      vars: {},
      schema: z.object({ ok: z.boolean() }),
    });

    await settle();
    const result = await promise;

    expect(vi.getTimerCount()).toBe(0);
    expect(chat2).toHaveBeenCalledTimes(1);
    expect(result.providerLabel).toBe("two");
  });

  it("an aborted signal during the wait rejects at once", async () => {
    chat1.mockRejectedValueOnce(new ProviderError("quota", 429, true));
    const controller = new AbortController();

    const pending = aiJson({
      task: "translation",
      prompt,
      vars: {},
      schema: z.object({ ok: z.boolean() }),
      signal: controller.signal,
    });

    // aiJson -> withFallback -> candidatesFor is a dynamic import plus an awaited resolveRoutes(),
    // and only after the rejected chat1 call does sleepOrAbort() register its setTimeout.
    await settle();
    expect(vi.getTimerCount()).toBe(1);

    controller.abort();

    await expect(pending).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ProviderError && e.retryable && /aborted/.test(e.message),
    );
    expect(vi.getTimerCount()).toBe(0); // onAbort cleared the timer — nothing dangling
    expect(chat2).not.toHaveBeenCalled();
  });

  it("an already-aborted signal rejects before any wait", async () => {
    chat1.mockRejectedValueOnce(new ProviderError("quota", 429, true));
    const controller = new AbortController();
    controller.abort();

    const pending = aiJson({
      task: "translation",
      prompt,
      vars: {},
      schema: z.object({ ok: z.boolean() }),
      signal: controller.signal,
    });

    await expect(pending).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ProviderError && e.retryable && /aborted/.test(e.message),
    );
    expect(vi.getTimerCount()).toBe(0);
    expect(chat2).not.toHaveBeenCalled();
  });
});
