import { z } from "zod";
import { schoolConfig } from "../../../../config/school.config";
import {
  classify,
  fetchWithDeadline,
  ProviderError,
  ProviderTruncatedError,
  readJson,
  readText,
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
        // A MAX_TOKENS finish can arrive with no `content` at all (nothing was produced before
        // the cap) or with `content.parts` holding only a partial fragment — both are truncation,
        // not a malformed response, so neither field can be required here.
        content: z
          .object({
            parts: z
              .array(z.object({ text: z.string().optional() }))
              .optional(),
          })
          .optional(),
        finishReason: z.string().optional(),
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
            mime_type: part.image_url.url.slice(
              5,
              part.image_url.url.indexOf(";"),
            ),
            data: part.image_url.url.slice(part.image_url.url.indexOf(",") + 1),
          },
        },
  );
}

export const googleAdapter: ProviderAdapter = {
  kind: "GOOGLE",

  async chat(credentials, request: ChatRequest): Promise<ChatResponse> {
    const base = (credentials.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
    const system = request.messages.find(
      (message) => message.role === "system",
    );
    const user = request.messages.filter(
      (message) => message.role !== "system",
    );

    // Gemini rejects a request whose `contents` is empty ("contents is not specified"), so a
    // prompt that is purely a system instruction — which is most of ours — becomes the user turn.
    const useSystemAsContent = user.length === 0 && Boolean(system);
    const contents = useSystemAsContent
      ? [{ role: "user", parts: toGeminiParts(system!.content) }]
      : user.map((message) => ({
          role: "user",
          parts: toGeminiParts(message.content),
        }));
    const timeoutMs = request.timeoutMs ?? schoolConfig.ai.requestTimeoutMs;
    const maxTokens = request.maxTokens ?? 4096;

    const response = await fetchWithDeadline(
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
            maxOutputTokens: maxTokens,
            ...(request.json ? { responseMimeType: "application/json" } : {}),
          },
        }),
      },
      { timeoutMs, ...(request.signal ? { signal: request.signal } : {}) },
    );

    if (!response.ok)
      throw classify(response.status, await readText(response, timeoutMs));
    const parsed = responseSchema.parse(await readJson(response, timeoutMs));

    const candidate = parsed.candidates[0];
    if (candidate.finishReason === "MAX_TOKENS")
      throw new ProviderTruncatedError(
        maxTokens,
        parsed.usageMetadata?.candidatesTokenCount ?? 0,
      );
    // SAFETY, RECITATION, or a STOP with nothing generated: not truncation, just nothing to
    // return. Left unchecked this silently became "" and surfaced downstream as a misleading
    // "response failed contract validation" instead of naming what Gemini actually said.
    if (!candidate.content?.parts?.length)
      throw new ProviderError(
        `no content returned (finishReason ${candidate.finishReason ?? "unset"})`,
        502,
        false,
      );
    const text = candidate.content.parts
      .map((part) => part.text ?? "")
      .join("");

    return {
      text,
      model: request.model,
      promptTokens: parsed.usageMetadata?.promptTokenCount ?? 0,
      completionTokens: parsed.usageMetadata?.candidatesTokenCount ?? 0,
    };
  },

  async embed(credentials, request: EmbedRequest): Promise<number[][]> {
    const base = (credentials.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
    const timeoutMs = request.timeoutMs ?? schoolConfig.ai.requestTimeoutMs;
    const response = await fetchWithDeadline(
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
      { timeoutMs, ...(request.signal ? { signal: request.signal } : {}) },
    );
    if (!response.ok)
      throw classify(response.status, await readText(response, timeoutMs));
    const vectors = embedSchema
      .parse(await readJson(response, timeoutMs))
      .embeddings.map((row) => row.values);

    // Fail loudly rather than writing a vector the column cannot hold: a silent dimension
    // mismatch would corrupt the knowledge base one chunk at a time.
    const wrong = vectors.find(
      (vector) => vector.length !== EMBEDDING_DIMENSIONS,
    );
    if (wrong) {
      throw new ProviderError(
        `embedding model returned ${wrong.length} dimensions, expected ${EMBEDDING_DIMENSIONS}`,
        500,
        false,
      );
    }
    return vectors;
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
