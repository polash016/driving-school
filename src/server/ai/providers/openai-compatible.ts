import { z } from "zod";
import {
  classify,
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
    const response = await fetch(endpoint(credentials, "/chat/completions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${credentials.apiKey}`,
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        temperature: request.temperature ?? 0.4,
        max_tokens: request.maxTokens ?? 4096,
        ...(request.json ? { response_format: { type: "json_object" } } : {}),
      }),
    });

    if (!response.ok) throw classify(response.status, await response.text());
    const parsed = chatSchema.parse(await response.json());

    return {
      text: parsed.choices[0].message.content,
      model: parsed.model ?? request.model,
      promptTokens: parsed.usage?.prompt_tokens ?? 0,
      completionTokens: parsed.usage?.completion_tokens ?? 0,
    };
  },

  async embed(credentials, request: EmbedRequest): Promise<number[][]> {
    const response = await fetch(endpoint(credentials, "/embeddings"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${credentials.apiKey}`,
      },
      body: JSON.stringify({ model: request.model, input: request.input }),
    });
    if (!response.ok) throw classify(response.status, await response.text());
    return embedSchema
      .parse(await response.json())
      .data.map((row) => row.embedding);
  },

  async ping(credentials, model): Promise<void> {
    await this.chat(credentials, {
      model,
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 1,
    });
  },
};
