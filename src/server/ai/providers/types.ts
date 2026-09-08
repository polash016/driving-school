import type { AiProviderKind } from "@prisma/client";

/**
 * One shape every provider adapter implements (spec-05). The gateway resolves a route, decrypts
 * that provider's key and calls through this interface — so adding a provider never touches a
 * call site, and no call site ever sees a key.
 */

export interface ProviderMessage {
  role: "system" | "user";
  content:
    | string
    | Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string } }
      >;
}

export interface ChatRequest {
  model: string;
  messages: ProviderMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Ask the provider for strict JSON where it supports it. */
  json?: boolean;
  /** Per-request deadline; adapters default to schoolConfig.ai.requestTimeoutMs. */
  timeoutMs?: number;
  /** Caller cancellation (worker shutdown). Combined with the deadline via AbortSignal.any. */
  signal?: AbortSignal;
}

export interface ChatResponse {
  text: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

export interface EmbedRequest {
  model: string;
  input: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ProviderCredentials {
  apiKey: string;
  baseUrl?: string | null;
}

export interface ProviderAdapter {
  kind: AiProviderKind;
  chat(
    credentials: ProviderCredentials,
    request: ChatRequest,
  ): Promise<ChatResponse>;
  embed?(
    credentials: ProviderCredentials,
    request: EmbedRequest,
  ): Promise<number[][]>;
  /** Cheapest possible call that proves the key works — used by "Test connection". */
  ping(
    credentials: ProviderCredentials,
    model: string,
    options?: { timeoutMs?: number },
  ): Promise<void>;
}

/** Non-retryable vs retryable: a quota or 5xx moves to the next route, a bad key does not. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/**
 * The model hit `maxTokens` before it finished. Not retryable on purpose: fallback routes around a
 * PROVIDER fault (429/5xx); a truncation is a REQUEST fault — the prompt is too large for the cap —
 * and every other route would truncate at the same cap or 400. The runner halves the batch instead.
 * status 200: the HTTP exchange succeeded; the class is the discriminator.
 */
export class ProviderTruncatedError extends ProviderError {
  constructor(
    readonly maxTokens: number | undefined,
    readonly completionTokens: number,
  ) {
    super(
      `output truncated at ${completionTokens} tokens (cap ${maxTokens ?? "default"})`,
      200,
      false,
    );
    this.name = "ProviderTruncatedError";
  }
}

export function classify(status: number, body: string): ProviderError {
  // 429 = quota/rate limit, 5xx = provider trouble: both are worth trying the next route for.
  const retryable = status === 429 || status >= 500;
  // 600, not 300: Gemini's 429 body names the exhausted quota metric after ~350 chars.
  return new ProviderError(body.slice(0, 600), status, retryable);
}

/**
 * Layer 0 (spec-19): every provider request carries a deadline, and every way a request can die
 * — timeout, caller abort, DNS/TLS/connection failure — surfaces as a RETRYABLE ProviderError so
 * `withFallback` moves to the next route instead of stopping the chain on a bare TypeError.
 */
export function asProviderError(error: unknown, timeoutMs: number): unknown {
  if (error instanceof ProviderError) return error;
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "TimeoutError")
    return new ProviderError(`no response within ${timeoutMs}ms`, 504, true);
  if (name === "AbortError")
    return new ProviderError("request aborted", 499, true);
  if (error instanceof TypeError) {
    // undici wraps ECONNREFUSED / ENOTFOUND / TLS errors as TypeError("fetch failed") with a cause.
    const code = (error as { cause?: { code?: unknown } }).cause?.code;
    return new ProviderError(
      `network failure${typeof code === "string" ? ` (${code})` : ""}`,
      503,
      true,
    );
  }
  return error;
}

export async function fetchWithDeadline(
  url: string,
  init: RequestInit,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<Response> {
  const deadline = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([deadline, options.signal])
    : deadline;
  try {
    return await fetch(url, { ...init, signal });
  } catch (error) {
    throw asProviderError(error, options.timeoutMs);
  }
}

/**
 * Read a body under the same guarantee the request itself has.
 *
 * The body is streamed under the request's own abort signal, so a provider that answers 502 with
 * a chunked body and then stalls makes `response.text()` reject with a bare `AbortError` — which
 * `withFallback` cannot classify, so it stops the fallback chain instead of trying the next route.
 * Every read of a body, error bodies included, goes through here so that every one of them lands
 * as a retryable ProviderError.
 */
export async function readText(
  response: Response,
  timeoutMs = 0,
): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    throw asProviderError(error, timeoutMs);
  }
}

/**
 * Read a JSON body without ever surfacing a bare SyntaxError. A gateway streaming by default, a
 * proxy sign-in page, an HTML error page: all answer 200 with something JSON.parse rejects, and
 * that parser message is what the admin screen would otherwise show. The body read is under the
 * same signal as the request, so a server that sends headers and then stalls is caught here too.
 */
export async function readJson(
  response: Response,
  timeoutMs = 0,
): Promise<unknown> {
  const body = await readText(response, timeoutMs);
  try {
    return JSON.parse(body);
  } catch {
    const contentType =
      response.headers.get("content-type") ?? "no content-type";
    throw new ProviderError(
      `expected a JSON completion but the endpoint returned ${contentType}: ${body.slice(0, 160)}`,
      response.status,
      false,
    );
  }
}
