import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "./types";
import { openAiCompatibleAdapter } from "./openai-compatible";

/**
 * Regression cover for the OmniRoute outage (2026-09-06): the gateway streams by default when
 * the request omits `stream`, so a plain `/chat/completions` call came back as `text/event-stream`
 * with HTTP 200 and `response.json()` blew up with `Unexpected token 'd'`. "Test connection" in
 * /admin/ai showed that raw parser error and no provider could be verified.
 */

const CREDENTIALS = {
  apiKey: "sk-test-12345678",
  baseUrl: "https://ai.dsit.app/v1",
};

const COMPLETION = {
  object: "chat.completion",
  model: "nemotron-3.5-lightning-free",
  choices: [
    {
      index: 0,
      finish_reason: "stop",
      message: { role: "assistant", content: "hello" },
    },
  ],
  usage: { prompt_tokens: 17, completion_tokens: 1 },
};

/** A gateway that behaves like OmniRoute: it streams unless the caller opts out explicitly. */
function streamsUnlessTold() {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (body.stream !== false) {
      return new Response(
        'data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }
    return new Response(JSON.stringify(COMPLETION), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("openai-compatible adapter", () => {
  it("asks for a non-streamed response so gateways that stream by default return JSON", async () => {
    const fetchMock = streamsUnlessTold();
    vi.stubGlobal("fetch", fetchMock);

    const result = await openAiCompatibleAdapter.chat(CREDENTIALS, {
      model: "oc/nemotron-3.5-lightning-free",
      messages: [{ role: "user", content: "ping" }],
    });

    const sent = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(sent.stream).toBe(false);
    expect(result.text).toBe("hello");
  });

  it("pings without streaming", async () => {
    const fetchMock = streamsUnlessTold();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      openAiCompatibleAdapter.ping(
        CREDENTIALS,
        "oc/nemotron-3.5-lightning-free",
      ),
    ).resolves.toBeUndefined();
  });

  it("reports a non-JSON body as a provider error, not a raw parser crash", async () => {
    // Defence in depth: a proxy or captive portal can still answer 200 with HTML.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>gateway</html>", { status: 200 })),
    );

    await expect(
      openAiCompatibleAdapter.chat(CREDENTIALS, {
        model: "m",
        messages: [{ role: "user", content: "ping" }],
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ProviderError &&
        error.message.includes("expected a JSON completion") &&
        error.message.includes("<html>gateway</html>"),
    );
  });

  it("gives up on a provider that never answers, within the request deadline", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_, reject) =>
            init.signal?.addEventListener("abort", () =>
              reject(init.signal!.reason),
            ),
          ),
      ),
    );
    await expect(
      openAiCompatibleAdapter.chat(CREDENTIALS, {
        model: "m",
        messages: [{ role: "user", content: "ping" }],
        timeoutMs: 100,
      }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ProviderError && e.status === 504 && e.retryable,
    );
  });

  // Phase 0's remaining hole: the error body was read outside every wrapper, so a gateway that
  // answers 502 and then stalls surfaced as a bare AbortError. `withFallback` reads `retryable`
  // off ProviderError and defaults to false for anything else — so the fallback chain stopped on
  // exactly the failure it exists to route around.
  it("classifies an error body that never arrives as retryable, not as a raw AbortError", async () => {
    const timedOut = Object.assign(new Error("aborted"), {
      name: "TimeoutError",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: false,
            status: 502,
            headers: new Headers(),
            text: () => Promise.reject(timedOut),
          }) as unknown as Response,
      ),
    );

    await expect(
      openAiCompatibleAdapter.chat(CREDENTIALS, {
        model: "m",
        messages: [{ role: "user", content: "ping" }],
        timeoutMs: 100,
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ProviderError && e.retryable,
    );
  });

  it("sends the configured default deadline when the request carries none", async () => {
    const fetchMock = vi.fn(async (_u: string, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify(COMPLETION), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await openAiCompatibleAdapter.chat(CREDENTIALS, {
      model: "m",
      messages: [{ role: "user", content: "x" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
