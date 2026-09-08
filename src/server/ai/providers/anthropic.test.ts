import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderTruncatedError } from "./types";
import { anthropicAdapter } from "./anthropic";

/**
 * A `stop_reason: "max_tokens"` finish can arrive with a normal text block (truncated mid-way)
 * or with an empty `content` array (nothing produced before the cap) — both must surface as a
 * typed, non-retryable ProviderTruncatedError, never as a ZodError from a schema that required
 * at least one content block.
 */

const CREDENTIALS = { apiKey: "sk-ant-test-12345678", baseUrl: null };

/** A fetch stub that always answers 200 with the given JSON body. */
function respondWith(body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
}

afterEach(() => vi.unstubAllGlobals());

describe("anthropic adapter", () => {
  it("stop_reason=max_tokens with a text block throws ProviderTruncatedError", async () => {
    vi.stubGlobal(
      "fetch",
      respondWith({
        model: "claude-test",
        content: [{ type: "text", text: '{"units":[' }],
        stop_reason: "max_tokens",
        usage: { input_tokens: 10, output_tokens: 4096 },
      }),
    );

    await expect(
      anthropicAdapter.chat(CREDENTIALS, {
        model: "claude-test",
        messages: [{ role: "user", content: "x" }],
        maxTokens: 4096,
      }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ProviderTruncatedError &&
        e.completionTokens === 4096 &&
        e.maxTokens === 4096 &&
        !e.retryable,
    );
  });

  it("stop_reason=max_tokens with empty content is a ProviderTruncatedError", async () => {
    vi.stubGlobal(
      "fetch",
      respondWith({
        model: "claude-test",
        content: [],
        stop_reason: "max_tokens",
        usage: { input_tokens: 10, output_tokens: 4096 },
      }),
    );

    await expect(
      anthropicAdapter.chat(CREDENTIALS, {
        model: "claude-test",
        messages: [{ role: "user", content: "x" }],
        maxTokens: 4096,
      }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ProviderTruncatedError &&
        e.completionTokens === 4096 &&
        !e.retryable,
    );
  });

  it("end_turn parses as before", async () => {
    vi.stubGlobal(
      "fetch",
      respondWith({
        model: "claude-test",
        content: [
          { type: "text", text: "hello " },
          { type: "text", text: "world" },
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
    );

    const result = await anthropicAdapter.chat(CREDENTIALS, {
      model: "claude-test",
      messages: [{ role: "user", content: "x" }],
    });

    expect(result.text).toBe("hello world");
    expect(result.promptTokens).toBe(10);
    expect(result.completionTokens).toBe(2);
  });

  it("ping resolves on an end_turn answer and does not send a 1-token cap", async () => {
    let sentBody: { max_tokens?: number } = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sentBody = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({
            model: "claude-test",
            content: [{ type: "text", text: "pong" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200 },
        );
      }),
    );

    await expect(
      anthropicAdapter.ping(CREDENTIALS, "claude-test"),
    ).resolves.toBeUndefined();
    expect(sentBody.max_tokens).not.toBe(1);
  });
});
