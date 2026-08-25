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
  ping(credentials: ProviderCredentials, model: string): Promise<void>;
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

export function classify(status: number, body: string): ProviderError {
  // 429 = quota/rate limit, 5xx = provider trouble: both are worth trying the next route for.
  const retryable = status === 429 || status >= 500;
  return new ProviderError(body.slice(0, 300), status, retryable);
}
