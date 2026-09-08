import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderTruncatedError } from "./types";
import { googleAdapter } from "./google";

/**
 * A MAX_TOKENS finish can arrive with a candidate that has no `content` at all (the model
 * produced nothing before the cap) or with `content.parts` holding a partial fragment. Both must
 * surface as a typed, non-retryable ProviderTruncatedError — never as a ZodError from a schema
 * that assumed `content.parts` always exists.
 */

const CREDENTIALS = { apiKey: "AIza-test-12345678", baseUrl: null };

afterEach(() => vi.unstubAllGlobals());

describe("google adapter", () => {
  it("a MAX_TOKENS candidate with no content.parts throws ProviderTruncatedError, not a ZodError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              candidates: [{ finishReason: "MAX_TOKENS" }],
              usageMetadata: {
                promptTokenCount: 10,
                candidatesTokenCount: 8192,
              },
            }),
            { status: 200 },
          ),
      ),
    );

    await expect(
      googleAdapter.chat(CREDENTIALS, {
        model: "gemini-test",
        messages: [{ role: "user", content: "x" }],
        maxTokens: 8192,
      }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ProviderTruncatedError &&
        e.completionTokens === 8192 &&
        !e.retryable,
    );
  });

  it("a MAX_TOKENS candidate with partial parts throws ProviderTruncatedError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              candidates: [
                {
                  finishReason: "MAX_TOKENS",
                  content: { parts: [{ text: '{"units":[' }] },
                },
              ],
              usageMetadata: {
                promptTokenCount: 10,
                candidatesTokenCount: 8192,
              },
            }),
            { status: 200 },
          ),
      ),
    );

    await expect(
      googleAdapter.chat(CREDENTIALS, {
        model: "gemini-test",
        messages: [{ role: "user", content: "x" }],
        maxTokens: 8192,
      }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ProviderTruncatedError &&
        e.completionTokens === 8192 &&
        !e.retryable,
    );
  });

  it("passes maxTokens through as generationConfig.maxOutputTokens", async () => {
    let sentBody: { generationConfig?: { maxOutputTokens?: number } } = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sentBody = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({
            candidates: [
              { content: { parts: [{ text: "hello" }] }, finishReason: "STOP" },
            ],
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 },
          }),
          { status: 200 },
        );
      }),
    );

    await googleAdapter.chat(CREDENTIALS, {
      model: "gemini-test",
      messages: [{ role: "user", content: "x" }],
      maxTokens: 8192,
    });

    expect(sentBody.generationConfig?.maxOutputTokens).toBe(8192);
  });

  it("a STOP candidate parses as before", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              candidates: [
                {
                  finishReason: "STOP",
                  content: { parts: [{ text: "hello " }, { text: "world" }] },
                },
              ],
              usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
            }),
            { status: 200 },
          ),
      ),
    );

    const result = await googleAdapter.chat(CREDENTIALS, {
      model: "gemini-test",
      messages: [{ role: "user", content: "x" }],
    });

    expect(result.text).toBe("hello world");
    expect(result.promptTokens).toBe(10);
    expect(result.completionTokens).toBe(2);
  });
});
