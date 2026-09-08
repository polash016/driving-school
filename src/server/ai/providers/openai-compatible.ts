import { z } from "zod";
import { schoolConfig } from "../../../../config/school.config";
import {
  classify,
  fetchWithDeadline,
  readJson,
  readText,
  type ChatRequest,
  type ChatResponse,
  type EmbedRequest,
  type ProviderAdapter,
  type ProviderCredentials,
} from "./types";

/**
 * The OpenAI-compatible adapter (spec-05): DeepSeek, OpenRouter, Groq, Mistral, Ollama, and the
 * existing OmniRoute endpoint — anything that speaks /chat/completions. The base URL is what
 * distinguishes them, which is why it is a per-provider field rather than a code branch.
 */

const chatSchema = z.object({
  model: z.string().optional(),
  choices: z
    .array(z.object({ message: z.object({ content: z.string() }) }))
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
    })
    .optional(),
});

const embedSchema = z.object({
  data: z.array(z.object({ embedding: z.array(z.number()) })).min(1),
});

function endpoint(credentials: ProviderCredentials, path: string): string {
  const base = (credentials.baseUrl ?? "https://api.openai.com/v1").replace(
    /\/$/,
    "",
  );
  return `${base}${path}`;
}

export const openAiCompatibleAdapter: ProviderAdapter = {
  kind: "OPENAI_COMPATIBLE",

  async chat(credentials, request: ChatRequest): Promise<ChatResponse> {
    const timeoutMs = request.timeoutMs ?? schoolConfig.ai.requestTimeoutMs;
    const response = await fetchWithDeadline(
      endpoint(credentials, "/chat/completions"),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${credentials.apiKey}`,
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          // Explicit, never omitted: OmniRoute (and OpenRouter) stream when `stream` is absent,
          // which answers 200 with text/event-stream that no JSON parser can read.
          stream: false,
          temperature: request.temperature ?? 0.4,
          max_tokens: request.maxTokens ?? 4096,
          ...(request.json ? { response_format: { type: "json_object" } } : {}),
        }),
      },
      { timeoutMs, ...(request.signal ? { signal: request.signal } : {}) },
    );

    if (!response.ok)
      throw classify(response.status, await readText(response, timeoutMs));
    const parsed = chatSchema.parse(await readJson(response, timeoutMs));

    return {
      text: parsed.choices[0].message.content,
      model: parsed.model ?? request.model,
      promptTokens: parsed.usage?.prompt_tokens ?? 0,
      completionTokens: parsed.usage?.completion_tokens ?? 0,
    };
  },

  async embed(credentials, request: EmbedRequest): Promise<number[][]> {
    const timeoutMs = request.timeoutMs ?? schoolConfig.ai.requestTimeoutMs;
    const response = await fetchWithDeadline(
      endpoint(credentials, "/embeddings"),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${credentials.apiKey}`,
        },
        body: JSON.stringify({ model: request.model, input: request.input }),
      },
      { timeoutMs, ...(request.signal ? { signal: request.signal } : {}) },
    );
    if (!response.ok)
      throw classify(response.status, await readText(response, timeoutMs));
    return embedSchema
      .parse(await readJson(response, timeoutMs))
      .data.map((row) => row.embedding);
  },

  async ping(credentials, model, options): Promise<void> {
    await this.chat(credentials, {
      model,
      messages: [{ role: "user", content: "ping" }],
      // No maxTokens: a 1-token cap makes self-hosted Ollama behind OmniRoute 502 on roughly
      // half of all calls (measured 11/24 vs 24/24 at the 4096 default, interleaved to rule out
      // warm-up), so the health check was failing on a healthy provider. The model stops on its
      // own after "Hi" — the cap is a ceiling, not a target, so the default costs nothing here.
      timeoutMs: options?.timeoutMs ?? schoolConfig.ai.pingTimeoutMs,
    });
  },
};
