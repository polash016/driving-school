import type { AiTask as AiTaskEnum } from "@prisma/client";
import { z } from "zod";
import { env } from "@/lib/env";
import { AiPipelineError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { db } from "@/server/db";
import {
  adapterFor,
  ProviderError,
  ProviderTruncatedError,
  type ProviderMessage,
} from "./providers";
import type { PromptTemplate } from "./prompts";
import { schoolConfig } from "../../../config/school.config";

/**
 * THE single AI gateway (mandate 4 / architecture blueprint §6).
 *
 * Every AI call in the codebase goes through this module. Since spec-05 it resolves the provider
 * and model per task from the database (admin-managed keys, encrypted at rest) and walks an
 * ordered fallback chain: a quota error or a provider outage moves to the next route rather than
 * failing the job. That is what makes free tiers usable in practice.
 *
 * Env (`OMNIROUTE_*`) remains the fallback so CI, tests and a fresh clone work with no database
 * configuration at all.
 *
 * NEVER call this from a request path (spec-07 hard rule) — workers and admin actions only.
 */

export type AiTask =
  | "vision"
  | "generation"
  | "validation"
  | "embedding"
  | "image"
  | "translation";

const TASK_ENUM: Record<AiTask, AiTaskEnum> = {
  vision: "VISION",
  generation: "GENERATION",
  validation: "VALIDATION",
  embedding: "EMBEDDING",
  image: "IMAGE",
  translation: "TRANSLATION",
};

export interface AiUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface AiChatResult<T> {
  data: T;
  modelVersion: string;
  promptVersion: string;
  usage: AiUsage;
  /** Which configured provider answered — recorded on every artefact for provenance. */
  providerLabel: string;
}

/** Injected by the queue layer — pauses work when the daily budget is spent (spec-06). */
export type CostGuard = (usage: AiUsage, task: AiTask) => Promise<void>;

let costGuard: CostGuard | null = null;
export function registerCostGuard(guard: CostGuard) {
  costGuard = guard;
}

interface Candidate {
  providerLabel: string;
  kind: "GOOGLE" | "ANTHROPIC" | "OPENAI_COMPATIBLE";
  model: string;
  apiKey: string;
  baseUrl: string | null;
}

/**
 * Configured routes first; the env endpoint last. A deployment that has configured providers
 * never silently falls back to whatever the environment happens to hold — that only applies when
 * nothing is configured at all.
 */
async function candidatesFor(task: AiTask): Promise<Candidate[]> {
  const { resolveRoutes } = await import("@/server/services/ai/providers");
  const routes = await resolveRoutes(db, TASK_ENUM[task]).catch((error) => {
    logger.warn(
      { task, error },
      "route resolution failed — falling back to env",
    );
    return [];
  });

  const candidates: Candidate[] = routes.map((route) => ({
    providerLabel: route.providerLabel,
    kind: route.kind,
    model: route.model,
    apiKey: route.apiKey,
    baseUrl: route.baseUrl,
  }));

  if (candidates.length === 0) {
    const { OMNIROUTE_BASE_URL, OMNIROUTE_API_KEY } = env();
    if (OMNIROUTE_BASE_URL && OMNIROUTE_API_KEY) {
      candidates.push({
        providerLabel: "env:omniroute",
        kind: "OPENAI_COMPATIBLE",
        model: schoolConfig.ai.models[task === "image" ? "vision" : task],
        apiKey: OMNIROUTE_API_KEY,
        baseUrl: OMNIROUTE_BASE_URL,
      });
    }
  }

  if (candidates.length === 0) {
    throw new AiPipelineError({ task, reason: "no AI provider configured" });
  }
  return candidates;
}

/**
 * Walks the chain until one route answers. A retryable failure (quota, 5xx) moves on; a
 * non-retryable one (bad key, bad request) is reported immediately — trying three providers with
 * the same malformed prompt just wastes three quotas.
 */
async function withFallback<T>(
  task: AiTask,
  run: (candidate: Candidate) => Promise<T>,
): Promise<{ result: T; candidate: Candidate }> {
  const candidates = await candidatesFor(task);
  const failures: string[] = [];

  for (const [index, candidate] of candidates.entries()) {
    try {
      return { result: await run(candidate), candidate };
    } catch (error) {
      // A truncation must reach the runner as itself: it halves the batch, it does not try route 2.
      if (error instanceof ProviderTruncatedError) throw error;

      const retryable =
        error instanceof ProviderError ? error.retryable : false;
      const message =
        error instanceof Error ? error.message.slice(0, 200) : String(error);
      failures.push(
        `${candidate.providerLabel}/${candidate.model}: ${message}`,
      );

      logger.warn(
        {
          task,
          provider: candidate.providerLabel,
          model: candidate.model,
          retryable,
          remaining: candidates.length - index - 1,
          error: message,
        },
        retryable ? "AI route failed — trying the next one" : "AI route failed",
      );

      if (!retryable) break;
    }
  }

  throw new AiPipelineError({ task, reason: "all AI routes failed", failures });
}

/**
 * Structured chat call: renders the versioned prompt, requests JSON, validates the response
 * against `schema`, records provenance. Throws AiPipelineError once every route has been tried.
 */
export async function aiJson<TVars, T>(opts: {
  task: AiTask;
  prompt: PromptTemplate<TVars>;
  vars: TVars;
  schema: z.ZodType<T>;
  userContent?: ProviderMessage["content"];
  temperature?: number;
  maxTokens?: number;
  /** Caller cancellation — the i18n worker passes its shutdown signal through here. */
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<AiChatResult<T>> {
  const started = Date.now();
  const messages: ProviderMessage[] = [
    { role: "system", content: opts.prompt.render(opts.vars) },
    ...(opts.userContent
      ? [{ role: "user" as const, content: opts.userContent }]
      : []),
  ];

  const { result, candidate } = await withFallback(opts.task, (route) =>
    adapterFor(route.kind).chat(
      { apiKey: route.apiKey, baseUrl: route.baseUrl },
      {
        model: route.model,
        messages,
        temperature: opts.temperature ?? 0.4,
        maxTokens: opts.maxTokens ?? 4096,
        json: true,
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      },
    ),
  );

  let data: T;
  try {
    data = opts.schema.parse(JSON.parse(result.text));
  } catch (error) {
    throw new AiPipelineError({
      task: opts.task,
      reason: "response failed contract validation",
      provider: candidate.providerLabel,
      error: String(error).slice(0, 300),
    });
  }

  const usage: AiUsage = {
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
  };
  if (costGuard) await costGuard(usage, opts.task);

  logger.info(
    {
      task: opts.task,
      provider: candidate.providerLabel,
      model: result.model,
      promptId: opts.prompt.id,
      promptVersion: opts.prompt.version,
      usage,
      ms: Date.now() - started,
    },
    "ai call",
  );

  return {
    data,
    modelVersion: result.model,
    promptVersion: `${opts.prompt.id}@${opts.prompt.version}`,
    usage,
    providerLabel: candidate.providerLabel,
  };
}

/** Embedding call for KB ingestion / search (spec-05). Dimension must match KbChunk vector(1536). */
export async function aiEmbed(
  texts: string[],
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<number[][]> {
  const { result } = await withFallback("embedding", async (route) => {
    const adapter = adapterFor(route.kind);
    if (!adapter.embed) {
      throw new ProviderError(
        `${route.kind} has no embedding endpoint`,
        400,
        false,
      );
    }
    return adapter.embed(
      { apiKey: route.apiKey, baseUrl: route.baseUrl },
      {
        model: route.model,
        input: texts,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      },
    );
  });
  return result;
}
