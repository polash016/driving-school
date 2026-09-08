import type { AiTask as AiTaskEnum } from "@prisma/client";
import { z } from "zod";
import { env } from "@/lib/env";
import { AiPipelineError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { db } from "@/server/db";
import {
  abortedError,
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
 * A cancellable delay. Rejects immediately if `signal` is already aborted, or as soon as it fires
 * while waiting — a worker shutdown must not sit through the rest of a 40s backoff.
 *
 * Named `sleepOrAbort`, not `sleep`: `src/server/services/i18n/worker.ts` has its own `sleep` with
 * the OPPOSITE contract (it resolves, not rejects, on abort — the poll loop just wants to stop
 * waiting, not to see an error). Do not unify them; a shared name inviting a shared import would
 * silently flip one caller's control flow.
 */
function sleepOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortedError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(abortedError());
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** A per-minute quota has reset by here; a per-day one never will inside a run. */
const RATE_LIMIT_MAX_DELAY_MS = 60_000;

/**
 * The 429 back-off ladder: base × 2^attempt, ±20% jitter, capped so a per-day quota (which never
 * recovers inside a run) cannot stall a worker for longer than a per-minute one takes to reset.
 * `random` is injected so a test can pin the jitter instead of racing it.
 */
export function retryDelayMs(attempt: number, random = Math.random()): number {
  const jitter = 0.8 + random * 0.4;
  return Math.min(
    schoolConfig.ai.rateLimitBaseDelayMs * 2 ** attempt * jitter,
    RATE_LIMIT_MAX_DELAY_MS,
  );
}

/**
 * Walks the chain until one route answers. A 429 is a per-minute quota, not a dead route: it is
 * waited out on the SAME route (5s, 10s, 20s, 40s with jitter, capped at 60s) before the chain
 * moves on — falling through immediately just spends the next route's quota too (spec-19a). Any
 * other retryable failure (5xx) moves on right away; a non-retryable one (bad key, bad request) is
 * reported immediately — trying three providers with the same malformed prompt just wastes three
 * quotas.
 */
async function withFallback<T>(
  task: AiTask,
  run: (candidate: Candidate) => Promise<T>,
  signal?: AbortSignal,
): Promise<{ result: T; candidate: Candidate }> {
  const candidates = await candidatesFor(task);
  const failures: string[] = [];

  candidates: for (const [index, candidate] of candidates.entries()) {
    attempts: for (let attempt = 0; ; attempt++) {
      try {
        return { result: await run(candidate), candidate };
      } catch (error) {
        // A truncation must reach the runner as itself: it halves the batch, it does not try
        // route 2. Not logged or recorded here: the runner logs the halving, and the class
        // carries the cause.
        if (error instanceof ProviderTruncatedError) throw error;

        // 600, not 200: Gemini's 429 body names the exhausted quota metric after ~350 chars, and
        // this is the only place that error text reaches a log.
        const message =
          error instanceof Error
            ? error.message.slice(0, 600)
            : String(error).slice(0, 600);

        const rateLimited =
          error instanceof ProviderError && error.status === 429;
        if (rateLimited && attempt < schoolConfig.ai.rateLimitRetries) {
          // Per-minute quotas recover; falling through would only spend the next route's quota
          // too.
          const delay = retryDelayMs(attempt);
          logger.warn(
            {
              task,
              provider: candidate.providerLabel,
              model: candidate.model,
              attempt,
              delayMs: Math.round(delay),
              error: message,
            },
            "rate limited — waiting on the same route",
          );
          await sleepOrAbort(delay, signal);
          continue attempts;
        }

        const retryable =
          error instanceof ProviderError ? error.retryable : false;
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
          retryable
            ? "AI route failed — trying the next one"
            : "AI route failed",
        );

        if (!retryable) break candidates;
        continue candidates;
      }
    }
  }

  throw new AiPipelineError({ task, reason: "all AI routes failed", failures });
}

/**
 * Structured chat call: renders the versioned prompt, requests JSON, validates the response
 * against `schema`, records provenance. Throws AiPipelineError once every route has been tried.
 * A caller-supplied `signal` that aborts during a rate-limit wait rejects with a retryable
 * `ProviderError` (499) instead.
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

  const { result, candidate } = await withFallback(
    opts.task,
    (route) =>
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
    opts.signal,
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
  const { result } = await withFallback(
    "embedding",
    async (route) => {
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
    },
    options.signal,
  );
  return result;
}
