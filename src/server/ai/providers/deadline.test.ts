import { afterEach, describe, expect, it, vi } from "vitest";
import {
  asProviderError,
  fetchWithDeadline,
  ProviderError,
  readJson,
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
});
