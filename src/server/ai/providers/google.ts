import { z } from "zod";
import {
  classify,
  ProviderError,
  type ChatRequest,
  type ChatResponse,
  type EmbedRequest,
  type ProviderAdapter,
} from "./types";

/**
 * Google Gemini (spec-05). Native rather than through an aggregator: Gemini's own API is where
 * the free tier, the multimodal input and the image models live.
 *
 * Its wire format differs from OpenAI's — `contents` with `parts`, a separate
 * `systemInstruction`, and the key as a query parameter — which is exactly what an adapter is for.
 */

const DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta";

/**
 * KbChunk.embedding is `vector(1536)`, so that is what we must ask for. Gemini's embedding models
 * default to 3072 dimensions and honour `outputDimensionality` — without this every vector would
 * be rejected by the column (or, worse, silently mismatch a differently-sized one).
 */
const EMBEDDING_DIMENSIONS = 1536;

const responseSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z.object({ parts: z.array(z.object({ text: z.string().optional() })) }),
      }),
    )
    .min(1),
  usageMetadata: z
    .object({
      promptTokenCount: z.number().optional(),
      candidatesTokenCount: z.number().optional(),
    })
    .optional(),
});

const embedSchema = z.object({
  embeddings: z.array(z.object({ values: z.array(z.number()) })).min(1),
});

function toGeminiParts(content: ChatRequest["messages"][number]["content"]) {
  if (typeof content === "string") return [{ text: content }];
  return content.map((part) =>
    part.type === "text"
      ? { text: part.text }
      : {
          // Gemini takes image bytes inline; a data: URL carries both mime type and payload.
          inline_data: {
            mime_type: part.image_url.url.slice(5, part.image_url.url.indexOf(";")),
            data: part.image_url.url.slice(part.image_url.url.indexOf(",") + 1),
          },
        },
  );
}

export const googleAdapter: ProviderAdapter = {
  kind: "GOOGLE",

  async chat(credentials, request: ChatRequest): Promise<ChatResponse> {
    const base = (credentials.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
    const system = request.messages.find((message) => message.role === "system");
    const user = request.messages.filter((message) => message.role !== "system");

    // Gemini rejects a request whose `contents` is empty ("contents is not specified"), so a
    // prompt that is purely a system instruction — which is most of ours — becomes the user turn.
    const useSystemAsContent = user.length === 0 && Boolean(system);
    const contents = useSystemAsContent
      ? [{ role: "user", parts: toGeminiParts(system!.content) }]
      : user.map((message) => ({ role: "user", parts: toGeminiParts(message.content) }));

    const response = await fetch(
      `${base}/models/${request.model}:generateContent?key=${credentials.apiKey}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(system && !useSystemAsContent
            ? { systemInstruction: { parts: toGeminiParts(system.content) } }
            : {}),
          contents,
          generationConfig: {
            temperature: request.temperature ?? 0.4,
            maxOutputTokens: request.maxTokens ?? 4096,
            ...(request.json ? { responseMimeType: "application/json" } : {}),
          },
        }),
      },
    );

    if (!response.ok) throw classify(response.status, await response.text());
    const parsed = responseSchema.parse(await response.json());

    return {
      text: parsed.candidates[0].content.parts.map((part) => part.text ?? "").join(""),
      model: request.model,
      promptTokens: parsed.usageMetadata?.promptTokenCount ?? 0,
      completionTokens: parsed.usageMetadata?.candidatesTokenCount ?? 0,
    };
  },

  async embed(credentials, request: EmbedRequest): Promise<number[][]> {
    const base = (credentials.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
    const response = await fetch(
      `${base}/models/${request.model}:batchEmbedContents?key=${credentials.apiKey}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requests: request.input.map((text) => ({
            model: `models/${request.model}`,
            content: { parts: [{ text }] },
            outputDimensionality: EMBEDDING_DIMENSIONS,
          })),
        }),
      },
    );
    if (!response.ok) throw classify(response.status, await response.text());
    const vectors = embedSchema.parse(await response.json()).embeddings.map((row) => row.values);

    // Fail loudly rather than writing a vector the column cannot hold: a silent dimension
    // mismatch would corrupt the knowledge base one chunk at a time.
    const wrong = vectors.find((vector) => vector.length !== EMBEDDING_DIMENSIONS);
    if (wrong) {
      throw new ProviderError(
        `embedding model returned ${wrong.length} dimensions, expected ${EMBEDDING_DIMENSIONS}`,
        500,
        false,
      );
    }
    return vectors;
  },

  async ping(credentials, model): Promise<void> {
    await this.chat(credentials, {
      model,
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 1,
    });
  },
};
