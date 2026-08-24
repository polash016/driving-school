import { z } from "zod";
import { schoolConfig } from "../../../config/school.config";
import { env } from "@/lib/env";
import { AiPipelineError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import type { PromptTemplate } from "./prompts";

/**
 * THE single AI gateway (mandate 4 / architecture blueprint §6).
 * Every AI call in the codebase goes through this module → OmniRoute
 * (OpenAI-compatible API). Model ids come from school config per task —
 * never inline model strings anywhere else.
 *
 * NEVER call this from a request path (spec-07 hard rule) — workers only.
 */

export type AiTask = keyof typeof schoolConfig.ai.models;

interface GatewayMessage {
  role: "system" | "user";
  content:
    | string
    | Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string } }
      >;
}

export interface AiUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface AiChatResult<T> {
  data: T;
  modelVersion: string;
  promptVersion: string;
  usage: AiUsage;
}

/** Injected by the queue layer — pauses work when the daily budget is spent (spec-06). */
export type CostGuard = (usage: AiUsage, task: AiTask) => Promise<void>;

let costGuard: CostGuard | null = null;
export function registerCostGuard(guard: CostGuard) {
  costGuard = guard;
}

function gatewayConfig() {
  const { OMNIROUTE_BASE_URL, OMNIROUTE_API_KEY } = env();
  if (!OMNIROUTE_BASE_URL || !OMNIROUTE_API_KEY) {
    throw new AiPipelineError({ reason: "AI gateway env not configured" });
  }
  return { baseUrl: OMNIROUTE_BASE_URL.replace(/\/$/, ""), apiKey: OMNIROUTE_API_KEY };
}

const chatResponseSchema = z.object({
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

/**
 * Structured chat call: renders the versioned prompt, requests JSON, validates
 * the response against `schema`, logs provenance. Throws AiPipelineError on any
 * transport/shape failure (callers in BullMQ retry with backoff).
 */
export async function aiJson<TVars, T>(opts: {
  task: AiTask;
  prompt: PromptTemplate<TVars>;
  vars: TVars;
  schema: z.ZodType<T>;
  userContent?: GatewayMessage["content"];
  temperature?: number;
  maxTokens?: number;
}): Promise<AiChatResult<T>> {
  const { baseUrl, apiKey } = gatewayConfig();
  const model = schoolConfig.ai.models[opts.task];
  const messages: GatewayMessage[] = [
    { role: "system", content: opts.prompt.render(opts.vars) },
    ...(opts.userContent ? [{ role: "user" as const, content: opts.userContent }] : []),
  ];

  const started = Date.now();
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: opts.temperature ?? 0.4,
      max_tokens: opts.maxTokens ?? 4096,
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    throw new AiPipelineError({
      task: opts.task,
      status: res.status,
      body: (await res.text()).slice(0, 500),
    });
  }

  const parsed = chatResponseSchema.safeParse(await res.json());
  if (!parsed.success) {
    throw new AiPipelineError({ task: opts.task, reason: "bad gateway response shape" });
  }

  let data: T;
  try {
    data = opts.schema.parse(JSON.parse(parsed.data.choices[0].message.content));
  } catch (error) {
    throw new AiPipelineError({
      task: opts.task,
      reason: "response failed contract validation",
      error: String(error),
    });
  }

  const usage: AiUsage = {
    promptTokens: parsed.data.usage?.prompt_tokens ?? 0,
    completionTokens: parsed.data.usage?.completion_tokens ?? 0,
  };
  if (costGuard) await costGuard(usage, opts.task);

  logger.info(
    {
      task: opts.task,
      model: parsed.data.model ?? model,
      promptId: opts.prompt.id,
      promptVersion: opts.prompt.version,
      usage,
      ms: Date.now() - started,
    },
    "ai call",
  );

  return {
    data,
    modelVersion: parsed.data.model ?? model,
    promptVersion: `${opts.prompt.id}@${opts.prompt.version}`,
    usage,
  };
}

const embeddingResponseSchema = z.object({
  model: z.string().optional(),
  data: z.array(z.object({ embedding: z.array(z.number()) })).min(1),
});

/** Embedding call for KB ingestion / search (spec-05). Dimension must match KbChunk vector(1536). */
export async function aiEmbed(texts: string[]): Promise<number[][]> {
  const { baseUrl, apiKey } = gatewayConfig();
  const res = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: schoolConfig.ai.models.embedding,
      input: texts,
    }),
  });
  if (!res.ok) {
    throw new AiPipelineError({ task: "embedding", status: res.status });
  }
  const parsed = embeddingResponseSchema.safeParse(await res.json());
  if (!parsed.success) {
    throw new AiPipelineError({ task: "embedding", reason: "bad response shape" });
  }
  return parsed.data.data.map((d) => d.embedding);
}
