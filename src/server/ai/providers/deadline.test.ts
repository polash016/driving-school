import { afterEach, describe, expect, it, vi } from "vitest";
import {
  asProviderError,
  fetchWithDeadline,
  ProviderError,
  readJson,
  readText,
} from "./types";

afterEach(() => vi.unstubAllGlobals());

/** A fetch that accepts the connection and never answers — only the signal can end it. */
function hangingFetch() {
  return vi.fn(
    (_url: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(init.signal!.reason),
        );
      }),
  );
}

describe("fetchWithDeadline", () => {
  it("aborts a server that never responds and reports it as retryable", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const started = Date.now();
    await expect(
      fetchWithDeadline(
        "https://x.test/v1",
        { method: "POST" },
        { timeoutMs: 120 },
      ),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ProviderError && e.status === 504 && e.retryable,
    );
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("honours an outer signal (worker shutdown) as retryable too", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const outer = new AbortController();
    const pending = fetchWithDeadline(
      "https://x.test/v1",
      {},
      { timeoutMs: 60_000, signal: outer.signal },
    );
    outer.abort();
    await expect(pending).rejects.toSatisfy(
      (e: unknown) => e instanceof ProviderError && e.retryable,
    );
  });

  it("maps a network failure (undici TypeError) to a retryable 503", () => {
    const error = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNREFUSED" },
    });
    const mapped = asProviderError(error, 1000);
    expect(mapped).toBeInstanceOf(ProviderError);
    expect((mapped as ProviderError).status).toBe(503);
    expect((mapped as ProviderError).retryable).toBe(true);
    expect((mapped as ProviderError).message).toContain("ECONNREFUSED");
  });

  it("passes a ProviderError through untouched and leaves unknown errors alone", () => {
    const original = new ProviderError("bad key", 401, false);
    expect(asProviderError(original, 1)).toBe(original);
    const other = new RangeError("x");
    expect(asProviderError(other, 1)).toBe(other);
  });

  it("returns the response when the server answers in time", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );
    const response = await fetchWithDeadline(
      "https://x.test",
      {},
      { timeoutMs: 1000 },
    );
    expect(response.status).toBe(200);
  });
});

/** A response whose headers arrived and whose body never does — the 502-then-stall case. */
function stalledBody(status: number): Response {
  const timedOut = Object.assign(
    new Error("The operation was aborted due to timeout"),
    { name: "TimeoutError" },
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    text: () => Promise.reject(timedOut),
  } as unknown as Response;
}

describe("readText", () => {
  it("returns the body when the server sends one", async () => {
    await expect(readText(new Response("upstream is down"), 100)).resolves.toBe(
      "upstream is down",
    );
  });

  // The error path used to read the body outside every wrapper: `classify` never ran, and
  // `withFallback` saw a bare AbortError it could not call retryable, so the chain stopped on the
  // one failure it exists to route around.
  it("reports a body that never arrives as a retryable ProviderError, not a bare AbortError", async () => {
    await expect(readText(stalledBody(502), 100)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ProviderError && e.status === 504 && e.retryable,
    );
  });
});

describe("readJson", () => {
  it("names a non-JSON body instead of throwing a bare SyntaxError", async () => {
    const response = new Response("<html>gateway</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
    await expect(readJson(response)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ProviderError && e.message.includes("text/html"),
    );
  });

  it("carries a stalled body up as a retryable ProviderError too", async () => {
    await expect(readJson(stalledBody(200), 100)).rejects.toSatisfy(
      (e: unknown) => e instanceof ProviderError && e.retryable,
    );
  });
});
