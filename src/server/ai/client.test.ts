import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ProviderError, ProviderTruncatedError } from "@/server/ai/providers";

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

const { aiJson } = await import("./client");

const prompt = {
  id: "t",
  version: "1",
  render: () => "x",
};

describe("withFallback", () => {
  it("rethrows ProviderTruncatedError unwrapped and never tries route 2", async () => {
    const truncated = new ProviderTruncatedError(8192, 8192);
    chat1.mockReset().mockRejectedValueOnce(truncated);
    chat2.mockReset();

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
    chat1
      .mockReset()
      .mockRejectedValueOnce(new ProviderError("down", 503, true));
    chat2.mockReset().mockResolvedValueOnce({
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
