import { z } from "zod";
import {
  classify,
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
  content: z
    .array(z.object({ type: z.string(), text: z.string().optional() }))
    .min(1),
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

    const response = await fetch(`${base}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": credentials.apiKey,
        "anthropic-version": API_VERSION,
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: request.maxTokens ?? 4096,
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
    });

    if (!response.ok) throw classify(response.status, await response.text());
    const parsed = responseSchema.parse(await response.json());

    return {
      text: parsed.content.map((block) => block.text ?? "").join(""),
      model: parsed.model ?? request.model,
      promptTokens: parsed.usage?.input_tokens ?? 0,
      completionTokens: parsed.usage?.output_tokens ?? 0,
    };
  },

  async ping(credentials, model): Promise<void> {
    await this.chat(credentials, {
      model,
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 1,
    });
  },
};
