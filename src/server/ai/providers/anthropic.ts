import { z } from "zod";
import { schoolConfig } from "../../../../config/school.config";
import {
  classify,
  fetchWithDeadline,
  ProviderTruncatedError,
  readJson,
  readText,
  type ChatRequest,
  type ChatResponse,
  type ProviderAdapter,
} from "./types";

/**
 * Anthropic Claude (spec-05). Native: the system prompt is a top-level field rather than a
 * message, authentication uses `x-api-key`, and the API version is a required header.
 */

const DEFAULT_BASE = "https://api.anthropic.com/v1";
const API_VERSION = "2023-06-01";

const responseSchema = z.object({
  model: z.string().optional(),
  // No `.min(1)`: a `max_tokens` finish can arrive with an empty `content` array (nothing
  // produced before the cap), and `.map().join("")` below already tolerates that.
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  stop_reason: z.string().optional(),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
    })
    .optional(),
});

export const anthropicAdapter: ProviderAdapter = {
  kind: "ANTHROPIC",

  async chat(credentials, request: ChatRequest): Promise<ChatResponse> {
    const base = (credentials.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
    const system = request.messages.find(
      (message) => message.role === "system",
    );
    const user = request.messages.filter(
      (message) => message.role !== "system",
    );
    const timeoutMs = request.timeoutMs ?? schoolConfig.ai.requestTimeoutMs;
    const maxTokens = request.maxTokens ?? 4096;

    const response = await fetchWithDeadline(
      `${base}/messages`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": credentials.apiKey,
          "anthropic-version": API_VERSION,
        },
        body: JSON.stringify({
          model: request.model,
          max_tokens: maxTokens,
          temperature: request.temperature ?? 0.4,
          ...(system && typeof system.content === "string"
            ? { system: system.content }
            : {}),
          messages: user.map((message) => ({
            role: "user",
            content:
              typeof message.content === "string"
                ? message.content
                : message.content.map((part) =>
                    part.type === "text"
                      ? { type: "text", text: part.text }
                      : {
                          type: "image",
                          source: {
                            type: "base64",
                            media_type: part.image_url.url.slice(
                              5,
                              part.image_url.url.indexOf(";"),
                            ),
                            data: part.image_url.url.slice(
                              part.image_url.url.indexOf(",") + 1,
                            ),
                          },
                        },
                  ),
          })),
        }),
      },
      { timeoutMs, ...(request.signal ? { signal: request.signal } : {}) },
    );

    if (!response.ok)
      throw classify(response.status, await readText(response, timeoutMs));
    const parsed = responseSchema.parse(await readJson(response, timeoutMs));

    if (parsed.stop_reason === "max_tokens")
      throw new ProviderTruncatedError(
        maxTokens,
        parsed.usage?.output_tokens ?? 0,
      );

    return {
      text: parsed.content.map((block) => block.text ?? "").join(""),
      model: parsed.model ?? request.model,
      promptTokens: parsed.usage?.input_tokens ?? 0,
      completionTokens: parsed.usage?.output_tokens ?? 0,
    };
  },

  async ping(credentials, model, options): Promise<void> {
    await this.chat(credentials, {
      model,
      messages: [{ role: "user", content: "ping" }],
      // No maxTokens: a 1-token cap makes every ping finish on MAX_TOKENS, which is now a
      // ProviderTruncatedError. The model stops on its own after "ping"; the cap is a ceiling, not a target.
      timeoutMs: options?.timeoutMs ?? schoolConfig.ai.pingTimeoutMs,
    });
  },
};
