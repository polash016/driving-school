# Spec-19 — Unattended Translation & Publish Readiness · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **On approval this file is copied verbatim to `specs/plans/spec-19-plan.md`** (CLAUDE.md workflow), the status board row 19 flips to 📝 Planned, and the deviations in §"Decisions to log" are written to `DECISIONS.md` in the same commit.

**Goal:** An admin starts a language translating from the browser and walks away; a background worker finishes it, repairs its own QA failures, reports live progress, and the language page says exactly what still blocks publishing.

**Architecture:** No queue. The run stays the queue (rows + lease). A second pm2 process (`scripts/i18n-worker.ts`) claims runs an admin explicitly *enqueued*, drives the existing `executeRun` to completion, and chains a `REPAIR` run over `NEEDS_REVIEW` units with the QA finding fed back into the prompt. Every AI request gains a deadline in the adapter layer. Progress is polled through a read-only server action.

**Tech Stack:** Next 16 App Router server actions, Prisma 6.19 / Postgres 16, ioredis, pino, next-intl (`createTranslator` for emails), vitest, pm2 on the VPS, Node 24 (`AbortSignal.timeout`, `AbortSignal.any`).

---

## Context

Spec-15's engine works but has no way to *finish*. `runSliceAction` advances 25 units a click (a request handler cannot hold a 10-minute AI run), and QA-flagged units are served under **no** policy — `servableStatuses()` excludes `NEEDS_REVIEW` whether or not approval is required, and `bulkApproveTranslations` refuses flagged rows by design. Publishing needs 100% coverage, so the flagged pile can only be cleared one at a time. Spec-19 (approved 2026-09-08, `specs/spec-19-translation-automation.md`) makes the machine repair its own failures rather than lowering the bar, and runs the whole thing unattended.

The exploration and adversarial review before this plan found four defects in the *existing* runner that an unattended worker would expose immediately; they are fixed in Phase 1 because the worker is unsafe without them:

| Defect (existing code) | Consequence unattended | Fixed in |
| --- | --- | --- |
| Lease (2 min) is extended only *after* a batch (`runs.ts:418,443`); a QA'd batch on the slow self-hosted model is routinely >2 min | A live run is taken over mid-batch; both runners write status; partial job claim (`:350-358` bails only on `count===0`) double-translates | Task 7 (keepalive + owner-guarded writes + exact claim) |
| `RUNNING` jobs orphaned by a crash are never re-queued; completion counts only `QUEUED` (`:459`) | After `kill -9` the run "completes" with units silently missing | Task 7 (re-queue on claim; completion = no `QUEUED`/`RUNNING`) |
| No adapter sets a request timeout; `withFallback` treats non-`ProviderError` (incl. `TypeError: fetch failed`) as non-retryable (`client.ts:130`) | One hung call blocks a run until the lease lapses; a provider outage stops the chain at route 1 | Tasks 2–4 (layer 0) |
| `storeTranslations` upsert is unconditional (`translate.ts:341-359`) | A repair would clobber a row a human approved meanwhile | Task 16 (conditional repair store) |

## Decisions to log in `DECISIONS.md` on approval

1. **`repairAttempts` lives on `Translation`, not `TranslationJob`** (spec §Data model says Job). A job is per-run; the 3-attempt ceiling must persist across REPAIR runs or each new REPAIR run gets a fresh budget → infinite loop. Reset to 0 whenever a non-REPAIR run re-translates the unit (fresh translation, fresh budget).
2. **Extra additive columns beyond the spec:** `TranslationRun.enqueuedAt` (the worker gate — keeps today's cost-free Plan cost-free), `pauseRequested` (an admin pause must survive the claim query; `PAUSED` alone already means "slice ended"), `rateUnitsPerMin` + `modelBatches` (EWMA throughput; a `finishedAt` window flickers to "unknown" on any slow batch), `TranslationJob.claimedBy` (Prisma 6.19's generated client here has no `updateManyAndReturn`, so an exact partial claim needs an owner column).
3. **Spec-14's "worker as a docker-compose service" is superseded by a pm2 app** for the VPS deployment: `ai-dev` is not in the `docker` group (memory: vps-production-deployment). Spec-14 is unimplemented; its brief should be amended when it is picked up.
4. **`ai.pingTimeoutMs` defaults to 60 s, not 20 s** — a healthy OmniRoute ping measured 7–13 s and 29.7 s under load.
5. **`ecosystem.config.cjs` is committed to the repo AND kept on the VPS** (user decision 2026-09-08): the repo file defines both apps; the first deploy backs up the VPS copy and reconciles.

## File map

**New**
- `src/server/services/i18n/run-control.ts` — enqueue/pause/resume/cancel, `runDetail` (progress + rate/ETA/cost/byEntity), `latestRunFor`, pure `ewmaRate`/`etaSeconds`/`heartbeatStale`.
- `src/server/services/i18n/worker.ts` — pure worker: `findClaimableRun`, `workerTick`, `runWorker`, `afterRun`, `backoffMs`. `db` injected (house convention).
- `src/server/services/i18n/repair.ts` — `repairCandidates`, `planRepairRun`, `repairContextFor`, `repairBatch`, `storeRepairs`, `isReQaOnly`.
- `src/server/services/i18n/sample.ts` — `planSampleRun`, `sampleResults`.
- `src/server/services/i18n/notify.ts` — `notificationRecipients`, `notifyRunEvent`.
- `scripts/i18n-worker.ts` — thin `main()`: env, PrismaClient, signals, `runWorker`.
- `src/components/admin/languages/run-panel.tsx` — polled progress + controls (client).
- `src/components/admin/languages/readiness-checklist.tsx` — blockers (server-safe).
- `src/components/admin/languages/sample-results.tsx` — side-by-side sample (client, polls).
- `src/app/[locale]/(admin)/admin/languages/loading.tsx` — skeleton.
- `ecosystem.config.cjs` — both pm2 apps.
- `prisma/migrations/20260909090000_translation_background_runs/migration.sql`.

**Modified**
- `config/school.config.ts` (+ test) — `ai.requestTimeoutMs`, `ai.pingTimeoutMs`.
- `src/server/ai/providers/types.ts` — `fetchWithDeadline`, `asProviderError`, `readJson` (moved here), `timeoutMs`/`signal` on requests, `ping` options.
- `src/server/ai/providers/{anthropic,google,openai-compatible}.ts` — all five `fetch` sites.
- `src/server/ai/client.ts` — `signal`/`timeoutMs` pass-through on `aiJson`/`aiEmbed`.
- `src/server/services/i18n/translate.ts` — `options.signal`, `repairAttempts: 0` on store.
- `src/server/services/i18n/qa.ts` — `signal`, rethrow on abort.
- `src/server/services/i18n/runs.ts` — `executeRun` rewrite (see Task 7), `planRun` gains `enqueue`.
- `src/server/services/i18n/languages.ts` — `blockers`, `partitionBlockers`, `untranslatedUnits`.
- `src/server/services/i18n/review.ts` — `reviewQueue` `status?` filter.
- `src/server/ai/prompts/translation.ts` — `translateRepairPrompt`.
- `src/server/email/templates.ts` — three run emails.
- `src/server/audit.ts`, `src/server/redis.ts`, `src/lib/env.ts`, `.env.example`, `package.json`.
- `src/app/[locale]/(admin)/admin/languages/{page,actions,[code]/page}.tsx`, `src/components/admin/languages/language-board.tsx`.
- `src/i18n/messages/{en,nb}.json` — `admin.languages.*`, `emails.i18nRun.*`.
- `prisma/schema.prisma`.

## Conventions every task must follow

- `requireUser()` stays **outside** the `try` in every action (`actions.ts:25-33` doc comment).
- `exactOptionalPropertyTypes` is on: use the conditional-spread idiom `...(x ? { x } : {})`, never pass `undefined`.
- New i18n keys go in **both** `en.json` and `nb.json`; `src/i18n/messages.test.ts` fails on parity/empty strings. No ICU plurals — house style is `{param}` with pre-formatted strings.
- Every new query states its index in a comment (CLAUDE.md mandate 2).
- Migrations: `pnpm prisma migrate dev --create-only --name …`, then hand-edit: delete the HNSW/generated-column drops Prisma re-proposes (`prisma/migrations.test.ts` enforces this), add the `-- spec-19:` prose header.
- Commit after every task; message style `spec-19: <lowercase clause>`.
- Before Task 12 (the poller) read `node_modules/next/dist/docs/01-app/02-guides/server-actions.md` — this is Next 16, not 15.

---

# Phase 0 — Layer 0: a deadline on every AI request

### Task 1: Timeout policy in school config

**Files:**
- Modify: `config/school.config.ts` (schema `ai` block ~line 66-77, literal ~line 139-148)
- Test: `config/school.config.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `config/school.config.test.ts` inside the existing `describe`:

```ts
it("carries AI request deadlines (spec-19 layer 0)", () => {
  expect(schoolConfig.ai.requestTimeoutMs).toBeGreaterThanOrEqual(60_000);
  expect(schoolConfig.ai.pingTimeoutMs).toBeGreaterThanOrEqual(30_000);
  expect(schoolConfig.ai.pingTimeoutMs).toBeLessThan(schoolConfig.ai.requestTimeoutMs);
});
```

- [ ] **Step 2: Run it — expect FAIL** (`Property 'requestTimeoutMs' does not exist`)

Run: `pnpm vitest run config/school.config.test.ts`

- [ ] **Step 3: Add the fields**

In the zod schema `ai` block, after `dailyBudgetUsd`:

```ts
      /**
       * Deadline on every provider request (spec-19 layer 0). A person reloads a hung page; an
       * unattended worker has nobody to give up, so the adapter must. Generous on purpose: the
       * self-hosted model measured 0.5 s one day and 29.7 s the next for the same call, and a
       * 5-unit translation batch asks for 8192 tokens.
       */
      requestTimeoutMs: z.number().int().positive(),
      /** "Test connection" budget. A healthy OmniRoute ping measured 7–13 s; 29.7 s under load. */
      pingTimeoutMs: z.number().int().positive(),
```

In the literal after `dailyBudgetUsd: 20,`:

```ts
      requestTimeoutMs: 180_000,
      pingTimeoutMs: 60_000,
```

- [ ] **Step 4: Run — expect PASS**, then `pnpm exec tsc --noEmit`.
- [ ] **Step 5: Commit** — `spec-19: AI request deadlines are school config`

### Task 2: `fetchWithDeadline` and the error mapping

**Files:**
- Modify: `src/server/ai/providers/types.ts`
- Test: `src/server/ai/providers/deadline.test.ts` (new)

- [ ] **Step 1: Write the failing tests**

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { asProviderError, fetchWithDeadline, ProviderError, readJson } from "./types";

afterEach(() => vi.unstubAllGlobals());

/** A fetch that accepts the connection and never answers — only the signal can end it. */
function hangingFetch() {
  return vi.fn(
    (_url: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      }),
  );
}

describe("fetchWithDeadline", () => {
  it("aborts a server that never responds and reports it as retryable", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const started = Date.now();
    await expect(
      fetchWithDeadline("https://x.test/v1", { method: "POST" }, { timeoutMs: 120 }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ProviderError && e.status === 504 && e.retryable,
    );
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("honours an outer signal (worker shutdown) as retryable too", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const outer = new AbortController();
    const pending = fetchWithDeadline("https://x.test/v1", {}, { timeoutMs: 60_000, signal: outer.signal });
    outer.abort();
    await expect(pending).rejects.toSatisfy(
      (e: unknown) => e instanceof ProviderError && e.retryable,
    );
  });

  it("maps a network failure (undici TypeError) to a retryable 503", () => {
    const error = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    const mapped = asProviderError(error, 1000);
    expect(mapped).toBeInstanceOf(ProviderError);
    expect((mapped as ProviderError).status).toBe(503);
    expect((mapped as ProviderError).retryable).toBe(true);
    expect((mapped as ProviderError).message).toContain("ECONNREFUSED");
  });

  it("passes a ProviderError through untouched and leaves unknown errors alone", () => {
    const original = new ProviderError("bad key", 401, false);
    expect(asProviderError(original, 1)).toBe(original);
    const other = new RangeError("x");
    expect(asProviderError(other, 1)).toBe(other);
  });

  it("returns the response when the server answers in time", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const response = await fetchWithDeadline("https://x.test", {}, { timeoutMs: 1000 });
    expect(response.status).toBe(200);
  });
});

describe("readJson", () => {
  it("names a non-JSON body instead of throwing a bare SyntaxError", async () => {
    const response = new Response("<html>gateway</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
    await expect(readJson(response)).rejects.toSatisfy(
      (e: unknown) => e instanceof ProviderError && e.message.includes("text/html"),
    );
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`fetchWithDeadline is not exported`)

Run: `pnpm vitest run src/server/ai/providers/deadline.test.ts`

- [ ] **Step 3: Implement in `types.ts`**

Extend the request types and adapter interface:

```ts
export interface ChatRequest {
  model: string;
  messages: ProviderMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Ask the provider for strict JSON where it supports it. */
  json?: boolean;
  /** Per-request deadline; adapters default to schoolConfig.ai.requestTimeoutMs. */
  timeoutMs?: number;
  /** Caller cancellation (worker shutdown). Combined with the deadline via AbortSignal.any. */
  signal?: AbortSignal;
}

export interface EmbedRequest {
  model: string;
  input: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ProviderAdapter {
  kind: AiProviderKind;
  chat(credentials: ProviderCredentials, request: ChatRequest): Promise<ChatResponse>;
  embed?(credentials: ProviderCredentials, request: EmbedRequest): Promise<number[][]>;
  /** Cheapest possible call that proves the key works — used by "Test connection". */
  ping(
    credentials: ProviderCredentials,
    model: string,
    options?: { timeoutMs?: number },
  ): Promise<void>;
}
```

Append after `classify`:

```ts
/**
 * Layer 0 (spec-19): every provider request carries a deadline, and every way a request can die
 * — timeout, caller abort, DNS/TLS/connection failure — surfaces as a RETRYABLE ProviderError so
 * `withFallback` moves to the next route instead of stopping the chain on a bare TypeError.
 */
export function asProviderError(error: unknown, timeoutMs: number): unknown {
  if (error instanceof ProviderError) return error;
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "TimeoutError")
    return new ProviderError(`no response within ${timeoutMs}ms`, 504, true);
  if (name === "AbortError") return new ProviderError("request aborted", 499, true);
  if (error instanceof TypeError) {
    // undici wraps ECONNREFUSED / ENOTFOUND / TLS errors as TypeError("fetch failed") with a cause.
    const code = (error as { cause?: { code?: unknown } }).cause?.code;
    return new ProviderError(
      `network failure${typeof code === "string" ? ` (${code})` : ""}`,
      503,
      true,
    );
  }
  return error;
}

export async function fetchWithDeadline(
  url: string,
  init: RequestInit,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<Response> {
  const deadline = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
  try {
    return await fetch(url, { ...init, signal });
  } catch (error) {
    throw asProviderError(error, options.timeoutMs);
  }
}

/**
 * Read a JSON body without ever surfacing a bare SyntaxError. A gateway streaming by default, a
 * proxy sign-in page, an HTML error page: all answer 200 with something JSON.parse rejects, and
 * that parser message is what the admin screen would otherwise show. The body read is under the
 * same signal as the request, so a server that sends headers and then stalls is caught here too.
 */
export async function readJson(response: Response, timeoutMs = 0): Promise<unknown> {
  let body: string;
  try {
    body = await response.text();
  } catch (error) {
    throw asProviderError(error, timeoutMs);
  }
  try {
    return JSON.parse(body);
  } catch {
    const contentType = response.headers.get("content-type") ?? "no content-type";
    throw new ProviderError(
      `expected a JSON completion but the endpoint returned ${contentType}: ${body.slice(0, 160)}`,
      response.status,
      false,
    );
  }
}
```

- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit** — `spec-19: fetchWithDeadline maps every request death to a retryable error`

### Task 3: Thread the deadline through all five fetch sites

**Files:**
- Modify: `src/server/ai/providers/openai-compatible.ts` (chat `:68`, embed `:98`, ping; delete its local `readJson`)
- Modify: `src/server/ai/providers/anthropic.ts` (`:42`)
- Modify: `src/server/ai/providers/google.ts` (`:90`, `:124`)
- Test: extend `src/server/ai/providers/openai-compatible.test.ts`

- [ ] **Step 1: Write the failing test** (append to `openai-compatible.test.ts`)

```ts
it("gives up on a provider that never answers, within the request deadline", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) =>
          init.signal?.addEventListener("abort", () => reject(init.signal!.reason)),
        ),
    ),
  );
  await expect(
    openAiCompatibleAdapter.chat(CREDENTIALS, {
      model: "m",
      messages: [{ role: "user", content: "ping" }],
      timeoutMs: 100,
    }),
  ).rejects.toSatisfy((e: unknown) => e instanceof ProviderError && e.status === 504 && e.retryable);
});

it("sends the configured default deadline when the request carries none", async () => {
  const fetchMock = vi.fn(async (_u: string, init: RequestInit) => {
    expect(init.signal).toBeInstanceOf(AbortSignal);
    return new Response(JSON.stringify(COMPLETION), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  await openAiCompatibleAdapter.chat(CREDENTIALS, { model: "m", messages: [{ role: "user", content: "x" }] });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run — expect FAIL** (no signal / no timeout behaviour)

- [ ] **Step 3: Rewrite `openai-compatible.ts` request plumbing**

Replace the imports and the two fetch calls; delete the local `readJson` (now in `types.ts`):

```ts
import { z } from "zod";
import { schoolConfig } from "../../../../config/school.config";
import {
  classify,
  fetchWithDeadline,
  readJson,
  type ChatRequest,
  type ChatResponse,
  type EmbedRequest,
  type ProviderAdapter,
  type ProviderCredentials,
} from "./types";
```

`chat`:

```ts
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

    if (!response.ok) throw classify(response.status, await response.text());
    const parsed = chatSchema.parse(await readJson(response, timeoutMs));

    return {
      text: parsed.choices[0].message.content,
      model: parsed.model ?? request.model,
      promptTokens: parsed.usage?.prompt_tokens ?? 0,
      completionTokens: parsed.usage?.completion_tokens ?? 0,
    };
  },
```

`embed` — same shape with `endpoint(credentials, "/embeddings")`, body `{ model, input }`, and `embedSchema.parse(await readJson(response, timeoutMs))`.

`ping`:

```ts
  async ping(credentials, model, options): Promise<void> {
    await this.chat(credentials, {
      model,
      messages: [{ role: "user", content: "ping" }],
      // No maxTokens: a 1-token cap makes self-hosted Ollama behind OmniRoute 502 on roughly half
      // of all calls (measured 11/24 vs 24/24 at the default) — see eb9a48e.
      timeoutMs: options?.timeoutMs ?? schoolConfig.ai.pingTimeoutMs,
    });
  },
```

- [ ] **Step 4: Same treatment in `anthropic.ts` and `google.ts`**

Pattern for each `fetch(url, { method, headers, body })` → `fetchWithDeadline(url, { method, headers, body }, { timeoutMs, ...(request.signal ? { signal: request.signal } : {}) })` with `const timeoutMs = request.timeoutMs ?? schoolConfig.ai.requestTimeoutMs;` at the top of `chat`/`embed`; replace `await response.json()` with `await readJson(response, timeoutMs)`; `ping(credentials, model, options)` passes `timeoutMs: options?.timeoutMs ?? schoolConfig.ai.pingTimeoutMs` into its `chat` call. Import `schoolConfig` the way `client.ts` does.

- [ ] **Step 5: Run the adapter tests + typecheck — expect PASS**

Run: `pnpm vitest run src/server/ai && pnpm exec tsc --noEmit`

- [ ] **Step 6: Commit** — `spec-19: every provider request carries a deadline`

### Task 4: `aiJson` / `aiEmbed` accept a signal

**Files:**
- Modify: `src/server/ai/client.ts` (`aiJson` opts `:161-169`, adapter call `:178-188`; `aiEmbed` `:232-249`)
- Modify: `src/server/services/ai/providers.ts` `testProvider` — no change needed (ping default applies).

- [ ] **Step 1: Extend the opts**

```ts
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
```

and in the adapter call inside `withFallback`:

```ts
      {
        model: route.model,
        messages,
        temperature: opts.temperature ?? 0.4,
        maxTokens: opts.maxTokens ?? 4096,
        json: true,
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      },
```

`aiEmbed(texts: string[], options: { signal?: AbortSignal; timeoutMs?: number } = {})` — spread the same two fields into the `embed` request.

- [ ] **Step 2: Typecheck + full AI suite — expect PASS**; **Commit** — `spec-19: aiJson and aiEmbed accept a cancellation signal`

---

# Phase 1 — The worker, controls and progress

### Task 5: Schema + migration

**Files:**
- Modify: `prisma/schema.prisma` (`TranslationRunKind` ~1140, `TranslationRun` ~1325, `TranslationJob` ~1363, `Translation` ~1226)
- Create: `prisma/migrations/20260909090000_translation_background_runs/migration.sql`

- [ ] **Step 1: Edit the schema**

```prisma
enum TranslationRunKind {
  FULL
  SYNC
  SINGLE_ENTITY
  /// Re-translates NEEDS_REVIEW units with the QA finding fed back (spec-19).
  REPAIR
  /// ~5 units across entity kinds, shown beside the source before a full run (spec-19).
  SAMPLE
}
```

`TranslationRun`, after `estimatedUsd`:

```prisma
  /// Set when an admin (or the worker itself) puts the run in the background queue. The worker
  /// claims ONLY runs with this set — a plan without it is a cost-free preview and stays one.
  enqueuedAt       DateTime?
  /// Liveness, distinct from the lease (a lock): written by the keepalive while a batch runs.
  heartbeatAt      DateTime?
  /// Cooperative flags read between batches. An admin pause must survive the claim query, and
  /// `PAUSED` alone cannot carry that — it already means "a bounded slice ended".
  pauseRequested   Boolean              @default(false)
  cancelRequested  Boolean              @default(false)
  /// EWMA of model-translated units per minute (memory hits excluded). Null until measured.
  rateUnitsPerMin  Float?
  /// Batches that reached the model — the ETA is shown only once this is ≥ 2.
  modelBatches     Int                  @default(0)
```

`TranslationJob`, after `attempts`:

```prisma
  /// Lease owner that claimed this job. Lets a runner learn exactly which of a batch it won when
  /// another runner took part of it (Prisma here has no updateManyAndReturn).
  claimedBy  String?
```

`Translation`, after `fromMemory`:

```prisma
  /// REPAIR passes consumed on this row. Reset to 0 by any fresh (non-repair) translation. The
  /// 3-attempt ceiling must persist across repair runs, which is why this is not on the job.
  repairAttempts   Int     @default(0)
```

- [ ] **Step 2: Generate, then hand-edit the migration**

Run: `pnpm prisma migrate dev --create-only --name translation_background_runs`, rename the folder to `20260909090000_translation_background_runs`, and replace its contents with:

```sql
-- spec-19: background translation runs.
--
-- Additive only. `enqueuedAt` is the worker gate: a plan without it is the cost-free preview the
-- admin screen has always had, and the worker never touches it. `pauseRequested`/`cancelRequested`
-- are cooperative — the runner reads them between batches rather than being killed mid-write.
-- `heartbeatAt` is liveness, kept separate from the lease, which is a lock. `rateUnitsPerMin` is an
-- EWMA of per-batch throughput so the ETA cannot flicker to "unknown" on one slow batch.
-- `repairAttempts` sits on Translation, not TranslationJob: a job is per run, and the ceiling has
-- to survive across repair runs or each new run would hand the unit a fresh budget.
--
-- HAND-EDITED (DECISIONS 2026-08-26): Prisma re-proposes, on EVERY migration, drops of the two
-- pgvector HNSW indexes and of the generated-column defaults on MasterItem.searchText and
-- KbChunk.textSearch. Those statements are removed below and must be removed again next time.

-- AlterEnum
ALTER TYPE "TranslationRunKind" ADD VALUE 'REPAIR';
ALTER TYPE "TranslationRunKind" ADD VALUE 'SAMPLE';

-- AlterTable
ALTER TABLE "TranslationRun"
  ADD COLUMN "enqueuedAt" TIMESTAMP(3),
  ADD COLUMN "heartbeatAt" TIMESTAMP(3),
  ADD COLUMN "pauseRequested" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "rateUnitsPerMin" DOUBLE PRECISION,
  ADD COLUMN "modelBatches" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "TranslationJob" ADD COLUMN "claimedBy" TEXT;

-- AlterTable
ALTER TABLE "Translation" ADD COLUMN "repairAttempts" INTEGER NOT NULL DEFAULT 0;
```

- [ ] **Step 3: Apply and verify**

Run: `pnpm prisma migrate deploy && pnpm prisma generate && pnpm vitest run prisma/migrations.test.ts && pnpm exec tsc --noEmit` — all green. (`migrations.test.ts` fails if the HNSW drops slipped through.)

- [ ] **Step 4: Commit** — `spec-19: schema for background runs, cooperative flags and repair budget`

### Task 6: Audit constants, Redis key, env, package script

**Files:**
- Modify: `src/server/audit.ts` (`:48-54`), `src/server/redis.ts` (`keys`), `src/lib/env.ts`, `.env.example`, `package.json`

- [ ] **Step 1: Audit actions** — add after `translationRunFinished`:

```ts
  translationRunEnqueued: "i18n.run_enqueued",
  translationRunPaused: "i18n.run_paused",
  translationRunResumed: "i18n.run_resumed",
  translationRunCancelled: "i18n.run_cancelled",
  translationRunFailed: "i18n.run_failed",
```

- [ ] **Step 2: Redis key** — in `keys`:

```ts
  /** Set by the i18n worker every poll with a 3×poll TTL; the admin board reads it as "online". */
  i18nWorker: () => "tp:i18n:worker",
```

- [ ] **Step 3: Env** — in `envSchema` after `OMNIROUTE_API_KEY`:

```ts
  /** How often the i18n worker looks for an enqueued run when idle (spec-19). */
  I18N_WORKER_POLL_MS: z.coerce.number().int().positive().default(5000),
```

`.env.example` — add a block:

```
# Background translation worker (spec-19) — `pnpm i18n:worker`, or the teoripro-i18n-worker pm2 app
I18N_WORKER_POLL_MS=5000
```

- [ ] **Step 4: package.json** — after `"i18n:import"`: `"i18n:worker": "tsx scripts/i18n-worker.ts",`
- [ ] **Step 5: `pnpm exec tsc --noEmit` — PASS; Commit** — `spec-19: audit actions, worker heartbeat key, poll interval`

### Task 7: `executeRun` — keepalive, exact claim, cooperative stop, orphan recovery, rate

This is the core change. The new function keeps the existing structure and adds the pieces the review demanded. Read `runs.ts:264-509` fully before editing.

**Files:**
- Modify: `src/server/services/i18n/runs.ts`
- Modify: `src/server/services/i18n/translate.ts` (`translateBatch` signature; `storeTranslations` resets `repairAttempts`)
- Modify: `src/server/services/i18n/qa.ts` (`semanticCheck` signal)
- Test: `src/server/services/i18n/runs.integration.test.ts` (new)
- Test: `src/server/services/i18n/run-math.test.ts` (new, pure)

- [ ] **Step 1: Pure helpers + their tests first**

Create `src/server/services/i18n/run-math.ts`:

```ts
/** Spec-19 progress arithmetic, kept pure so the ETA can be tested with fake clocks. */

/**
 * A mid-range rate; the point is order of magnitude, not precision. Lives here (no imports) so
 * runs.ts, run-control.ts, repair.ts and sample.ts can all share it without a cycle — runs.ts
 * must delete its own copy and import this one.
 */
export const ESTIMATED_USD_PER_1K_TOKENS = 0.0006;

const EWMA_WEIGHT = 0.3;

/** Exponentially weighted units-per-minute; null previous means "first observation wins". */
export function ewmaRate(previous: number | null, observed: number): number {
  if (!Number.isFinite(observed) || observed <= 0) return previous ?? 0;
  return previous === null ? observed : EWMA_WEIGHT * observed + (1 - EWMA_WEIGHT) * previous;
}

/** Throughput of one batch: model-translated units over wall time, floored at one second. */
export function batchRate(modelUnits: number, startedAtMs: number, finishedAtMs: number): number {
  const minutes = Math.max(finishedAtMs - startedAtMs, 1000) / 60_000;
  return modelUnits / minutes;
}

/** Seconds until done, or null while there is no trustworthy rate yet. */
export function etaSeconds(
  remaining: number,
  rateUnitsPerMin: number | null,
  modelBatches: number,
): number | null {
  if (remaining <= 0) return 0;
  if (rateUnitsPerMin === null || rateUnitsPerMin <= 0 || modelBatches < 2) return null;
  return Math.round((remaining / rateUnitsPerMin) * 60);
}

/** The lease is 2 min; a heartbeat older than this means the runner is gone, not slow. */
export const HEARTBEAT_STALE_MS = 3 * 60_000;

export function heartbeatStale(heartbeatAt: Date | null, now: Date): boolean {
  return heartbeatAt === null || now.getTime() - heartbeatAt.getTime() > HEARTBEAT_STALE_MS;
}
```

`run-math.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { batchRate, etaSeconds, ewmaRate, heartbeatStale } from "./run-math";

describe("run maths", () => {
  it("first observation seeds the rate, later ones smooth it", () => {
    expect(ewmaRate(null, 10)).toBe(10);
    expect(ewmaRate(10, 20)).toBeCloseTo(13);
    expect(ewmaRate(10, 0)).toBe(10); // a memory-only batch changes nothing
  });
  it("batch rate is units per minute of wall time, never divides by zero", () => {
    expect(batchRate(5, 0, 30_000)).toBe(10);
    expect(batchRate(5, 0, 0)).toBe(300); // floored at one second
  });
  it("eta needs two model batches and a positive rate", () => {
    expect(etaSeconds(100, null, 5)).toBeNull();
    expect(etaSeconds(100, 10, 1)).toBeNull();
    expect(etaSeconds(100, 10, 2)).toBe(600);
    expect(etaSeconds(0, 10, 2)).toBe(0);
  });
  it("a heartbeat older than three minutes is stale; a missing one is stale", () => {
    const now = new Date("2026-09-09T10:00:00Z");
    expect(heartbeatStale(new Date("2026-09-09T09:58:00Z"), now)).toBe(false);
    expect(heartbeatStale(new Date("2026-09-09T09:56:59Z"), now)).toBe(true);
    expect(heartbeatStale(null, now)).toBe(true);
  });
});
```

Run: `pnpm vitest run src/server/services/i18n/run-math.test.ts` — PASS. Commit — `spec-19: rate and eta arithmetic`.

- [ ] **Step 2: Signal plumbing in `translate.ts` and `qa.ts`**

`translateBatch(db, language, units, options: { signal?: AbortSignal } = {})` — pass `...(options.signal ? { signal: options.signal } : {})` into the `aiJson` call (`:177-199`) and into `semanticCheck({ locale, languageName, units: qaInputs, ...(options.signal ? { signal: options.signal } : {}) })`.

`qa.ts` `semanticCheck(input: { locale; languageName; units; signal?: AbortSignal })` — pass the signal into `aiJson` (`:120`) and `aiEmbed(texts, { signal })` (`:194`); in **both** catch blocks that produce `QA_UNAVAILABLE` (`:134-148`, `:195-209`) add first:

```ts
      // A shutdown must not be recorded as a QA verdict on a translation that was fine.
      if (input.signal?.aborted) throw error;
```

`storeTranslations` — add `repairAttempts: 0` to both the `create` and `update` data objects (a fresh translation is a fresh repair budget).

- [ ] **Step 3: Write the failing integration test**

`runs.integration.test.ts` — mocks the gateway (pattern from `src/server/services/pipeline/validators.test.ts`), builds a language with a few `TOPIC` units, and drives `executeRun`:

```ts
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/server/authz";
import { db } from "@/server/db";
import { redis } from "@/server/redis";

const aiJson = vi.fn();
const aiEmbed = vi.fn();
vi.mock("@/server/ai/client", () => ({
  aiJson: (...args: unknown[]) => aiJson(...args),
  aiEmbed: (...args: unknown[]) => aiEmbed(...args),
}));

const { executeRun, planRun, progressOf } = await import("./runs");
const { createLanguage } = await import("./languages");

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const d = describe.skipIf(!enabled);
const RUN = randomBytes(3).toString("hex");
const CODE = `zr-${RUN}`.slice(0, 8);
const actor: SessionUser = { id: "", role: "ADMIN", email: `run-${RUN}@example.no` };
const topicIds: string[] = [];

/** The model echoes each unit's English with a marker so we can tell fresh output from memory. */
function modelAnswers() {
  aiJson.mockImplementation(async (opts: { vars: { unitsJson: string } }) => {
    const items = JSON.parse(opts.vars.unitsJson) as Array<{ id: string; en: { name: string } }>;
    return {
      data: { units: items.map((u) => ({ id: u.id, value: { name: `[${CODE}] ${u.en.name}` } })) },
      modelVersion: "stub", promptVersion: "translation.units@1.0.0",
      usage: { promptTokens: 40 * items.length, completionTokens: 20 * items.length },
      providerLabel: "stub",
    };
  });
  aiEmbed.mockImplementation(async (texts: string[]) => texts.map(() => [1, 0, 0]));
}

beforeAll(async () => {
  if (!enabled) return;
  const user = await db.user.create({ data: { email: actor.email, role: "ADMIN", emailVerifiedAt: new Date(), profile: { create: { firstName: "Run", lastName: RUN } } }, select: { id: true } });
  actor.id = user.id;
  await createLanguage(db, actor, { code: CODE, englishName: "Runic", nativeName: "Runic", shortLabel: "ZR", direction: "LTR", requiresApproval: false });
  for (let i = 0; i < 7; i++) {
    const topic = await db.topic.create({ data: { slug: `zr-${RUN}-${i}`, name: { en: `Topic ${i}`, nb: `Emne ${i}` }, sortOrder: 900 + i }, select: { id: true } });
    topicIds.push(topic.id);
  }
});

afterAll(async () => {
  if (!enabled) return;
  await db.translation.deleteMany({ where: { locale: CODE } });
  await db.translationMemory.deleteMany({ where: { locale: CODE } });
  await db.translationJob.deleteMany({ where: { run: { locale: CODE } } });
  await db.translationRun.deleteMany({ where: { locale: CODE } });
  await db.language.deleteMany({ where: { code: CODE } });
  await db.topic.deleteMany({ where: { id: { in: topicIds } } });
  await db.auditLog.deleteMany({ where: { actorId: actor.id } });
  await db.user.deleteMany({ where: { id: actor.id } });
  await db.$disconnect();
  await redis.quit().catch(() => undefined);
});

beforeEach(() => { aiJson.mockReset(); aiEmbed.mockReset(); modelAnswers(); });

async function planTopics() {
  return planRun(db, CODE, { kind: "SINGLE_ENTITY", only: ["TOPIC"], startedById: actor.id });
}

d("executeRun (spec-19)", () => {
  it("re-queues jobs a crashed runner left RUNNING, and completion waits for them", async () => {
    const plan = await planTopics();
    // Simulate a crash mid-batch: two jobs RUNNING, lease lapsed.
    const jobs = await db.translationJob.findMany({ where: { runId: plan.runId }, take: 2, select: { id: true } });
    await db.translationJob.updateMany({ where: { id: { in: jobs.map((j) => j.id) } }, data: { state: "RUNNING", claimedBy: "dead-runner" } });
    await db.translationRun.update({ where: { id: plan.runId }, data: { status: "RUNNING", leaseOwner: "dead-runner", leaseExpiresAt: new Date(Date.now() - 60_000) } });

    const progress = await executeRun(db, plan.runId, { leaseOwner: `t-${randomUUID().slice(0, 6)}` });
    expect(progress.done).toBe(true);
    const states = await db.translationJob.groupBy({ by: ["state"], where: { runId: plan.runId }, _count: true });
    expect(states.find((s) => s.state === "RUNNING")).toBeUndefined();
    expect(states.find((s) => s.state === "DONE")?._count).toBe(plan.plannedUnits);
    await db.translation.deleteMany({ where: { locale: CODE } });
  });

  it("stops after the current batch when cancel is requested, and skips the rest", async () => {
    const plan = await planTopics();
    aiJson.mockImplementationOnce(async (opts: { vars: { unitsJson: string } }) => {
      await db.translationRun.update({ where: { id: plan.runId }, data: { cancelRequested: true } });
      const items = JSON.parse(opts.vars.unitsJson) as Array<{ id: string; en: { name: string } }>;
      return { data: { units: items.map((u) => ({ id: u.id, value: { name: `[${CODE}] ${u.en.name}` } })) }, modelVersion: "stub", promptVersion: "p", usage: { promptTokens: 1, completionTokens: 1 }, providerLabel: "stub" };
    });
    const progress = await executeRun(db, plan.runId, { leaseOwner: "t-cancel" });
    expect(progress.status).toBe("CANCELLED");
    expect(progress.stopReason).toBe("cancelled");
    const run = await db.translationRun.findUniqueOrThrow({ where: { id: plan.runId }, select: { leaseOwner: true, finishedAt: true } });
    expect(run.leaseOwner).toBeNull();
    expect(run.finishedAt).not.toBeNull();
    expect(await db.translationJob.count({ where: { runId: plan.runId, state: "QUEUED" } })).toBe(0);
    expect(await db.translationJob.count({ where: { runId: plan.runId, state: "SKIPPED", error: "cancelled" } })).toBeGreaterThan(0);
    await db.translation.deleteMany({ where: { locale: CODE } });
  });

  it("pauses cooperatively and is not re-claimable while paused", async () => {
    const plan = await planTopics();
    aiJson.mockImplementationOnce(async (opts: { vars: { unitsJson: string } }) => {
      await db.translationRun.update({ where: { id: plan.runId }, data: { pauseRequested: true } });
      const items = JSON.parse(opts.vars.unitsJson) as Array<{ id: string; en: { name: string } }>;
      return { data: { units: items.map((u) => ({ id: u.id, value: { name: `[${CODE}] ${u.en.name}` } })) }, modelVersion: "stub", promptVersion: "p", usage: { promptTokens: 1, completionTokens: 1 }, providerLabel: "stub" };
    });
    const first = await executeRun(db, plan.runId, { leaseOwner: "t-pause" });
    expect(first.status).toBe("PAUSED");
    expect(first.stopReason).toBe("paused");
    const again = await executeRun(db, plan.runId, { leaseOwner: "t-other" });
    expect(again.stopReason).toBe("notClaimed");
    await db.translationRun.update({ where: { id: plan.runId }, data: { pauseRequested: false } });
    const resumed = await executeRun(db, plan.runId, { leaseOwner: "t-resume" });
    expect(resumed.done).toBe(true);
    await db.translation.deleteMany({ where: { locale: CODE } });
  });

  it("an aborted signal returns the batch to the queue without charging an attempt", async () => {
    const plan = await planTopics();
    const controller = new AbortController();
    aiJson.mockImplementationOnce(async () => {
      controller.abort();
      const { ProviderError } = await import("@/server/ai/providers");
      throw new ProviderError("request aborted", 499, true);
    });
    const progress = await executeRun(db, plan.runId, { leaseOwner: "t-abort", signal: controller.signal });
    expect(progress.stopReason).toBe("aborted");
    expect(progress.status).toBe("PAUSED");
    const jobs = await db.translationJob.findMany({ where: { runId: plan.runId }, select: { state: true, attempts: true } });
    expect(jobs.every((j) => j.state === "QUEUED" && j.attempts === 0)).toBe(true);
  });

  it("writes a heartbeat and a rate, and refuses a second run for the same locale", async () => {
    const plan = await planTopics();
    const other = await planTopics();
    await db.translationRun.update({ where: { id: other.runId }, data: { status: "RUNNING", leaseOwner: "busy", leaseExpiresAt: new Date(Date.now() + 60_000) } });
    const blocked = await executeRun(db, plan.runId, { leaseOwner: "t-second" });
    expect(blocked.stopReason).toBe("localeBusy");
    await db.translationRun.update({ where: { id: other.runId }, data: { status: "CANCELLED", leaseOwner: null, leaseExpiresAt: null } });
    const done = await executeRun(db, plan.runId, { leaseOwner: "t-rate" });
    expect(done.done).toBe(true);
    const run = await db.translationRun.findUniqueOrThrow({ where: { id: plan.runId }, select: { heartbeatAt: true, rateUnitsPerMin: true, modelBatches: true, startedAt: true } });
    expect(run.heartbeatAt).not.toBeNull();
    expect(run.modelBatches).toBeGreaterThan(0);
    expect(run.rateUnitsPerMin).toBeGreaterThan(0);
    expect(await progressOf(db, plan.runId)).toMatchObject({ done: true });
  });
});
```

(Adjust the `Topic` create to the real required columns — check `prisma/schema.prisma` `model Topic`; the integration test in `languages.integration.test.ts:220-255` shows how a topic fixture is made there.)

- [ ] **Step 4: Run — expect FAIL** (`stopReason` undefined, `claimedBy` untouched, etc.)

- [ ] **Step 5: Rewrite `executeRun`**

Replace `RunProgress` and `executeRun` (`runs.ts:246-457` region) with:

```ts
export type StopReason =
  | "finished"
  | "budget"
  | "paused"
  | "cancelled"
  | "aborted"
  | "lostLease"
  | "notClaimed"
  | "localeBusy";

export interface RunProgress {
  runId: string;
  status: string;
  planned: number;
  completed: number;
  failed: number;
  flagged: number;
  memoryHits: number;
  done: boolean;
  stopReason: StopReason;
}

/** Lease keepalive cadence: a quarter of the lease, so three missed ticks still hold it. */
const KEEPALIVE_MS = (LEASE_MINUTES * 60_000) / 4;

function leaseUntil(from = Date.now()): Date {
  return new Date(from + LEASE_MINUTES * 60_000);
}

export async function executeRun(
  db: PrismaClient,
  runId: string,
  options: {
    leaseOwner: string;
    maxUnits?: number;
    onProgress?: (progress: RunProgress) => void;
    /** Worker shutdown. Checked between batches and threaded into every provider call. */
    signal?: AbortSignal;
  },
): Promise<RunProgress> {
  const now = new Date();
  const run = await db.translationRun.findUniqueOrThrow({
    where: { id: runId },
    select: { id: true, locale: true, kind: true, status: true, startedAt: true },
  });

  // One live run per locale, whatever the entry point (worker, admin slice, CLI). Two runs
  // planned for the same language each hold a job per unit, and would translate them twice.
  // Index: TranslationRun[locale, status, createdAt].
  const busy = await db.translationRun.findFirst({
    where: { locale: run.locale, id: { not: runId }, status: "RUNNING", leaseExpiresAt: { gt: now } },
    select: { id: true },
  });
  if (busy) return { ...(await progressOf(db, runId)), stopReason: "localeBusy" };

  // Index: TranslationRun[status, leaseExpiresAt].
  const claimed = await db.translationRun.updateMany({
    where: {
      id: runId,
      status: { in: ["PENDING", "PAUSED", "RUNNING"] },
      pauseRequested: false,
      cancelRequested: false,
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
    },
    data: {
      status: "RUNNING",
      leaseOwner: options.leaseOwner,
      leaseExpiresAt: leaseUntil(now.getTime()),
      heartbeatAt: now,
      ...(run.startedAt ? {} : { startedAt: now }),
    },
  });
  if (claimed.count !== 1) {
    // Someone else is on it, or an admin asked for a pause. Not an error — report where it is.
    return { ...(await progressOf(db, runId)), stopReason: "notClaimed" };
  }

  // The lease is exclusive from here. Anything a dead runner left RUNNING goes back to the queue —
  // attempts are kept, so a unit that keeps killing its runner still reaches SKIPPED.
  await db.translationJob.updateMany({
    where: { runId, state: "RUNNING" },
    data: { state: "QUEUED", startedAt: null, claimedBy: null },
  });

  const language = await languagePolicy(db, run.locale);
  const budget = options.maxUnits ?? Number.POSITIVE_INFINITY;
  const translatedMasterIds: string[] = [];
  let processed = 0;
  let lostLease = false;
  let stopReason: StopReason = "finished";

  // Keepalive IS the heartbeat: a batch on the slow self-hosted model routinely outlives a 2-minute
  // lease, and the lease used to be extended only after a batch. Owner-guarded, so a runner that
  // has already lost the lease learns it here instead of overwriting the new owner's state.
  const keepalive = setInterval(() => {
    void db.translationRun
      .updateMany({
        where: { id: runId, leaseOwner: options.leaseOwner },
        data: { leaseExpiresAt: leaseUntil(), heartbeatAt: new Date() },
      })
      .then((result) => {
        if (result.count === 0) lostLease = true;
      })
      .catch((error: unknown) => logger.warn({ error, runId }, "lease keepalive failed"));
  }, KEEPALIVE_MS);

  try {
    for (;;) {
      if (lostLease) { stopReason = "lostLease"; break; }
      if (options.signal?.aborted) { stopReason = "aborted"; break; }
      if (processed >= budget) { stopReason = "budget"; break; }

      const flags = await db.translationRun.findUniqueOrThrow({
        where: { id: runId },
        select: { pauseRequested: true, cancelRequested: true },
      });
      if (flags.cancelRequested) { stopReason = "cancelled"; break; }
      if (flags.pauseRequested) { stopReason = "paused"; break; }

      // A batch that failed on a provider outage is worth another go; one that has failed three
      // times is a real problem with that unit, and is left alone so the run can finish.
      await db.translationJob.updateMany({
        where: { runId, state: "FAILED", attempts: { lt: MAX_ATTEMPTS } },
        data: { state: "QUEUED", error: null },
      });
      await db.translationJob.updateMany({
        where: { runId, state: "FAILED", attempts: { gte: MAX_ATTEMPTS } },
        data: { state: "SKIPPED" },
      });

      // One entity kind at a time, so a batch shares a prompt shape. Index: TranslationJob[runId, state, entity].
      const jobs = await db.translationJob.findMany({
        where: { runId, state: "QUEUED" },
        orderBy: [{ entity: "asc" }, { id: "asc" }],
        take: Math.min(BATCH_SIZE, budget - processed),
        select: { id: true, entity: true, entityId: true },
      });
      if (jobs.length === 0) { stopReason = "finished"; break; }

      const entity = jobs[0].entity;
      const wanted = jobs.filter((job) => job.entity === entity).map((job) => job.id);
      await db.translationJob.updateMany({
        where: { id: { in: wanted }, state: "QUEUED" },
        data: { state: "RUNNING", startedAt: new Date(), attempts: { increment: 1 }, claimedBy: options.leaseOwner },
      });
      // Exactly what THIS runner won — another runner may have taken part of the batch.
      const batch = await db.translationJob.findMany({
        where: { id: { in: wanted }, state: "RUNNING", claimedBy: options.leaseOwner },
        select: { id: true, entity: true, entityId: true },
      });
      if (batch.length === 0) continue;

      // Re-extract just this slice, so the source is read fresh rather than trusted from plan time.
      const units = await unitsFor(db, language, entity, batch.map((job) => job.entityId));
      const batchStarted = Date.now();

      try {
        const outcome =
          run.kind === "REPAIR"
            ? await repairSlice(db, run.locale, language, units, runId, options.signal)
            : await translateSlice(db, run.locale, language, units, runId, options.signal);
        const { translated, superseded } = outcome;

        const flagged = translated.filter((item) => item.status !== "MACHINE").length;
        const memoryHits = translated.filter((item) => item.fromMemory).length;
        const promptTokens = translated.reduce((sum, item) => sum + item.promptTokens, 0);
        const completionTokens = translated.reduce((sum, item) => sum + item.completionTokens, 0);
        if (entity === "MASTER_ITEM") translatedMasterIds.push(...translated.map((item) => item.unit.entityId));

        const doneIds = new Set(translated.map((item) => item.unit.entityId).filter((id) => !superseded.has(id)));
        await db.translationJob.updateMany({
          where: { runId, entityId: { in: [...doneIds] }, state: "RUNNING", claimedBy: options.leaseOwner },
          data: { state: "DONE", finishedAt: new Date() },
        });
        if (superseded.size > 0) {
          await db.translationJob.updateMany({
            where: { runId, entityId: { in: [...superseded] }, state: "RUNNING", claimedBy: options.leaseOwner },
            data: { state: "SKIPPED", error: "superseded", finishedAt: new Date() },
          });
        }
        // Anything the model silently dropped stays FAILED rather than vanishing.
        await db.translationJob.updateMany({
          where: { runId, id: { in: batch.map((job) => job.id) }, state: "RUNNING" },
          data: { state: "FAILED", error: "no translation returned", finishedAt: new Date() },
        });

        const modelUnits = translated.length - memoryHits;
        const previous = await db.translationRun.findUniqueOrThrow({
          where: { id: runId },
          select: { rateUnitsPerMin: true },
        });
        const updated = await db.translationRun.updateMany({
          where: { id: runId, leaseOwner: options.leaseOwner },
          data: {
            translatedUnits: { increment: translated.length },
            flaggedUnits: { increment: flagged },
            memoryHits: { increment: memoryHits },
            promptTokens: { increment: promptTokens },
            completionTokens: { increment: completionTokens },
            leaseExpiresAt: leaseUntil(),
            heartbeatAt: new Date(),
            ...(modelUnits > 0
              ? {
                  rateUnitsPerMin: ewmaRate(previous.rateUnitsPerMin, batchRate(modelUnits, batchStarted, Date.now())),
                  modelBatches: { increment: 1 },
                }
              : {}),
          },
        });
        if (updated.count === 0) lostLease = true;
        processed += batch.length;
      } catch (error) {
        if (options.signal?.aborted) {
          // A deploy is not the unit's fault: hand the batch back without charging an attempt.
          await db.translationJob.updateMany({
            where: { runId, id: { in: batch.map((job) => job.id) }, state: "RUNNING", claimedBy: options.leaseOwner },
            data: { state: "QUEUED", startedAt: null, claimedBy: null, attempts: { decrement: 1 } },
          });
          stopReason = "aborted";
          break;
        }
        // One bad batch must not end a run of three thousand. Record it and carry on.
        logger.error({ error, runId, entity }, "translation batch failed");
        await db.translationJob.updateMany({
          where: { runId, id: { in: batch.map((job) => job.id) }, state: "RUNNING", claimedBy: options.leaseOwner },
          data: { state: "FAILED", error: error instanceof Error ? error.message.slice(0, 300) : "unknown", finishedAt: new Date() },
        });
        const updated = await db.translationRun.updateMany({
          where: { id: runId, leaseOwner: options.leaseOwner },
          data: { failedUnits: { increment: batch.length }, leaseExpiresAt: leaseUntil(), heartbeatAt: new Date() },
        });
        if (updated.count === 0) lostLease = true;
        processed += batch.length;
      }

      options.onProgress?.({ ...(await progressOf(db, runId)), stopReason });
    }
  } finally {
    clearInterval(keepalive);
  }

  if (stopReason === "lostLease") {
    logger.warn({ runId, leaseOwner: options.leaseOwner }, "lost the lease — leaving the run to its new owner");
    return { ...(await progressOf(db, runId)), stopReason };
  }

  // Push approved question translations out to the variants students are served.
  if (translatedMasterIds.length > 0) await deriveVariantTranslations(db, run.locale, translatedMasterIds);
  await invalidateMessages(run.locale);

  const release = { leaseOwner: null, leaseExpiresAt: null };
  if (stopReason === "cancelled") {
    await db.translationJob.updateMany({
      where: { runId, state: { in: ["QUEUED", "RUNNING"] } },
      data: { state: "SKIPPED", error: "cancelled", finishedAt: new Date() },
    });
    await db.translationRun.updateMany({
      where: { id: runId, leaseOwner: options.leaseOwner },
      data: { status: "CANCELLED", finishedAt: new Date(), cancelRequested: false, ...release },
    });
    return { ...(await progressOf(db, runId)), stopReason };
  }

  // Index: TranslationJob[runId, state, entity].
  const remaining = await db.translationJob.count({ where: { runId, state: { in: ["QUEUED", "RUNNING"] } } });
  if (remaining === 0) {
    await db.translationRun.updateMany({
      where: { id: runId, leaseOwner: options.leaseOwner },
      data: { status: "COMPLETED", finishedAt: new Date(), ...release },
    });
    if (run.kind === "SYNC" || run.kind === "FULL") {
      await db.language.update({ where: { code: run.locale }, data: { lastSyncedAt: new Date() }, select: { code: true } });
    }
    if (run.kind !== "SAMPLE") {
      await auditLog({ actorId: null, action: AUDIT.translationRunFinished, entityType: "TranslationRun", entityId: runId, meta: { locale: run.locale, kind: run.kind } });
    }
    return { ...(await progressOf(db, runId)), stopReason: "finished" };
  }

  await db.translationRun.updateMany({
    where: { id: runId, leaseOwner: options.leaseOwner },
    data: { status: "PAUSED", pauseRequested: false, ...release },
  });
  return { ...(await progressOf(db, runId)), stopReason };
}

interface SliceOutcome {
  translated: TranslatedUnit[];
  /** Units whose row was approved/edited/re-sourced while the batch ran; never overwritten. */
  superseded: Set<string>;
}

async function translateSlice(
  db: PrismaClient,
  locale: string,
  language: LanguagePolicy,
  units: TranslationUnit[],
  runId: string,
  signal: AbortSignal | undefined,
): Promise<SliceOutcome> {
  const translated = await translateBatch(db, language, units, signal ? { signal } : {});
  await storeTranslations(db, locale, translated, runId);
  return { translated, superseded: new Set() };
}

// `repairSlice` is added in Task 16; until then it is a stub that throws so a REPAIR run cannot
// silently take the normal path.
async function repairSlice(
  _db: PrismaClient, _locale: string, _language: LanguagePolicy, _units: TranslationUnit[], _runId: string, _signal: AbortSignal | undefined,
): Promise<SliceOutcome> {
  throw new Error("REPAIR runs land in Phase 2 (Task 16)");
}
```

`progressOf` — count `remaining` as `state: { in: ["QUEUED", "RUNNING"] }` and return `stopReason: "finished"` as a default field (callers spread over it). Add the imports: `ewmaRate, batchRate` from `./run-math`; `TranslatedUnit`, `LanguagePolicy` from `./translate`.

`planRun` — add `enqueue?: boolean` to `input`; when true set `enqueuedAt: new Date()` in the `create` and, before creating, supersede stale previews:

```ts
  if (input.enqueue) {
    // At most one live plan per locale: an old cost-free preview must not be executable later
    // against a bank that has since changed.
    await db.translationRun.updateMany({
      where: { locale, status: "PENDING", enqueuedAt: null },
      data: { status: "CANCELLED", error: "superseded", finishedAt: new Date() },
    });
  }
```

- [ ] **Step 6: Run the integration test + the whole i18n suite — expect PASS**

Run: `pnpm vitest run src/server/services/i18n && pnpm exec tsc --noEmit`

- [ ] **Step 7: Commit** — `spec-19: executeRun keeps its lease alive, recovers orphans, stops cooperatively`

### Task 8: Run control service

**Files:**
- Create: `src/server/services/i18n/run-control.ts`
- Test: `src/server/services/i18n/run-control.integration.test.ts`

- [ ] **Step 1: Write the failing test** (same fixture skeleton as Task 7's test — copy the `beforeAll`/`afterAll`; no AI mock needed)

```ts
d("run control (spec-19)", () => {
  it("startBackgroundRun plans, enqueues, supersedes stale previews and refuses a second live run", async () => {
    const preview = await planRun(db, CODE, { kind: "SINGLE_ENTITY", only: ["TOPIC"] });
    const started = await startBackgroundRun(db, actor, { locale: CODE, only: ["TOPIC"] });
    const stale = await db.translationRun.findUniqueOrThrow({ where: { id: preview.runId }, select: { status: true, error: true } });
    expect(stale).toEqual({ status: "CANCELLED", error: "superseded" });
    const live = await db.translationRun.findUniqueOrThrow({ where: { id: started.runId }, select: { enqueuedAt: true, status: true } });
    expect(live.enqueuedAt).not.toBeNull();
    expect(live.status).toBe("PENDING");
    await expect(startBackgroundRun(db, actor, { locale: CODE })).rejects.toThrow(ConflictError);
    await requestCancel(db, actor, started.runId);
  });

  it("pause / resume / cancel flip the flags and audit", async () => {
    const started = await startBackgroundRun(db, actor, { locale: CODE, only: ["TOPIC"] });
    await db.translationRun.update({ where: { id: started.runId }, data: { status: "RUNNING" } });
    await requestPause(db, actor, started.runId);
    expect((await db.translationRun.findUniqueOrThrow({ where: { id: started.runId } })).pauseRequested).toBe(true);
    await db.translationRun.update({ where: { id: started.runId }, data: { status: "PAUSED" } });
    await resumeRun(db, actor, started.runId);
    expect((await db.translationRun.findUniqueOrThrow({ where: { id: started.runId } })).pauseRequested).toBe(false);
    await requestCancel(db, actor, started.runId);
    // A run nobody is executing is finalised immediately.
    expect((await db.translationRun.findUniqueOrThrow({ where: { id: started.runId } })).status).toBe("CANCELLED");
    const audits = await db.auditLog.findMany({ where: { actorId: actor.id, entityId: started.runId }, select: { action: true } });
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(["i18n.run_enqueued", "i18n.run_paused", "i18n.run_resumed", "i18n.run_cancelled"]));
  });

  it("runDetail reports counts, per-entity states, stale heartbeat and eta", async () => {
    const started = await startBackgroundRun(db, actor, { locale: CODE, only: ["TOPIC"] });
    await db.translationRun.update({ where: { id: started.runId }, data: { status: "RUNNING", heartbeatAt: new Date(Date.now() - 10 * 60_000), rateUnitsPerMin: 10, modelBatches: 2, translatedUnits: 2 } });
    const detail = await runDetail(db, started.runId);
    expect(detail.stale).toBe(true);
    expect(detail.byEntity.find((e) => e.entity === "TOPIC")?.queued).toBe(started.plannedUnits);
    expect(detail.etaSeconds).toBe(Math.round((started.plannedUnits / 10) * 60));
    expect(detail.spentUsd).toBe(0);
    await requestCancel(db, actor, started.runId);
  });
});
```

- [ ] **Step 2: Run — FAIL** (module missing)

- [ ] **Step 3: Implement `run-control.ts`**

```ts
import type { PrismaClient, TranslatableEntity, TranslationRunKind } from "@prisma/client";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { AUDIT, auditLog } from "@/server/audit";
import type { SessionUser } from "@/server/authz";
import { ESTIMATED_USD_PER_1K_TOKENS, etaSeconds, heartbeatStale } from "./run-math";
import { planRun, type RunPlan } from "./runs";

/**
 * Spec-19: what an admin can do to a background run, and what the progress panel reads.
 * The worker never calls the mutations here; it reads the flags they set.
 */

const LIVE: TranslationRunKind[] = ["FULL", "SYNC", "SINGLE_ENTITY", "REPAIR"];

export async function startBackgroundRun(
  db: PrismaClient,
  actor: SessionUser,
  input: { locale: string; only?: TranslatableEntity[]; kind?: TranslationRunKind },
): Promise<RunPlan> {
  // Index: TranslationRun[locale, status, createdAt].
  const live = await db.translationRun.findFirst({
    where: { locale: input.locale, enqueuedAt: { not: null }, status: { in: ["PENDING", "RUNNING", "PAUSED"] }, kind: { in: LIVE } },
    select: { id: true },
  });
  if (live) throw new ConflictError({ locale: input.locale, runId: live.id }, "admin.languages.errors.runActive");

  const plan = await planRun(db, input.locale, {
    kind: input.kind ?? (input.only ? "SINGLE_ENTITY" : "SYNC"),
    ...(input.only ? { only: input.only } : {}),
    startedById: actor.id,
    enqueue: true,
  });
  await auditLog({ actorId: actor.id, action: AUDIT.translationRunEnqueued, entityType: "TranslationRun", entityId: plan.runId, meta: { locale: input.locale, planned: plan.plannedUnits } });
  return plan;
}

export async function requestPause(db: PrismaClient, actor: SessionUser, runId: string): Promise<void> {
  const changed = await db.translationRun.updateMany({ where: { id: runId, status: "RUNNING" }, data: { pauseRequested: true } });
  if (changed.count === 0) throw new ConflictError({ runId }, "admin.languages.errors.runNotRunning");
  await auditLog({ actorId: actor.id, action: AUDIT.translationRunPaused, entityType: "TranslationRun", entityId: runId });
}

export async function resumeRun(db: PrismaClient, actor: SessionUser, runId: string): Promise<void> {
  const run = await db.translationRun.findUnique({ where: { id: runId }, select: { status: true, enqueuedAt: true, pauseRequested: true } });
  if (!run) throw new NotFoundError({ runId });
  if (run.status !== "PAUSED" && !(run.status === "RUNNING" && run.pauseRequested)) throw new ConflictError({ runId }, "admin.languages.errors.runNotPaused");
  await db.translationRun.update({ where: { id: runId }, data: { pauseRequested: false, enqueuedAt: run.enqueuedAt ?? new Date() }, select: { id: true } });
  await auditLog({ actorId: actor.id, action: AUDIT.translationRunResumed, entityType: "TranslationRun", entityId: runId });
}

export async function requestCancel(db: PrismaClient, actor: SessionUser, runId: string): Promise<void> {
  const run = await db.translationRun.findUnique({ where: { id: runId }, select: { status: true, leaseExpiresAt: true } });
  if (!run) throw new NotFoundError({ runId });
  if (!["PENDING", "RUNNING", "PAUSED"].includes(run.status)) throw new ConflictError({ runId }, "admin.languages.errors.runFinished");
  const runnerAlive = run.status === "RUNNING" && run.leaseExpiresAt !== null && run.leaseExpiresAt > new Date();
  if (runnerAlive) {
    // The runner finalises at its next batch boundary (executeRun's cancelled branch).
    await db.translationRun.update({ where: { id: runId }, data: { cancelRequested: true }, select: { id: true } });
  } else {
    await db.translationJob.updateMany({ where: { runId, state: { in: ["QUEUED", "RUNNING"] } }, data: { state: "SKIPPED", error: "cancelled", finishedAt: new Date() } });
    await db.translationRun.update({ where: { id: runId }, data: { status: "CANCELLED", finishedAt: new Date(), leaseOwner: null, leaseExpiresAt: null, pauseRequested: false, cancelRequested: false }, select: { id: true } });
  }
  await auditLog({ actorId: actor.id, action: AUDIT.translationRunCancelled, entityType: "TranslationRun", entityId: runId, meta: { immediate: !runnerAlive } });
}

export interface EntityProgress {
  entity: TranslatableEntity;
  queued: number;
  running: number;
  done: number;
  failed: number;
  skipped: number;
}

/** Everything the progress panel shows. Dates are ISO strings: it crosses the RSC boundary every 3 s. */
export interface RunDetail {
  runId: string;
  locale: string;
  kind: TranslationRunKind;
  status: string;
  planned: number;
  completed: number;
  failed: number;
  flagged: number;
  memoryHits: number;
  remaining: number;
  done: boolean;
  promptTokens: number;
  completionTokens: number;
  estimatedUsd: number;
  /** At the estimate's rate — the run has no real price data. */
  spentUsd: number;
  rateUnitsPerMin: number | null;
  modelBatches: number;
  etaSeconds: number | null;
  heartbeatAt: string | null;
  stale: boolean;
  enqueuedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  pauseRequested: boolean;
  cancelRequested: boolean;
  error: string | null;
  byEntity: EntityProgress[];
}

export async function runDetail(db: PrismaClient, runId: string): Promise<RunDetail> {
  const run = await db.translationRun.findUnique({
    where: { id: runId },
    select: {
      id: true, locale: true, kind: true, status: true, plannedUnits: true, translatedUnits: true, failedUnits: true, flaggedUnits: true, memoryHits: true,
      promptTokens: true, completionTokens: true, estimatedUsd: true, rateUnitsPerMin: true, modelBatches: true, heartbeatAt: true, enqueuedAt: true, startedAt: true, finishedAt: true,
      pauseRequested: true, cancelRequested: true, error: true,
    },
  });
  if (!run) throw new NotFoundError({ runId });

  // Index: TranslationJob[runId, state, entity].
  const grouped = await db.translationJob.groupBy({ by: ["entity", "state"], where: { runId }, _count: { _all: true } });
  const byEntity = new Map<TranslatableEntity, EntityProgress>();
  for (const row of grouped) {
    const bucket = byEntity.get(row.entity) ?? { entity: row.entity, queued: 0, running: 0, done: 0, failed: 0, skipped: 0 };
    const key = row.state.toLowerCase() as "queued" | "running" | "done" | "failed" | "skipped";
    bucket[key] += row._count._all;
    byEntity.set(row.entity, bucket);
  }
  const entities = [...byEntity.values()].sort((a, b) => a.entity.localeCompare(b.entity));
  const remaining = entities.reduce((sum, e) => sum + e.queued + e.running, 0);
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  const now = new Date();

  return {
    runId: run.id, locale: run.locale, kind: run.kind, status: run.status,
    planned: run.plannedUnits, completed: run.translatedUnits, failed: run.failedUnits, flagged: run.flaggedUnits, memoryHits: run.memoryHits,
    remaining, done: remaining === 0,
    promptTokens: run.promptTokens, completionTokens: run.completionTokens, estimatedUsd: run.estimatedUsd,
    spentUsd: ((run.promptTokens + run.completionTokens) / 1000) * ESTIMATED_USD_PER_1K_TOKENS,
    rateUnitsPerMin: run.rateUnitsPerMin, modelBatches: run.modelBatches,
    etaSeconds: etaSeconds(remaining, run.rateUnitsPerMin, run.modelBatches),
    heartbeatAt: iso(run.heartbeatAt),
    stale: run.status === "RUNNING" && heartbeatStale(run.heartbeatAt, now),
    enqueuedAt: iso(run.enqueuedAt), startedAt: iso(run.startedAt), finishedAt: iso(run.finishedAt),
    pauseRequested: run.pauseRequested, cancelRequested: run.cancelRequested, error: run.error,
    byEntity: entities,
  };
}

/** The run the language card should show: the newest background run that is not a sample. */
export async function latestRunFor(db: PrismaClient, locale: string): Promise<RunDetail | null> {
  // Index: TranslationRun[locale, status, createdAt] — the leading column; rows per locale are few.
  const run = await db.translationRun.findFirst({
    where: { locale, enqueuedAt: { not: null }, kind: { not: "SAMPLE" } },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  return run ? runDetail(db, run.id) : null;
}
```

- [ ] **Step 4: Run — PASS. Commit** — `spec-19: run control — enqueue, pause, resume, cancel, detail`

### Task 9: The worker service (pure)

**Files:**
- Create: `src/server/services/i18n/worker.ts`
- Test: `src/server/services/i18n/worker.test.ts` (unit, stubbed db — no Postgres)

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it, vi } from "vitest";
import { backoffMs, runWorker, workerTick, type WorkerDeps } from "./worker";

type Stub = { translationRun: { findFirst: ReturnType<typeof vi.fn>; findUniqueOrThrow: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> } };

function deps(overrides: Partial<WorkerDeps> & { db: Stub }): WorkerDeps {
  return {
    leaseOwner: "worker-test",
    pollMs: 10,
    signal: new AbortController().signal,
    heartbeat: vi.fn(async () => undefined),
    execute: vi.fn(async () => ({ runId: "r1", status: "COMPLETED", stopReason: "finished", planned: 1, completed: 1, failed: 0, flagged: 0, memoryHits: 0, done: true })),
    afterRun: vi.fn(async () => undefined),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
    db: overrides.db as unknown as WorkerDeps["db"],
  };
}

describe("backoff", () => {
  it("doubles per consecutive failure and caps at five minutes", () => {
    expect(backoffMs(5000, 0)).toBe(5000);
    expect(backoffMs(5000, 1)).toBe(10_000);
    expect(backoffMs(5000, 3)).toBe(40_000);
    expect(backoffMs(5000, 20)).toBe(300_000);
  });
});

describe("workerTick", () => {
  it("is idle when nothing is enqueued, and still heartbeats", async () => {
    const db = { translationRun: { findFirst: vi.fn(async () => null), findUniqueOrThrow: vi.fn(), updateMany: vi.fn() } };
    const d = deps({ db });
    expect(await workerTick(d)).toBe("idle");
    expect(d.heartbeat).toHaveBeenCalledTimes(1);
    expect(d.execute).not.toHaveBeenCalled();
  });

  it("executes a claimable run then hands it to afterRun with the DB status", async () => {
    const db = {
      translationRun: {
        findFirst: vi.fn(async () => ({ id: "r1", locale: "es", kind: "SYNC" })),
        findUniqueOrThrow: vi.fn(async () => ({ id: "r1", locale: "es", kind: "SYNC", status: "COMPLETED", startedById: "u1", translatedUnits: 3, flaggedUnits: 1, failedUnits: 0, error: null })),
        updateMany: vi.fn(),
      },
    };
    const d = deps({ db });
    expect(await workerTick(d)).toBe("worked");
    expect(d.execute).toHaveBeenCalledWith("r1", expect.objectContaining({ leaseOwner: "worker-test" }));
    expect(d.afterRun).toHaveBeenCalledWith(expect.objectContaining({ id: "r1", status: "COMPLETED" }));
  });

  it("layer 3: a run that throws is marked FAILED and the tick reports it instead of throwing", async () => {
    const db = {
      translationRun: {
        findFirst: vi.fn(async () => ({ id: "r1", locale: "es", kind: "SYNC" })),
        findUniqueOrThrow: vi.fn(async () => ({ id: "r1", locale: "es", kind: "SYNC", status: "FAILED", startedById: null, translatedUnits: 0, flaggedUnits: 0, failedUnits: 0, error: "boom" })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    };
    const d = deps({ db, execute: vi.fn(async () => { throw new Error("boom"); }) });
    expect(await workerTick(d)).toBe("failed");
    expect(db.translationRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "r1", leaseOwner: "worker-test" }, data: expect.objectContaining({ status: "FAILED", error: "boom" }) }));
    expect(d.afterRun).toHaveBeenCalledWith(expect.objectContaining({ status: "FAILED" }));
  });
});

describe("runWorker", () => {
  it("layer 4: keeps looping through tick failures with backoff, and stops on the signal", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const db = { translationRun: { findFirst: vi.fn(async () => { throw new Error("db down"); }), findUniqueOrThrow: vi.fn(), updateMany: vi.fn() } };
    const d = deps({ db, pollMs: 100, signal: controller.signal });
    const loop = runWorker(d);
    await vi.advanceTimersByTimeAsync(100 + 200 + 400); // three failing ticks with growing waits
    expect(db.translationRun.findFirst.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(d.log.error).toHaveBeenCalled();
    controller.abort();
    await vi.advanceTimersByTimeAsync(1000);
    await loop;
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run — FAIL. Step 3: Implement `worker.ts`**

```ts
import type { PrismaClient, TranslationRunKind } from "@prisma/client";
import type { RunProgress } from "./runs";

/**
 * The i18n worker (spec-19), as pure functions with everything injected so the loop can be tested
 * without a process, a database or a clock. `scripts/i18n-worker.ts` wires the real ones in.
 *
 * Containment layers (spec-19 §The worker): 3 = a run that throws is FAILED and the loop moves on;
 * 4 = a tick that throws backs off exponentially and the loop never exits on its own.
 */

export interface FinishedRun {
  id: string;
  locale: string;
  kind: TranslationRunKind;
  status: string;
  startedById: string | null;
  translatedUnits: number;
  flaggedUnits: number;
  failedUnits: number;
  error: string | null;
}

export interface WorkerLog {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
}

export interface WorkerDeps {
  db: PrismaClient;
  leaseOwner: string;
  pollMs: number;
  signal: AbortSignal;
  /** Announce liveness (Redis key with TTL). Failures are logged, never fatal. */
  heartbeat: () => Promise<void>;
  /** executeRun bound to db — injected so the loop is testable without Postgres. */
  execute: (runId: string, options: { leaseOwner: string; signal: AbortSignal; onProgress?: (p: RunProgress) => void }) => Promise<RunProgress>;
  /** Repair chaining + notifications, once a run reaches a terminal or paused state. */
  afterRun: (run: FinishedRun) => Promise<void>;
  log: WorkerLog;
}

const MAX_BACKOFF_MS = 5 * 60_000;

export function backoffMs(pollMs: number, consecutiveFailures: number): number {
  return Math.min(pollMs * 2 ** consecutiveFailures, MAX_BACKOFF_MS);
}

/** The next run to work: enqueued, not paused or cancelled, lease free or lapsed, oldest first. */
export async function findClaimableRun(db: PrismaClient, now: Date) {
  // Index: TranslationRun[status, leaseExpiresAt]; rows with enqueuedAt set are few.
  return db.translationRun.findFirst({
    where: {
      enqueuedAt: { not: null },
      status: { in: ["PENDING", "PAUSED", "RUNNING"] },
      pauseRequested: false,
      cancelRequested: false,
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
      language: { isBuiltIn: false },
    },
    orderBy: { enqueuedAt: "asc" },
    select: { id: true, locale: true, kind: true },
  });
}

const FINISHED_SELECT = {
  id: true, locale: true, kind: true, status: true, startedById: true,
  translatedUnits: true, flaggedUnits: true, failedUnits: true, error: true,
} as const;

export async function workerTick(deps: WorkerDeps): Promise<"idle" | "worked" | "failed"> {
  await deps.heartbeat().catch((error: unknown) => deps.log.warn({ error }, "worker heartbeat failed"));
  const candidate = await findClaimableRun(deps.db, new Date());
  if (!candidate) return "idle";

  deps.log.info({ runId: candidate.id, locale: candidate.locale, kind: candidate.kind }, "claiming run");
  try {
    const progress = await deps.execute(candidate.id, {
      leaseOwner: deps.leaseOwner,
      signal: deps.signal,
      onProgress: (p) => deps.log.info({ runId: p.runId, completed: p.completed, planned: p.planned, failed: p.failed, flagged: p.flagged }, "progress"),
    });
    deps.log.info({ runId: candidate.id, stopReason: progress.stopReason, status: progress.status }, "run returned");
    if (progress.stopReason === "notClaimed" || progress.stopReason === "localeBusy" || progress.stopReason === "lostLease") return "idle";
    const run = await deps.db.translationRun.findUniqueOrThrow({ where: { id: candidate.id }, select: FINISHED_SELECT });
    await deps.afterRun(run);
    return "worked";
  } catch (error) {
    // Layer 3: this run is broken; the next language must not pay for it.
    const message = error instanceof Error ? error.message.slice(0, 300) : String(error);
    deps.log.error({ error, runId: candidate.id }, "run failed");
    await deps.db.translationRun.updateMany({
      where: { id: candidate.id, leaseOwner: deps.leaseOwner },
      data: { status: "FAILED", error: message, finishedAt: new Date(), leaseOwner: null, leaseExpiresAt: null },
    });
    const run = await deps.db.translationRun.findUniqueOrThrow({ where: { id: candidate.id }, select: FINISHED_SELECT });
    await deps.afterRun(run).catch((e: unknown) => deps.log.error({ error: e, runId: candidate.id }, "afterRun failed"));
    return "failed";
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() { signal.removeEventListener("abort", done); clearTimeout(timer); resolve(); }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Layer 4: never exits on its own. Only the signal ends it. */
export async function runWorker(deps: WorkerDeps): Promise<void> {
  let failures = 0;
  while (!deps.signal.aborted) {
    let wait = deps.pollMs;
    try {
      const outcome = await workerTick(deps);
      failures = 0;
      // After work there may be more (a chained repair run): look again at once.
      if (outcome === "worked") wait = 0;
    } catch (error) {
      failures += 1;
      wait = backoffMs(deps.pollMs, failures);
      deps.log.error({ error, failures, retryInMs: wait }, "worker tick failed");
    }
    await sleep(wait, deps.signal);
  }
  deps.log.info({}, "worker stopped");
}
```

- [ ] **Step 4: Run — PASS. Commit** — `spec-19: worker loop with per-run and per-tick containment`

### Task 10: `afterRun` — notifications hook (repair chaining lands in Task 17)

**Files:**
- Modify: `src/server/services/i18n/worker.ts` — add `defaultAfterRun` factory
- Create: `src/server/services/i18n/notify.ts` (recipients only; templates in Task 21)

- [ ] **Step 1: `notify.ts`**

```ts
import type { PrismaClient } from "@prisma/client";
import { localeSchema, type Locale } from "@/lib/locale";

/**
 * Who hears about a run (spec-19, user decision 2026-09-08): the admin who started it, in their
 * own language; if nobody did (CLI, worker-chained repair), every admin.
 */
export interface Recipient { email: string; locale: Locale; }

function asLocale(value: string | null | undefined): Locale {
  const parsed = localeSchema.safeParse(value ?? "en");
  return parsed.success ? parsed.data : ("en" as Locale);
}

export async function notificationRecipients(db: PrismaClient, startedById: string | null): Promise<Recipient[]> {
  if (startedById) {
    const starter = await db.user.findUnique({ where: { id: startedById }, select: { email: true, profile: { select: { preferredLocale: true } } } });
    if (starter) return [{ email: starter.email, locale: asLocale(starter.profile?.preferredLocale) }];
  }
  // Index: User[role] if present; admins are a handful.
  const admins = await db.user.findMany({ where: { role: "ADMIN", deletedAt: null }, select: { email: true, profile: { select: { preferredLocale: true } } } });
  return admins.map((u) => ({ email: u.email, locale: asLocale(u.profile?.preferredLocale) }));
}
```

(Verify `localeSchema` is exported from `src/lib/locale.ts` — if only the type is, export the schema. Verify `User.deletedAt` exists; drop the filter if not.)

- [ ] **Step 2: `defaultAfterRun` in `worker.ts`** (repair chaining and emails are filled in by Tasks 17 and 21; for now it logs):

```ts
export function defaultAfterRun(deps: { db: PrismaClient; log: WorkerLog }): (run: FinishedRun) => Promise<void> {
  return async (run) => {
    deps.log.info({ runId: run.id, locale: run.locale, kind: run.kind, status: run.status }, "run finished");
  };
}
```

- [ ] **Step 3: Typecheck; Commit** — `spec-19: notification recipients`

### Task 11: The worker script and pm2 definition

**Files:**
- Create: `scripts/i18n-worker.ts`
- Create: `ecosystem.config.cjs`

- [ ] **Step 1: `scripts/i18n-worker.ts`**

```ts
/**
 * The i18n background worker (spec-19).
 *
 *   pnpm i18n:worker            # long-lived; pm2 app `teoripro-i18n-worker` in production
 *
 * Claims translation runs an admin enqueued from /admin/languages and works them to completion,
 * chaining a REPAIR run over what QA flagged. Deviates from the other scripts on purpose: it logs
 * through pino (pm2 captures NDJSON), never exits on its own, and finishes the batch in flight on
 * SIGTERM so a deploy orphans nothing.
 */
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { logger } from "../src/lib/logger";
import { env } from "../src/lib/env";
import { keys, redis } from "../src/server/redis";
import { executeRun } from "../src/server/services/i18n/runs";
import { defaultAfterRun, runWorker } from "../src/server/services/i18n/worker";

(process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile?.(".env");

const db = new PrismaClient();
const log = logger.child({ component: "i18n-worker" });
const pollMs = env().I18N_WORKER_POLL_MS;
const leaseOwner = `worker-${hostname()}-${process.pid}-${randomUUID().slice(0, 6)}`;
const shutdown = new AbortController();

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    log.info({ signal }, "shutdown requested — finishing the current batch");
    shutdown.abort();
  });
}
// Layer 4: a rejected promise nobody awaited is logged, not fatal. An uncaught exception leaves
// the process in an unknown state, so it is logged and handed to pm2 (layer 5) to restart.
process.on("unhandledRejection", (reason) => log.error({ reason }, "unhandled rejection"));
process.on("uncaughtException", (error) => {
  log.error({ error }, "uncaught exception — exiting for pm2 to restart");
  shutdown.abort();
  process.exitCode = 1;
});

async function heartbeat(): Promise<void> {
  // Invalidated by: TTL only — 3 polls without a beat means the worker is gone.
  await redis.set(keys.i18nWorker(), JSON.stringify({ leaseOwner, at: new Date().toISOString() }), "PX", pollMs * 3);
}

runWorker({
  db,
  leaseOwner,
  pollMs,
  signal: shutdown.signal,
  heartbeat,
  execute: (runId, options) => executeRun(db, runId, options),
  afterRun: defaultAfterRun({ db, log }),
  log,
})
  .catch((error) => {
    log.error({ error }, "worker loop ended with an error");
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
    await redis.quit().catch(() => undefined);
  });
```

- [ ] **Step 2: `ecosystem.config.cjs`** (repo root)

```js
/**
 * pm2 process model for the VPS (spec-14 topology, spec-19 worker). Kept in git so a deploy is
 * reproducible; the VPS keeps its own copy too (decision 2026-09-08) — reconcile on deploy.
 *
 *   pm2 startOrReload ecosystem.config.cjs --update-env
 */
module.exports = {
  apps: [
    {
      name: "teoripro",
      cwd: __dirname,
      script: "node_modules/next/dist/bin/next",
      args: "start --port 3020 --hostname 127.0.0.1",
      exec_mode: "fork",
      autorestart: true,
      env: { NODE_ENV: "production" },
    },
    {
      name: "teoripro-i18n-worker",
      cwd: __dirname,
      script: "node_modules/.bin/tsx",
      args: "scripts/i18n-worker.ts",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      // Layer 5: a crash restarts with growing delay; the lease design makes any restart safe.
      exp_backoff_restart_delay: 2000,
      max_restarts: 50,
      // SIGTERM → finish the batch in flight. The in-flight provider call aborts within
      // milliseconds (signal threading), so this only needs to cover the DB writes after it.
      kill_timeout: 20000,
      env: { NODE_ENV: "production" },
    },
  ],
};
```

- [ ] **Step 3: Smoke it locally** — with the dev DB up: `pnpm i18n:worker` in one terminal; in another, run `pnpm vitest run src/server/services/i18n/run-control.integration.test.ts` (which enqueues a run) and watch the worker log claim it; Ctrl-C the worker and confirm `"shutdown requested"` then a clean exit.
- [ ] **Step 4: Commit** — `spec-19: i18n worker script and pm2 definition`

### Task 12: Server actions for the panel

**Files:**
- Modify: `src/app/[locale]/(admin)/admin/languages/actions.ts`
- Modify: `src/i18n/messages/{en,nb}.json` — `admin.languages.errors.{runActive,runNotRunning,runNotPaused,runFinished,runEnqueued}`

- [ ] **Step 1: Read `node_modules/next/dist/docs/01-app/02-guides/server-actions.md`** (Next 16) — confirm plain-argument actions and `useActionState` shapes before writing.

- [ ] **Step 2: Add the actions**

```ts
import { ConflictError } from "@/lib/errors";
import type { SessionUser } from "@/server/authz";
import { requestCancel, requestPause, resumeRun, runDetail, startBackgroundRun, type RunDetail } from "@/server/services/i18n/run-control";

export interface StartOutcome { runId: string; plannedUnits: number; estimatedUsd: number; }

/** Plan AND enqueue in one act — the worker picks it up on its next poll. */
export async function startBackgroundRunAction(_prev: ActionResult<StartOutcome> | undefined, formData: FormData): Promise<ActionResult<StartOutcome>> {
  const user = await requireUser("ADMIN");
  try {
    const only = optionalString(formData, "only");
    const plan = await startBackgroundRun(db, user, { locale: String(formData.get("code") ?? ""), ...(only ? { only: [only as TranslatableEntity] } : {}) });
    revalidatePath("/admin/languages");
    revalidatePath(`/admin/languages/${plan.locale}`);
    return { ok: true, data: { runId: plan.runId, plannedUnits: plan.plannedUnits, estimatedUsd: plan.estimatedUsd } };
  } catch (error) { return toActionError(error); }
}

function runControl(fn: (actor: SessionUser, runId: string) => Promise<void>) {
  return async (_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> => {
    const user = await requireUser("ADMIN");
    try {
      await fn(user, String(formData.get("runId") ?? ""));
      revalidatePath("/admin/languages");
      return { ok: true };
    } catch (error) { return toActionError(error); }
  };
}
export const pauseRunAction = runControl((actor, runId) => requestPause(db, actor, runId));
export const resumeRunAction = runControl((actor, runId) => resumeRun(db, actor, runId));
export const cancelRunAction = runControl((actor, runId) => requestCancel(db, actor, runId));

/** Read-only, no revalidation: polled every 3 s by the progress panel. */
export async function runDetailAction(runId: string): Promise<ActionResult<RunDetail>> {
  await requireUser("ADMIN");
  try { return { ok: true, data: await runDetail(db, runId) }; } catch (error) { return toActionError(error); }
}
```

(`"use server"` files may only export async functions — if `export const pauseRunAction = runControl(...)` is rejected by Next 16's compiler, write the three as explicit `export async function` bodies calling the same helper.) Also fix the existing `runSliceAction` to refuse enqueued runs:

```ts
    const run = await db.translationRun.findUnique({ where: { id: runId }, select: { enqueuedAt: true } });
    if (run?.enqueuedAt) throw new ConflictError({ runId }, "admin.languages.errors.runEnqueued");
```

- [ ] **Step 3: i18n error keys** (both files; nb in parentheses):
  - `runActive`: "A background run is already in progress for this language." ("En bakgrunnskjøring pågår allerede for dette språket.")
  - `runNotRunning`: "That run is not running." ("Den kjøringen kjører ikke.")
  - `runNotPaused`: "That run is not paused." ("Den kjøringen er ikke satt på pause.")
  - `runFinished`: "That run has already finished." ("Den kjøringen er allerede ferdig.")
  - `runEnqueued`: "The background worker owns this run — pause it there instead." ("Bakgrunnsarbeideren eier denne kjøringen — sett den på pause der i stedet.")

- [ ] **Step 4: `pnpm vitest run src/i18n && pnpm exec tsc --noEmit` — PASS. Commit** — `spec-19: run control actions`

### Task 13: The progress panel and board wiring

**Files:**
- Create: `src/components/admin/languages/run-panel.tsx`
- Modify: `src/components/admin/languages/language-board.tsx` (`LanguageRow` gains `latestRun`; plan card gains "Start in background"; `:308-316` replaced by `<RunPanel>`)
- Modify: `src/app/[locale]/(admin)/admin/languages/page.tsx` (load `latestRunFor` per language + `workerOnline`)
- Create: `src/app/[locale]/(admin)/admin/languages/loading.tsx`
- Modify: `en.json`/`nb.json` `admin.languages.*`

- [ ] **Step 1: `run-panel.tsx`**

```tsx
"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useActionState, useCallback, useEffect, useState } from "react";
import { cancelRunAction, pauseRunAction, resumeRunAction, runDetailAction } from "@/app/[locale]/(admin)/admin/languages/actions";
import { FormAlert } from "@/components/auth/form-alert";
import { SubmitButton } from "@/components/auth/submit-button";
import { Card, CardContent, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { ActionResult } from "@/server/contracts/common";
import type { RunDetail } from "@/server/services/i18n/run-control";

const POLL_MS = 3000;
const LIVE = new Set(["PENDING", "RUNNING", "PAUSED"]);

/**
 * What a background run is doing, refreshed every three seconds while it is live (spec-19).
 * Polled, not streamed: a run lasts hours, and one indexed read every 3 s is robust behind nginx
 * in a way a held-open connection is not. Stops polling when the tab is hidden.
 */
export function RunPanel({ initial, workerOnline }: { initial: RunDetail; workerOnline: boolean }) {
  const t = useTranslations("admin.languages.run");
  const tErrors = useTranslations();
  const format = useFormatter();
  const [run, setRun] = useState<RunDetail>(initial);
  const [pauseState, pause] = useActionState<ActionResult | undefined, FormData>(pauseRunAction, undefined);
  const [resumeState, resume] = useActionState<ActionResult | undefined, FormData>(resumeRunAction, undefined);
  const [cancelState, cancel] = useActionState<ActionResult | undefined, FormData>(cancelRunAction, undefined);

  const refresh = useCallback(async () => {
    const result = await runDetailAction(run.runId);
    if (result.ok) setRun(result.data);
  }, [run.runId]);

  useEffect(() => {
    if (!LIVE.has(run.status)) return;
    let cancelled = false;
    const tick = () => { if (!document.hidden && !cancelled) void refresh(); };
    const timer = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => { cancelled = true; clearInterval(timer); document.removeEventListener("visibilitychange", tick); };
  }, [run.status, refresh]);

  // A control answered: show its state at once rather than waiting up to 3 s.
  useEffect(() => { void refresh(); }, [pauseState, resumeState, cancelState, refresh]);

  const percent = run.planned === 0 ? 100 : Math.round(((run.planned - run.remaining) / run.planned) * 100);
  const error = [pauseState, resumeState, cancelState].find((s) => s?.ok === false);
  const statusKey = run.stale ? "stale" : run.cancelRequested ? "cancelling" : run.pauseRequested ? "pausing" : run.status.toLowerCase();

  return (
    <Card className="[--card-spacing:--spacing(4)]" aria-live="polite">
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm">{t("title", { kind: t(`kinds.${run.kind}`) })}</CardTitle>
          <span className={cn("rounded-full px-2 py-0.5 text-xs", run.stale ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground")}>
            {t(`status.${statusKey}`)}
          </span>
        </div>

        <div className="h-2 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label={t("progressLabel")}>
          <div className={cn("h-full rounded-full transition-[width] duration-500", run.status === "COMPLETED" ? "bg-[var(--status-success)]" : "bg-primary")} style={{ width: `${percent}%` }} />
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
          <Stat label={t("completed")} value={`${run.completed} / ${run.planned}`} />
          <Stat label={t("flagged")} value={String(run.flagged)} />
          <Stat label={t("failed")} value={String(run.failed)} />
          <Stat label={t("memory")} value={String(run.memoryHits)} />
          <Stat label={t("rate")} value={run.rateUnitsPerMin === null ? t("estimating") : t("perMinute", { rate: run.rateUnitsPerMin.toFixed(1) })} />
          <Stat label={t("eta")} value={run.etaSeconds === null ? t("estimating") : formatDuration(run.etaSeconds)} />
          <Stat label={t("cost")} value={t("costValue", { spent: run.spentUsd.toFixed(2), estimate: run.estimatedUsd.toFixed(2) })} />
          <Stat label={t("heartbeat")} value={run.heartbeatAt ? format.relativeTime(new Date(run.heartbeatAt)) : "—"} />
        </dl>

        <ul className="flex flex-wrap gap-2 text-xs text-muted-foreground">
          {run.byEntity.map((e) => (
            <li key={e.entity} className="rounded-full bg-muted px-2 py-0.5">
              {e.entity}: {e.done}/{e.done + e.queued + e.running + e.failed + e.skipped}
              {e.skipped > 0 ? ` · ${t("skipped", { count: e.skipped })}` : ""}
            </li>
          ))}
        </ul>

        {run.stale ? <FormAlert>{t("staleHint")}</FormAlert> : null}
        {!workerOnline && LIVE.has(run.status) ? <FormAlert tone="info">{t("workerOffline")}</FormAlert> : null}
        {run.error ? <FormAlert>{run.error}</FormAlert> : null}
        {error?.ok === false ? <FormAlert>{tErrors(error.messageKey)}</FormAlert> : null}

        {LIVE.has(run.status) ? (
          <div className="flex flex-wrap gap-2">
            {run.status === "RUNNING" && !run.pauseRequested ? (
              <form action={pause}><input type="hidden" name="runId" value={run.runId} /><SubmitButton className="h-9" variant="outline" label={t("pause")} pendingLabel={t("pausing")} /></form>
            ) : null}
            {run.status === "PAUSED" || run.pauseRequested ? (
              <form action={resume}><input type="hidden" name="runId" value={run.runId} /><SubmitButton className="h-9" label={t("resume")} pendingLabel={t("resuming")} /></form>
            ) : null}
            {!run.cancelRequested ? (
              <form action={cancel}><input type="hidden" name="runId" value={run.runId} /><SubmitButton className="h-9" variant="ghost" label={t("cancel")} pendingLabel={t("cancelling")} /></form>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (<div><dt className="text-muted-foreground">{label}</dt><dd className="font-medium text-foreground tabular-nums">{value}</dd></div>);
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
```

- [ ] **Step 2: Board + page wiring**

`page.tsx`: alongside `languageCoverage`, load `latestRunFor(db, l.code)` per language and `workerOnline = Boolean(await redis.get(keys.i18nWorker()))` (wrap in try/catch → false). Pass `latestRun` on each row and `workerOnline` to the board. Remove the global `running` query (`:38-47`) and the `activeRun` prop.

`language-board.tsx`: `LanguageRow` gains `latestRun: RunDetail | null`; the board gains `workerOnline: boolean`. Replace the `activeRun` paragraph (`:308-316`) with `{language.latestRun ? <RunPanel initial={language.latestRun} workerOnline={workerOnline} /> : null}` inside each language card. In the plan card (`:275-288`) add a second form before the slice form:

```tsx
<form action={startAction} className="flex flex-wrap items-center gap-2">
  <input type="hidden" name="code" value={language.code} />
  <SubmitButton label={t("startBackground")} pendingLabel={t("starting")} />
  <span className="text-xs text-muted-foreground">{workerOnline ? t("startBackgroundNote") : t("workerOfflineNote")}</span>
</form>
```

with `const [startState, startAction] = useActionState<ActionResult<StartOutcome> | undefined, FormData>(startBackgroundRunAction, undefined);` and its error folded into the `error` find. Add a worker chip in the board header: `<span className={cn("rounded-full px-2 py-0.5 text-xs", workerOnline ? "bg-[var(--status-success-soft)] text-[var(--status-success-strong)]" : "bg-muted text-muted-foreground")}>{workerOnline ? t("workerOnline") : t("workerOffline")}</span>`.

`loading.tsx`: three `animate-pulse rounded-md bg-muted` cards matching the language card height (copy the pattern from `src/app/[locale]/(student)/task-sets/loading.tsx`).

- [ ] **Step 3: i18n keys** — add under `admin.languages` (en / nb):
  - `startBackground` "Start in background" / "Start i bakgrunnen"; `starting` "Starting…" / "Starter…"
  - `startBackgroundNote` "The worker takes it from here — you can close this page." / "Arbeideren tar det herfra — du kan lukke siden."
  - `workerOfflineNote` "No worker is online; the run waits until one starts, or translate 25 now." / "Ingen arbeider er pålogget; kjøringen venter til en starter, eller oversett 25 nå."
  - `workerOnline` "Background worker online" / "Bakgrunnsarbeider pålogget"; `workerOffline` "Background worker offline" / "Bakgrunnsarbeider frakoblet"
  - `run.title` "{kind} run" / "{kind}-kjøring"; `run.kinds.{FULL,SYNC,SINGLE_ENTITY,REPAIR,SAMPLE}` "Full"/"Sync"/"Single kind"/"Repair"/"Sample" (nb: "Full"/"Synk"/"Én type"/"Reparasjon"/"Prøve")
  - `run.status.{pending,running,paused,completed,failed,cancelled,pausing,cancelling,stale}` "Queued"/"Running"/"Paused"/"Completed"/"Failed"/"Cancelled"/"Pausing after this batch"/"Cancelling after this batch"/"Worker not responding" (nb: "I kø"/"Kjører"/"På pause"/"Fullført"/"Feilet"/"Avbrutt"/"Pauser etter denne bolken"/"Avbryter etter denne bolken"/"Arbeideren svarer ikke")
  - `run.progressLabel` "Run progress" / "Fremdrift"; `run.completed` "Done" / "Ferdig"; `run.flagged` "Held for review" / "Til vurdering"; `run.failed` "Failed" / "Feilet"; `run.memory` "From memory" / "Fra minne"; `run.rate` "Rate" / "Tempo"; `run.perMinute` "{rate} / min"; `run.eta` "Time left" / "Tid igjen"; `run.estimating` "estimating…" / "beregner…"; `run.cost` "Cost" / "Kostnad"; `run.costValue` "${spent} of ~${estimate}" / "${spent} av ~${estimate}"; `run.heartbeat` "Last heartbeat" / "Siste livstegn"; `run.skipped` "{count} given up" / "{count} oppgitt"
  - `run.staleHint` "The worker has not reported in for over three minutes. When it returns it resumes exactly where it stopped — nothing is lost." / "Arbeideren har ikke meldt seg på over tre minutter. Når den er tilbake fortsetter den nøyaktig der den stoppet — ingenting går tapt."
  - `run.workerOffline` "No worker is online right now; this run resumes when one starts." / "Ingen arbeider er pålogget nå; kjøringen fortsetter når en starter."
  - `run.pause` "Pause" / "Pause"; `run.pausing` "Pausing…" / "Pauser…"; `run.resume` "Resume" / "Fortsett"; `run.resuming` "Resuming…" / "Fortsetter…"; `run.cancel` "Cancel run" / "Avbryt kjøring"; `run.cancelling` "Cancelling…" / "Avbryter…"

- [ ] **Step 4: Verify in the browser** — `pnpm dev` + `pnpm i18n:worker`; add a test language, Plan, "Start in background", watch the panel move, Pause, Resume, Cancel; check at 390 px width, tab through the controls, switch locale to nb. Then `pnpm vitest run src/i18n && pnpm exec tsc --noEmit && pnpm exec eslint`.
- [ ] **Step 5: Commit** — `spec-19: live progress panel with pause, resume and cancel`

### Task 14: Phase 1 evidence

- [ ] Write `specs/notes/spec-19-notes.md` with the Phase 1 checklist items and evidence (test output, the kill-mid-run experiment: start a run, `kill -9` the worker, restart, show `RUNNING` count 0 and no duplicate `Translation` rows).
- [ ] `specs/README.md` row 19 → 🔨 In progress — phase 1 ✅.
- [ ] `DECISIONS.md` — the five entries from §"Decisions to log" (dated 2026-09-08/09).
- [ ] Commit — `spec-19: phase 1 verification evidence`

# Phase 2 — Auto-repair

### Task 15: The repair prompt

**Files:**
- Modify: `src/server/ai/prompts/translation.ts`
- Test: `src/server/ai/prompts/translation.test.ts` (new)

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from "vitest";
import { translateRepairPrompt } from "./translation";

describe("translation.repair prompt", () => {
  it("states each unit's previous attempt and the exact problems to fix", () => {
    const text = translateRepairPrompt.render({
      targetLanguage: "Spanish", targetCode: "es", styleNote: "", glossaryBlock: "",
      unitsJson: JSON.stringify([{ id: "q1", kind: "MASTER_ITEM", correctOptionKey: "b", en: { stem: "Limit is 80 km/h" }, nb: { stem: "Grensen er 80 km/t" },
        previous: { stem: "El límite es 50 km/h" }, problems: [{ code: "NUMBER_DRIFT", detail: "80 to 50" }], reviewerNote: null }]),
    });
    expect(text).toContain("NUMBER_DRIFT");
    expect(text).toContain("80 to 50");
    expect(text).toContain("El límite es 50 km/h");
    expect(text).toMatch(/fix every listed problem/i);
    expect(translateRepairPrompt.id).toBe("translation.repair");
  });
});
```

- [ ] **Step 2: Run — FAIL. Step 3: Add the template** (same house style as `translateUnitsPrompt`; reuse its example shape and rules):

```ts
export const translateRepairPrompt: PromptTemplate<{
  targetLanguage: string;
  targetCode: string;
  styleNote: string;
  glossaryBlock: string;
  unitsJson: string;
}> = {
  id: "translation.repair",
  version: "1.0.0",
  render: ({ targetLanguage, targetCode, styleNote, glossaryBlock, unitsJson }) =>
    [
      `You are repairing driving-theory translations into ${targetLanguage} (${targetCode}) that automated checks rejected.`,
      "Each item carries the English source, the Norwegian legal source, the PREVIOUS translation, and the exact PROBLEMS the checks found — a code and, where possible, what changed (source value → translated value). Some carry a human reviewer's note.",
      "Fix every listed problem. Keep everything that was not a problem: same meaning, same register, same option order and keys. Do not paraphrase for its own sake.",
      "HARD RULES — breaking any of these makes the repair worthless:",
      "1. Return strict JSON with the same ids in the same order.",
      "2. Option keys are byte-exact copies of the source keys.",
      "3. Never change a number, unit, or § reference.",
      "4. Preserve {placeholder} and {{slot}} tokens exactly.",
      "5. Institution names stay untranslated.",
      "6. The correct option must remain the only defensible answer.",
      "7. Write for a learner driver: plain, precise, no jargon.",
      "IF YOU CANNOT FIX AN ITEM FAITHFULLY, SAY SO in its `issue` field and return the previous translation unchanged for it.",
      styleNote ? `STYLE: ${styleNote}` : "",
      glossaryBlock,
      "Return exactly this shape:",
      JSON.stringify({ units: [{ id: "…", value: { stem: "…", options: [{ key: "a", text: "…" }], explanation: "…" }, issue: "optional" }] }, null, 2),
      "ITEMS:",
      unitsJson,
    ]
      .filter(Boolean)
      .join("\n\n"),
};
```

- [ ] **Step 4: PASS. Commit** — `spec-19: repair prompt feeds the QA finding back`

### Task 16: `repair.ts` and the REPAIR slice

**Files:**
- Create: `src/server/services/i18n/repair.ts`
- Modify: `src/server/services/i18n/translate.ts` — `export` `translationResponseSchema` and `shapeLike`
- Modify: `src/server/services/i18n/runs.ts` — replace the `repairSlice` stub
- Test: `src/server/services/i18n/repair.test.ts` (pure), `src/server/services/i18n/repair.integration.test.ts`

- [ ] **Step 1: Check `model Translation` indexes in `prisma/schema.prisma`.** The planner filters `[locale, status]`; if no index has `locale` then `status` as leading columns, add `@@index([locale, status])` with a migration `20260909091000_translation_locale_status_idx` (same hand-edit rules as Task 5).

- [ ] **Step 2: Pure test first** (`repair.test.ts`):

```ts
import { describe, expect, it } from "vitest";
import { isReQaOnly, repairProblems } from "./repair";

describe("repair triage", () => {
  it("a unit whose only flags are infrastructure or advisory is re-QA'd, not re-translated", () => {
    expect(isReQaOnly(["QA_UNAVAILABLE"])).toBe(true);
    expect(isReQaOnly(["QA_UNAVAILABLE", "LENGTH_OUTLIER"])).toBe(true);
    expect(isReQaOnly(["NUMBER_DRIFT"])).toBe(false);
    expect(isReQaOnly([])).toBe(true);
  });
  it("turns a stored qaReport into prompt-ready problems", () => {
    const problems = repairProblems({
      qaFlags: ["NUMBER_DRIFT", "ANSWER_PERMUTED"],
      qaReport: { issues: [{ code: "NUMBER_DRIFT", blocking: true, detail: "80 to 50" }], modelIssue: "unsure about 'forkjørsvei'", semantic: { optionPairings: [{ key: "a", nearest: "b" }, { key: "b", nearest: "a" }] } },
    });
    expect(problems).toEqual(expect.arrayContaining([
      { code: "NUMBER_DRIFT", detail: "80 to 50" },
      { code: "ANSWER_PERMUTED", detail: "option a reads like b, b reads like a" },
      { code: "MODEL_FLAGGED", detail: "unsure about 'forkjørsvei'" },
    ]));
  });
});
```

- [ ] **Step 3: Implement `repair.ts`**

```ts
import type { PrismaClient, TranslatableEntity } from "@prisma/client";
import { aiJson } from "@/server/ai/client";
import { glossaryBlock, translateRepairPrompt } from "@/server/ai/prompts/translation";
import { logger } from "@/lib/logger";
import { extractAll } from "./extract";
import { probeMemory, rememberTranslation } from "./memory";
import { semanticCheck, type QaInput } from "./qa";
import { ESTIMATED_USD_PER_1K_TOKENS } from "./run-math";
import type { RunPlan } from "./runs"; // type-only: erased, so no runtime cycle with runs.ts
import { shapeLike, translationResponseSchema, type LanguagePolicy, type TranslatedUnit } from "./translate";
import { memoryHash, type TranslationUnit, type UnitPayload } from "./units";
import { allCodes, checkTranslation } from "./validation";

/**
 * Auto-repair (spec-19). A NEEDS_REVIEW unit is re-translated with the QA finding stated in the
 * prompt, at temperature 0, and ALWAYS re-QA'd. Three attempts, then a human. Units whose only
 * flags are infrastructure (`QA_UNAVAILABLE`) or advisory (`LENGTH_OUTLIER`) are not re-translated
 * at all — their text was never the problem — they are re-QA'd on the existing value, and that
 * does not consume a repair attempt.
 */

export const MAX_REPAIR_ATTEMPTS = 3;
const NOT_A_QUALITY_FLAG = new Set(["QA_UNAVAILABLE", "LENGTH_OUTLIER"]);

export function isReQaOnly(flags: string[]): boolean {
  return flags.every((flag) => NOT_A_QUALITY_FLAG.has(flag));
}

export interface RepairProblem { code: string; detail?: string; }

export interface RepairContext {
  value: UnitPayload;
  qaFlags: string[];
  problems: RepairProblem[];
  reviewNote: string | null;
  repairAttempts: number;
  sourceHash: string;
}

/** The stored qaReport, restated as things the model can act on. */
export function repairProblems(row: { qaFlags: string[]; qaReport: unknown }): RepairProblem[] {
  const report = (row.qaReport ?? {}) as {
    issues?: Array<{ code: string; detail?: string }>;
    modelIssue?: string;
    semantic?: { optionPairings?: Array<{ key: string; nearest: string }> };
  };
  const problems: RepairProblem[] = (report.issues ?? []).map((i) => (i.detail ? { code: i.code, detail: i.detail } : { code: i.code }));
  const seen = new Set(problems.map((p) => p.code));
  if (row.qaFlags.includes("ANSWER_PERMUTED") && !seen.has("ANSWER_PERMUTED")) {
    const swapped = (report.semantic?.optionPairings ?? []).filter((p) => p.nearest !== p.key);
    problems.push({ code: "ANSWER_PERMUTED", detail: swapped.map((p) => `option ${p.key} reads like ${p.nearest}`).join(", ") });
  }
  if (report.modelIssue) problems.push({ code: "MODEL_FLAGGED", detail: report.modelIssue });
  for (const flag of row.qaFlags) if (!seen.has(flag) && !problems.some((p) => p.code === flag)) problems.push({ code: flag });
  return problems;
}

/** Units eligible for repair right now: flagged, under the ceiling, and whose source is unchanged. */
export async function repairCandidates(db: PrismaClient, locale: string): Promise<TranslationUnit[]> {
  const language = await db.language.findUniqueOrThrow({ where: { code: locale }, select: { glossaryVersion: true, isBuiltIn: true } });
  if (language.isBuiltIn) return [];
  // Index: Translation[locale, status] (Step 1).
  const rows = await db.translation.findMany({
    where: { locale, status: "NEEDS_REVIEW", entity: { not: "ITEM_VARIANT" }, repairAttempts: { lt: MAX_REPAIR_ATTEMPTS } },
    select: { entity: true, entityId: true, sourceHash: true },
  });
  if (rows.length === 0) return [];
  const units = await extractAll(db, { glossaryVersion: language.glossaryVersion });
  const byKey = new Map(units.map((u) => [`${u.entity}:${u.entityId}`, u]));
  return rows.flatMap((row) => {
    const unit = byKey.get(`${row.entity}:${row.entityId}`);
    // A stale row belongs to SYNC, not REPAIR.
    return unit && unit.sourceHash === row.sourceHash ? [unit] : [];
  });
}

export async function planRepairRun(db: PrismaClient, locale: string, input: { startedById: string | null }): Promise<RunPlan> {
  const candidates = await repairCandidates(db, locale);
  const run = await db.translationRun.create({
    data: {
      locale, kind: "REPAIR", status: "PENDING", plannedUnits: candidates.length, startedById: input.startedById,
      estimatedUsd: ((candidates.length * 700) / 1000) * ESTIMATED_USD_PER_1K_TOKENS,
      enqueuedAt: new Date(),
    },
    select: { id: true, estimatedUsd: true },
  });
  if (candidates.length > 0) {
    await db.translationJob.createMany({ data: candidates.map((u) => ({ runId: run.id, entity: u.entity, entityId: u.entityId, sourceHash: u.sourceHash })), skipDuplicates: true });
  }
  const byEntity: Record<string, number> = {};
  for (const unit of candidates) byEntity[unit.entity] = (byEntity[unit.entity] ?? 0) + 1;
  return { runId: run.id, locale, plannedUnits: candidates.length, byEntity, estimatedPromptTokens: candidates.length * 420, estimatedCompletionTokens: candidates.length * 280, estimatedUsd: run.estimatedUsd };
}

export async function repairContextFor(db: PrismaClient, locale: string, entity: TranslatableEntity, ids: string[]): Promise<Map<string, RepairContext>> {
  // Index: Translation @@unique([locale, entity, entityId]).
  const rows = await db.translation.findMany({
    where: { locale, entity, entityId: { in: ids } },
    select: { entityId: true, value: true, qaFlags: true, qaReport: true, reviewNote: true, repairAttempts: true, sourceHash: true },
  });
  return new Map(rows.map((row) => [row.entityId, {
    value: row.value as unknown as UnitPayload, qaFlags: row.qaFlags, problems: repairProblems(row),
    reviewNote: row.reviewNote, repairAttempts: row.repairAttempts, sourceHash: row.sourceHash,
  }]));
}

export interface RepairOutcome {
  translated: TranslatedUnit[];
  /** Units that cost a repair attempt (a model call or a memory hit) — re-QA-only ones do not. */
  consumed: Set<string>;
}

interface Candidate { unit: TranslationUnit; value: UnitPayload; fromMemory: boolean; modelVersion: string | null; promptVersion: string | null; providerLabel: string | null; promptTokens: number; completionTokens: number; issue?: string; }

export async function repairBatch(
  db: PrismaClient,
  language: LanguagePolicy,
  units: TranslationUnit[],
  context: Map<string, RepairContext>,
  options: { signal?: AbortSignal } = {},
): Promise<RepairOutcome> {
  const consumed = new Set<string>();
  const candidates: Candidate[] = [];
  const toTranslate: TranslationUnit[] = [];

  for (const unit of units) {
    const ctx = context.get(unit.entityId);
    if (!ctx) continue; // superseded since planning; storeRepairs would refuse it anyway
    if (isReQaOnly(ctx.qaFlags)) {
      candidates.push({ unit, value: ctx.value, fromMemory: false, modelVersion: null, promptVersion: null, providerLabel: null, promptTokens: 0, completionTokens: 0 });
    } else {
      toTranslate.push(unit);
      consumed.add(unit.entityId);
    }
  }

  // Memory first, but only a hit that passes the deterministic gate: a sibling repaired one batch
  // ago, or a human edit of identical English, is exactly what we want to find here.
  if (toTranslate.length > 0) {
    const hashes = toTranslate.map((u) => memoryHash(u.entity, u.en, language.glossaryVersion));
    const memory = await probeMemory(db, language.code, hashes);
    const pending: TranslationUnit[] = [];
    toTranslate.forEach((unit, i) => {
      const hit = memory.get(hashes[i]);
      const ok = hit && checkTranslation({ entity: unit.entity, locale: language.code, source: unit.en, translated: hit.value, ...(unit.correctOptionKey ? { correctOptionKey: unit.correctOptionKey } : {}) }).passed;
      if (hit && ok) candidates.push({ unit, value: hit.value, fromMemory: true, modelVersion: hit.modelVersion, promptVersion: hit.promptVersion, providerLabel: null, promptTokens: 0, completionTokens: 0 });
      else pending.push(unit);
    });

    if (pending.length > 0) {
      const response = await aiJson({
        task: "translation",
        prompt: translateRepairPrompt,
        vars: {
          targetLanguage: language.englishName, targetCode: language.code, styleNote: language.styleNote ?? "", glossaryBlock: glossaryBlock(language.glossary),
          unitsJson: JSON.stringify(pending.map((u) => { const ctx = context.get(u.entityId)!; return { id: u.entityId, kind: u.entity, correctOptionKey: u.correctOptionKey, en: u.en, nb: u.nb, previous: ctx.value, problems: ctx.problems, reviewerNote: ctx.reviewNote }; })),
        },
        schema: translationResponseSchema,
        temperature: 0,
        maxTokens: 8192,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const perUnitPrompt = Math.round(response.usage.promptTokens / pending.length);
      const perUnitCompletion = Math.round(response.usage.completionTokens / pending.length);
      const byId = new Map(response.data.units.map((entry) => [entry.id, entry]));
      for (const unit of pending) {
        const entry = byId.get(unit.entityId);
        if (!entry) { logger.warn({ entityId: unit.entityId }, "repair returned no unit"); continue; }
        candidates.push({ unit, value: shapeLike(unit.en, entry.value as UnitPayload), fromMemory: false, modelVersion: response.modelVersion, promptVersion: response.promptVersion, providerLabel: response.providerLabel, promptTokens: perUnitPrompt, completionTokens: perUnitCompletion, ...(entry.issue ? { issue: entry.issue } : {}) });
      }
    }
  }

  // Every candidate is QA'd: repair raises scrutiny, never lowers it.
  const results: TranslatedUnit[] = candidates.map((c) => {
    const check = checkTranslation({ entity: c.unit.entity, locale: language.code, source: c.unit.en, translated: c.value, ...(c.unit.correctOptionKey ? { correctOptionKey: c.unit.correctOptionKey } : {}) });
    const flags = allCodes(check);
    if (c.issue) flags.push("MODEL_FLAGGED");
    return {
      unit: c.unit, value: c.value, status: check.passed && !c.issue ? "MACHINE" : "NEEDS_REVIEW", qaFlags: flags,
      qaReport: { source: c.fromMemory ? "memory" : "repair", issues: check.issues, ...(c.issue ? { modelIssue: c.issue } : {}) },
      semanticScore: null, fromMemory: c.fromMemory, modelVersion: c.modelVersion, promptVersion: c.promptVersion, providerLabel: c.providerLabel, promptTokens: c.promptTokens, completionTokens: c.completionTokens,
    };
  });
  const qaInputs: QaInput[] = results.map((r) => ({ id: r.unit.entityId, entity: r.unit.entity, source: r.unit.en, translated: r.value, ...(r.unit.correctOptionKey ? { correctOptionKey: r.unit.correctOptionKey } : {}) }));
  const semantic = await semanticCheck({ locale: language.code, languageName: language.englishName, units: qaInputs, ...(options.signal ? { signal: options.signal } : {}) });
  for (const r of results) {
    const verdict = semantic.get(r.unit.entityId);
    if (!verdict) continue;
    r.semanticScore = verdict.semanticScore;
    r.qaFlags = [...new Set([...r.qaFlags, ...verdict.flags])];
    r.qaReport = { ...(r.qaReport ?? {}), semantic: verdict.report };
    if (verdict.flags.length > 0) r.status = "NEEDS_REVIEW";
  }
  return { translated: results, consumed };
}

/**
 * Store repairs WITHOUT the unconditional upsert `storeTranslations` uses: a reviewer may have
 * approved, edited or rejected the row while the batch ran, and the source may have moved. Only a
 * row that is still NEEDS_REVIEW on the same source is touched; anything else is "superseded".
 */
export async function storeRepairs(
  db: PrismaClient,
  locale: string,
  results: TranslatedUnit[],
  runId: string,
  consumed: Set<string>,
  glossaryVersion: number,
): Promise<Set<string>> {
  const superseded = new Set<string>();
  for (const item of results) {
    const updated = await db.translation.updateMany({
      where: { locale, entity: item.unit.entity, entityId: item.unit.entityId, status: "NEEDS_REVIEW", sourceHash: item.unit.sourceHash },
      data: {
        value: item.value as object, status: item.status, qaFlags: item.qaFlags, qaReport: item.qaReport as object, semanticScore: item.semanticScore,
        fromMemory: item.fromMemory, modelVersion: item.modelVersion, promptVersion: item.promptVersion, providerLabel: item.providerLabel,
        promptTokens: item.promptTokens, completionTokens: item.completionTokens, runId,
        reviewedById: null, reviewedAt: null, reviewNote: null,
        ...(consumed.has(item.unit.entityId) ? { repairAttempts: { increment: 1 } } : {}),
      },
    });
    if (updated.count === 0) { superseded.add(item.unit.entityId); continue; }
    if (item.status === "MACHINE" && !item.fromMemory) {
      await rememberTranslation(db, { locale, entity: item.unit.entity, source: item.unit.en, value: item.value, glossaryVersion, modelVersion: item.modelVersion, promptVersion: item.promptVersion });
    }
  }
  return superseded;
}
```

- [ ] **Step 4: `repairSlice` in `runs.ts`** (replaces the Task 7 stub):

```ts
async function repairSlice(db, locale, language, units, runId, signal): Promise<SliceOutcome> {
  if (units.length === 0) return { translated: [], superseded: new Set() };
  const context = await repairContextFor(db, locale, units[0].entity, units.map((u) => u.entityId));
  const { translated, consumed } = await repairBatch(db, { ...language, qaSampleRate: 1 }, units, context, signal ? { signal } : {});
  const superseded = await storeRepairs(db, locale, translated, runId, consumed, language.glossaryVersion);
  return { translated, superseded };
}
```

- [ ] **Step 5: Integration test** (`repair.integration.test.ts`, same fixture skeleton + AI mock as Task 7; seed one TOPIC translation as `NEEDS_REVIEW` with `qaFlags: ["NUMBER_DRIFT"]`, `qaReport: { issues: [{ code: "NUMBER_DRIFT", blocking: true, detail: "80 to 50" }] }` using the extractor's real `sourceHash` — pattern at `languages.integration.test.ts:220-255`):

```ts
d("repair (spec-19)", () => {
  it("re-translates a flagged unit with the finding in the prompt, re-QAs it, and promotes it", async () => {
    let prompt = "";
    aiJson.mockImplementation(async (opts: { prompt: { id: string }; vars: { unitsJson: string } }) => {
      if (opts.prompt.id === "translation.repair") prompt = opts.vars.unitsJson;
      const items = JSON.parse(opts.vars.unitsJson) as Array<{ id: string; en: { name: string } }>;
      return { data: { units: items.map((u) => ({ id: u.id, value: { name: `fixed ${u.en.name}` } })) }, modelVersion: "stub", promptVersion: "p", usage: { promptTokens: 10, completionTokens: 10 }, providerLabel: "stub" };
    });
    const plan = await planRepairRun(db, CODE, { startedById: actor.id });
    expect(plan.plannedUnits).toBe(1);
    const progress = await executeRun(db, plan.runId, { leaseOwner: "t-repair" });
    expect(progress.done).toBe(true);
    expect(prompt).toContain("NUMBER_DRIFT");
    expect(prompt).toContain("80 to 50");
    const row = await db.translation.findFirstOrThrow({ where: { locale: CODE, entity: "TOPIC", entityId: topicIds[0] } });
    expect(row.status).toBe("MACHINE");
    expect(row.repairAttempts).toBe(1);
    expect(row.qaFlags).toEqual([]);
  });

  it("does not touch a row a human approved while the batch ran", async () => {
    // seed NEEDS_REVIEW again, then approve it from inside the mocked model call
    aiJson.mockImplementationOnce(async (opts: { vars: { unitsJson: string } }) => {
      await db.translation.updateMany({ where: { locale: CODE, entity: "TOPIC", entityId: topicIds[0] }, data: { status: "APPROVED", value: { name: "human" } } });
      const items = JSON.parse(opts.vars.unitsJson) as Array<{ id: string }>;
      return { data: { units: items.map((u) => ({ id: u.id, value: { name: "machine" } })) }, modelVersion: "stub", promptVersion: "p", usage: { promptTokens: 1, completionTokens: 1 }, providerLabel: "stub" };
    });
    const plan = await planRepairRun(db, CODE, { startedById: actor.id });
    await executeRun(db, plan.runId, { leaseOwner: "t-superseded" });
    const row = await db.translation.findFirstOrThrow({ where: { locale: CODE, entity: "TOPIC", entityId: topicIds[0] } });
    expect(row.status).toBe("APPROVED");
    expect(row.value).toEqual({ name: "human" });
    expect(await db.translationJob.count({ where: { runId: plan.runId, state: "SKIPPED", error: "superseded" } })).toBe(1);
  });

  it("stops planning a unit after three consumed attempts; infrastructure flags cost nothing", async () => {
    await db.translation.updateMany({ where: { locale: CODE, entity: "TOPIC", entityId: topicIds[0] }, data: { status: "NEEDS_REVIEW", qaFlags: ["NUMBER_DRIFT"], repairAttempts: 3 } });
    expect((await repairCandidates(db, CODE)).map((u) => u.entityId)).not.toContain(topicIds[0]);
    await db.translation.updateMany({ where: { locale: CODE, entity: "TOPIC", entityId: topicIds[0] }, data: { qaFlags: ["QA_UNAVAILABLE"], repairAttempts: 0 } });
    const plan = await planRepairRun(db, CODE, { startedById: actor.id });
    await executeRun(db, plan.runId, { leaseOwner: "t-reqa" });
    const row = await db.translation.findFirstOrThrow({ where: { locale: CODE, entity: "TOPIC", entityId: topicIds[0] } });
    expect(row.repairAttempts).toBe(0);
    expect(aiJson).not.toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.objectContaining({ id: "translation.repair" }) }));
  });
});
```

- [ ] **Step 6: Run — PASS. Commit** — `spec-19: repair batch — finding fed back, always re-QA'd, never clobbers a human`

### Task 17: Chaining, the manual trigger, and the button

**Files:**
- Modify: `src/server/services/i18n/worker.ts` — `maybePlanRepair`, `defaultAfterRun`
- Modify: `src/server/services/i18n/run-control.ts` — `startBackgroundRun` handles `kind: "REPAIR"`
- Modify: `actions.ts` — `startRepairRunAction`; `language-board.tsx` — button; i18n
- Test: extend `worker.test.ts`

- [ ] **Step 1: Failing unit test** (stub db; `maybePlanRepair` takes injected `candidates`/`planner` so it stays pure). Extend the import at the top of `worker.test.ts` to `import { backoffMs, maybePlanRepair, runWorker, workerTick, type WorkerDeps } from "./worker";` and append:

```ts
describe("maybePlanRepair", () => {
  const base = { id: "r1", locale: "es", kind: "SYNC" as const, status: "COMPLETED", startedById: "u1", translatedUnits: 10, flaggedUnits: 2, failedUnits: 0, error: null };
  it("chains a repair after a sync that left flagged units", async () => {
    const plan = vi.fn(async () => ({ runId: "r2", plannedUnits: 2 }));
    expect(await maybePlanRepair(base, { candidates: async () => 2, exhausted: async () => 0, plan })).toEqual({ action: "planned", runId: "r2", planned: 2 });
  });
  it("does not chain when a repair made no progress (provider down), and reports it", async () => {
    const plan = vi.fn();
    expect(await maybePlanRepair({ ...base, kind: "REPAIR", translatedUnits: 2, flaggedUnits: 2 }, { candidates: async () => 2, exhausted: async () => 0, plan })).toEqual({ action: "stalled" });
    expect(plan).not.toHaveBeenCalled();
  });
  it("reports exhaustion once nothing is under the ceiling but flagged rows remain", async () => {
    expect(await maybePlanRepair({ ...base, kind: "REPAIR", flaggedUnits: 1 }, { candidates: async () => 0, exhausted: async () => 4, plan: vi.fn() })).toEqual({ action: "exhausted", remaining: 4 });
  });
  it("is a no-op for samples and failed runs", async () => {
    expect(await maybePlanRepair({ ...base, kind: "SAMPLE" }, { candidates: async () => 5, exhausted: async () => 0, plan: vi.fn() })).toEqual({ action: "none" });
    expect(await maybePlanRepair({ ...base, status: "FAILED" }, { candidates: async () => 5, exhausted: async () => 0, plan: vi.fn() })).toEqual({ action: "none" });
  });
});
```

- [ ] **Step 2: Implement in `worker.ts`**

```ts
export type RepairDecision =
  | { action: "none" }
  | { action: "planned"; runId: string; planned: number }
  | { action: "exhausted"; remaining: number }
  | { action: "stalled" };

export interface RepairPorts {
  candidates: () => Promise<number>;
  exhausted: () => Promise<number>;
  plan: () => Promise<{ runId: string; plannedUnits: number }>;
}

/**
 * After a run completes: repair what QA flagged, but never hot-loop. A repair that fixed nothing
 * (provider down, or nothing fixable) stops the chain; the admin re-enqueues once it is.
 */
export async function maybePlanRepair(run: FinishedRun, ports: RepairPorts): Promise<RepairDecision> {
  if (run.status !== "COMPLETED") return { action: "none" };
  if (!["SYNC", "FULL", "SINGLE_ENTITY", "REPAIR"].includes(run.kind)) return { action: "none" };
  if (run.kind === "REPAIR" && run.translatedUnits - run.flaggedUnits <= 0) return { action: "stalled" };
  const candidates = await ports.candidates();
  if (candidates === 0) {
    const remaining = await ports.exhausted();
    return run.kind === "REPAIR" && remaining > 0 ? { action: "exhausted", remaining } : { action: "none" };
  }
  const plan = await ports.plan();
  return { action: "planned", runId: plan.runId, planned: plan.plannedUnits };
}

export function repairPortsFor(db: PrismaClient, run: FinishedRun): RepairPorts {
  return {
    candidates: async () => (await repairCandidates(db, run.locale)).length,
    exhausted: () => db.translation.count({ where: { locale: run.locale, status: "NEEDS_REVIEW", entity: { not: "ITEM_VARIANT" }, repairAttempts: { gte: MAX_REPAIR_ATTEMPTS } } }),
    plan: () => planRepairRun(db, run.locale, { startedById: run.startedById }),
  };
}
```

and `defaultAfterRun` becomes:

```ts
export function defaultAfterRun(deps: { db: PrismaClient; log: WorkerLog }): (run: FinishedRun) => Promise<void> {
  return async (run) => {
    const decision = await maybePlanRepair(run, repairPortsFor(deps.db, run));
    deps.log.info({ runId: run.id, locale: run.locale, kind: run.kind, status: run.status, decision }, "run finished");
    // Task 21 adds: await notifyRunEvent(deps.db, run, decision);
  };
}
```

- [ ] **Step 3: `startBackgroundRun` — REPAIR branch** (before the `planRun` call):

```ts
  const plan =
    input.kind === "REPAIR"
      ? await planRepairRun(db, input.locale, { startedById: actor.id })
      : await planRun(db, input.locale, {
          kind: input.kind ?? (input.only ? "SINGLE_ENTITY" : "SYNC"),
          ...(input.only ? { only: input.only } : {}),
          startedById: actor.id,
          enqueue: true,
        });
```

- [ ] **Step 4: Action + button** — `startRepairRunAction` mirrors `startBackgroundRunAction` with `kind: "REPAIR"` and no `only`. In the board's coverage block (`:144-180`), when `language.coverage.flagged > 0 && !latestRun-is-live`:

```tsx
<form action={repairAction}>
  <input type="hidden" name="code" value={language.code} />
  <SubmitButton className="h-9" variant="outline" label={t("repairFlagged", { count: language.coverage.flagged })} pendingLabel={t("starting")} />
</form>
```

i18n: `repairFlagged` "Repair {count} flagged in background" / "Reparer {count} merkede i bakgrunnen".

- [ ] **Step 5: Tests + typecheck + browser check (flag a unit by hand, click Repair, watch the REPAIR run in the panel). Commit** — `spec-19: repair chains after a run and can be started by hand`

### Task 18: The invariant the whole spec protects

**Files:**
- Test: extend `src/server/services/i18n/languages.integration.test.ts` (or a new `review.integration.test.ts`)

- [ ] Add: seed one `MACHINE` row with `qaFlags: []`, one `NEEDS_REVIEW` with `qaFlags: ["NUMBER_DRIFT"], repairAttempts: 3`; call `bulkApproveTranslations(db, actor, { locale: CODE })`; assert `{ approved: 1, skipped: 1 }` and the flagged row is still `NEEDS_REVIEW`. Also assert `bulkApproveInputSchema.parse({ locale: "x", includeFlagged: true })` throws.
- [ ] Update `specs/notes/spec-19-notes.md` with Phase 2 evidence; status board → phase 2 ✅. Commit — `spec-19: phase 2 verification evidence`

---

# Phase 3 — Readiness, notifications, sample run

### Task 19: Blockers in `languageCoverage`

**Files:**
- Modify: `src/server/services/i18n/languages.ts` (`LanguageCoverage`, `languageCoverage` `:76-153`)
- Modify: `src/server/services/i18n/review.ts` (`reviewQueue` `status?`)
- Test: `src/server/services/i18n/blockers.test.ts` (pure)

- [ ] **Step 1: Pure test**

```ts
import { describe, expect, it } from "vitest";
import { partitionBlockers } from "./languages";

const units = ["a", "b", "c", "d", "e", "f"].map((id) => ({ entity: "TOPIC" as const, entityId: id, sourceHash: `h-${id}` }));
const rows = new Map([
  ["TOPIC:a", { sourceHash: "h-a", status: "APPROVED" as const }],
  ["TOPIC:b", { sourceHash: "h-b", status: "MACHINE" as const }],
  ["TOPIC:c", { sourceHash: "h-c", status: "NEEDS_REVIEW" as const }],
  ["TOPIC:d", { sourceHash: "STALE", status: "APPROVED" as const }],
  // e: no row (failed), f: no row
]);

describe("publish blockers", () => {
  it("partitions every not-ready unit into exactly one bucket", () => {
    const blockers = partitionBlockers(units, rows, new Set(["TOPIC:e"]), true);
    expect(blockers).toEqual([
      { kind: "UNTRANSLATED", count: 2 }, // d (stale) + f
      { kind: "FAILED", count: 1 },       // e
      { kind: "FLAGGED", count: 1 },      // c
      { kind: "AWAITING_APPROVAL", count: 1 }, // b
    ]);
    const ready = 1; // a
    expect(blockers.reduce((s, b) => s + b.count, 0)).toBe(units.length - ready);
  });
  it("without approval, MACHINE is ready and the bucket disappears", () => {
    const blockers = partitionBlockers(units, rows, new Set(), false);
    expect(blockers.find((b) => b.kind === "AWAITING_APPROVAL")).toBeUndefined();
    expect(blockers.find((b) => b.kind === "FAILED")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Implement**

```ts
export type BlockerKind = "UNTRANSLATED" | "FAILED" | "FLAGGED" | "AWAITING_APPROVAL";
export interface Blocker { kind: BlockerKind; count: number; }
const BLOCKER_ORDER: BlockerKind[] = ["UNTRANSLATED", "FAILED", "FLAGGED", "AWAITING_APPROVAL"];

/**
 * Exactly what stands between this language and students, as a partition of (total − ready):
 * every unit that is not ready lands in one bucket and one only. `complete` is derived from this,
 * so the checklist and the publish gate cannot drift.
 */
export function partitionBlockers(
  units: Array<{ entity: TranslatableEntity; entityId: string; sourceHash: string }>,
  rows: Map<string, { sourceHash: string; status: TranslationStatus }>,
  failedKeys: Set<string>,
  requiresApproval: boolean,
): Blocker[] {
  const counts: Record<BlockerKind, number> = { UNTRANSLATED: 0, FAILED: 0, FLAGGED: 0, AWAITING_APPROVAL: 0 };
  for (const unit of units) {
    const key = `${unit.entity}:${unit.entityId}`;
    const row = rows.get(key);
    const fresh = row !== undefined && row.sourceHash === unit.sourceHash;
    if (!fresh) { counts[failedKeys.has(key) ? "FAILED" : "UNTRANSLATED"] += 1; continue; }
    if (row.status === "NEEDS_REVIEW" || row.status === "REJECTED") { counts.FLAGGED += 1; continue; }
    if (row.status === "MACHINE" && requiresApproval) counts.AWAITING_APPROVAL += 1;
  }
  return BLOCKER_ORDER.filter((k) => counts[k] > 0).map((k) => ({ kind: k, count: counts[k] }));
}
```

In `languageCoverage`, after the existing `rows` query, load the failed set:

```ts
  // Units the machine gave up on: SKIPPED jobs of the newest completed, non-sample run.
  // Index: TranslationRun[locale, status, createdAt]; TranslationJob[runId, state, entity].
  const lastRun = await db.translationRun.findFirst({ where: { locale, status: "COMPLETED", kind: { not: "SAMPLE" } }, orderBy: { createdAt: "desc" }, select: { id: true } });
  const failedKeys = new Set(
    lastRun ? (await db.translationJob.findMany({ where: { runId: lastRun.id, state: "SKIPPED", error: { notIn: ["cancelled", "superseded"] } }, select: { entity: true, entityId: true } })).map((j) => `${j.entity}:${j.entityId}`) : [],
  );
  const blockers = partitionBlockers(units, byKey, failedKeys, language.requiresApproval);
```

and return `{ …existing, blockers, complete: total > 0 && blockers.length === 0 }`. Built-in short-circuit returns `blockers: []`. Add a unit assertion in the integration suite that `ready === total` ⇔ `blockers.length === 0` on a real language.

`reviewQueue` — add `status?: TranslationStatus[]` to options; `status: options.status ? { in: options.status } : (existing expression)`.

`untranslatedUnits(db, locale, limit = 50)`:

```ts
export interface UntranslatedUnit { entity: TranslatableEntity; entityId: string; label: string; failed: boolean; error: string | null; }
export async function untranslatedUnits(db: PrismaClient, locale: string, limit = 50): Promise<UntranslatedUnit[]> {
  const language = await db.language.findUniqueOrThrow({ where: { code: locale }, select: { glossaryVersion: true } });
  const units = await extractAll(db, { glossaryVersion: language.glossaryVersion });
  const rows = await db.translation.findMany({ where: { locale }, select: { entity: true, entityId: true, sourceHash: true } });
  const fresh = new Set(rows.map((r) => `${r.entity}:${r.entityId}:${r.sourceHash}`));
  const lastRun = await db.translationRun.findFirst({ where: { locale, status: "COMPLETED", kind: { not: "SAMPLE" } }, orderBy: { createdAt: "desc" }, select: { id: true } });
  const failed = new Map(lastRun ? (await db.translationJob.findMany({ where: { runId: lastRun.id, state: "SKIPPED" }, select: { entity: true, entityId: true, error: true } })).map((j) => [`${j.entity}:${j.entityId}`, j.error]) : []);
  return units.filter((u) => !fresh.has(`${u.entity}:${u.entityId}:${u.sourceHash}`)).slice(0, limit)
    .map((u) => { const key = `${u.entity}:${u.entityId}`; return { entity: u.entity, entityId: u.entityId, label: u.label, failed: failed.has(key), error: failed.get(key) ?? null }; });
}
```

- [ ] **Step 3: PASS + full i18n suite. Commit** — `spec-19: coverage names its blockers`

### Task 20: Readiness checklist UI

**Files:**
- Create: `src/components/admin/languages/readiness-checklist.tsx`
- Modify: `src/app/[locale]/(admin)/admin/languages/[code]/page.tsx` (`searchParams` + coverage card `:87-122`)
- Modify: `language-board.tsx` (one-line summary under the coverage bar)
- i18n

- [ ] **Step 1: Component** (server-safe, no hooks):

```tsx
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import type { Blocker } from "@/server/services/i18n/languages";

export function ReadinessChecklist({ code, blockers, complete }: { code: string; blockers: Blocker[]; complete: boolean }) {
  const t = useTranslations("admin.languages.readiness");
  if (complete) return <p className="text-sm text-[var(--status-success-strong)]">{t("ready")}</p>;
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium text-foreground">{t("title")}</p>
      <ul className="space-y-1 text-sm">
        {blockers.map((b) => (
          <li key={b.kind}>
            <Link href={`/admin/languages/${code}?blocker=${b.kind}`} className="inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] px-2 hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring">
              <span className="tabular-nums font-medium">{b.count}</span>
              <span>{t(`kinds.${b.kind}`)}</span>
              <span className="text-xs text-muted-foreground">{t(`hints.${b.kind}`)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: `[code]/page.tsx`** — `searchParams: Promise<{ flagged?: string; blocker?: string }>`; derive the queue filter:

```ts
const blocker = query.blocker as BlockerKind | undefined;
const status = blocker === "FLAGGED" ? ["NEEDS_REVIEW", "REJECTED"] : blocker === "AWAITING_APPROVAL" ? ["MACHINE"] : undefined;
const listUntranslated = blocker === "UNTRANSLATED" || blocker === "FAILED";
const [t, coverage, rows, untranslated] = await Promise.all([
  getTranslations("admin.languages"), languageCoverage(db, code),
  listUntranslated ? [] : reviewQueue(db, code, { limit: 30, ...(status ? { status } : { onlyFlagged: flaggedOnly }) }),
  listUntranslated ? untranslatedUnits(db, code) : [],
]);
```

Render `<ReadinessChecklist code={code} blockers={coverage.blockers} complete={coverage.complete} />` inside the coverage card, and when `listUntranslated` render a simple list (`label`, and for `failed` the `error` in `text-destructive`) plus a "Start in background" form (reuse `startBackgroundRunAction`) instead of `<TranslationReview>`. Filter `failed` only when `blocker === "FAILED"`.

Board: under the coverage bar, `{language.coverage.blockers.map((b) => `${b.count} ${t(`readiness.kinds.${b.kind}`)}`).join(" · ")}` in `text-xs text-muted-foreground`.

- [ ] **Step 3: i18n** `admin.languages.readiness`: `title` "Blocking publication" / "Hindrer publisering"; `ready` "Nothing blocks publishing — every unit is servable." / "Ingenting hindrer publisering — hver enhet kan vises."; `kinds.UNTRANSLATED` "untranslated" / "uoversatt"; `kinds.FAILED` "gave up after 3 tries" / "oppgitt etter 3 forsøk"; `kinds.FLAGGED` "held by a check" / "holdt av en kontroll"; `kinds.AWAITING_APPROVAL` "awaiting approval" / "venter på godkjenning"; `hints.UNTRANSLATED` "start a run" / "start en kjøring"; `hints.FAILED` "see why, then re-run" / "se hvorfor, kjør igjen"; `hints.FLAGGED` "repair or review" / "reparer eller vurder"; `hints.AWAITING_APPROVAL` "approve, or turn approval off" / "godkjenn, eller slå av godkjenning".
- [ ] **Step 4: Browser check: each line filters correctly; the Show toggle unlocks exactly when the list empties. Commit** — `spec-19: publish-readiness checklist`

### Task 21: Notifications

**Files:**
- Modify: `src/server/email/templates.ts` — three templates
- Modify: `src/server/services/i18n/notify.ts` — `notifyRunEvent`
- Modify: `worker.ts` `defaultAfterRun`
- i18n `emails.i18nRun.*`
- Test: `src/server/services/i18n/notify.test.ts` (uses `capturedMail()`; DB-backed for recipients — same fixture)

- [ ] **Step 1: Failing test**

```ts
it("emails the starter in their language when a run finishes, and every admin when nobody started it", async () => {
  clearCapturedMail();
  await notifyRunEvent(db, { id: "r", locale: CODE, kind: "SYNC", status: "COMPLETED", startedById: actor.id, translatedUnits: 9, flaggedUnits: 1, failedUnits: 0, error: null }, { action: "none" });
  expect(capturedMail()).toHaveLength(1);
  expect(capturedMail()[0].to).toBe(actor.email);
  expect(capturedMail()[0].subject).toMatch(/finished/i);
  expect(capturedMail()[0].text).toContain(`/admin/languages/${CODE}`);
  clearCapturedMail();
  await notifyRunEvent(db, { id: "r", locale: CODE, kind: "REPAIR", status: "COMPLETED", startedById: null, translatedUnits: 2, flaggedUnits: 2, failedUnits: 0, error: null }, { action: "exhausted", remaining: 2 });
  expect(capturedMail().length).toBeGreaterThanOrEqual(1);
  expect(capturedMail()[0].subject).toMatch(/need a reviewer|review/i);
});
```

- [ ] **Step 2: Templates** (house pattern from `verificationEmail`, `templates.ts:74-96`):

```ts
export async function runFinishedEmail(locale: Locale, to: string, p: { language: string; url: string; completed: number; flagged: number; failed: number }): Promise<MailMessage> {
  const translate = await t(locale);
  return { to, subject: translate("i18nRun.finished.subject", { language: p.language }), ...render({
    heading: translate("i18nRun.finished.heading", { language: p.language }),
    body: translate("i18nRun.finished.body", { completed: String(p.completed), flagged: String(p.flagged), failed: String(p.failed) }),
    ctaLabel: translate("i18nRun.cta"), ctaUrl: p.url, footer: translate("i18nRun.footer"), fallback: translate("common.linkFallback") }) };
}
export async function runFailedEmail(locale: Locale, to: string, p: { language: string; url: string; error: string }): Promise<MailMessage> {
  const translate = await t(locale);
  return { to, subject: translate("i18nRun.failed.subject", { language: p.language }), ...render({
    heading: translate("i18nRun.failed.heading"),
    body: translate("i18nRun.failed.body", { error: p.error.slice(0, 200) }),
    ctaLabel: translate("i18nRun.cta"), ctaUrl: p.url, footer: translate("i18nRun.footer"), fallback: translate("common.linkFallback") }) };
}

export async function repairOutcomeEmail(locale: Locale, to: string, p: { language: string; url: string; remaining: number; stalled: boolean }): Promise<MailMessage> {
  const translate = await t(locale);
  const remaining = String(p.remaining);
  return { to, subject: translate("i18nRun.repair.subject", { language: p.language, remaining }), ...render({
    heading: translate("i18nRun.repair.heading"),
    body: translate(p.stalled ? "i18nRun.repair.bodyStalled" : "i18nRun.repair.body", { remaining }),
    ctaLabel: translate("i18nRun.cta"), ctaUrl: p.url, footer: translate("i18nRun.footer"), fallback: translate("common.linkFallback") }) };
}
```

- [ ] **Step 3: `notifyRunEvent(db, run: FinishedRun, decision: RepairDecision)`** in `notify.ts`:

```ts
export async function notifyRunEvent(db: PrismaClient, run: FinishedRun, decision: RepairDecision): Promise<void> {
  if (run.kind === "SAMPLE" || decision.action === "planned") return; // the chained run reports
  const language = await db.language.findUnique({ where: { code: run.locale }, select: { englishName: true } });
  const name = language?.englishName ?? run.locale;
  for (const recipient of await notificationRecipients(db, run.startedById)) {
    const url = absoluteUrl(env().APP_BASE_URL, recipient.locale, `/admin/languages/${run.locale}`);
    const message =
      run.status === "FAILED" ? await runFailedEmail(recipient.locale, recipient.email, { language: name, url, error: run.error ?? "" })
      : decision.action === "exhausted" ? await repairOutcomeEmail(recipient.locale, recipient.email, { language: name, url, remaining: decision.remaining, stalled: false })
      : decision.action === "stalled" ? await repairOutcomeEmail(recipient.locale, recipient.email, { language: name, url, remaining: run.flaggedUnits, stalled: true })
      : run.status === "COMPLETED" ? await runFinishedEmail(recipient.locale, recipient.email, { language: name, url, completed: run.translatedUnits, flagged: run.flaggedUnits, failed: run.failedUnits })
      : null;
    if (message) await sendMail(message);
  }
}
```

Wire it into `defaultAfterRun` (the line reserved in Task 17). `FinishedRun`/`RepairDecision` are imported from `./worker` — to avoid a cycle, move those two types into `./worker-types.ts` and re-export from `worker.ts`.

- [ ] **Step 4: i18n `emails.i18nRun`** (en / nb): `cta` "Open the language" / "Åpne språket"; `footer` "Sent by the translation worker." / "Sendt av oversettelsesarbeideren."; `finished.subject` "{language} translation finished" / "Oversettelsen av {language} er ferdig"; `finished.heading` "{language} is translated" / "{language} er oversatt"; `finished.body` "{completed} units translated · {flagged} held for review · {failed} failed." / "{completed} enheter oversatt · {flagged} til vurdering · {failed} feilet."; `failed.subject` "{language} translation run failed" / "Oversettelseskjøringen for {language} feilet"; `failed.heading` "The run stopped" / "Kjøringen stoppet"; `failed.body` "The worker gave up on this run: {error}. It can be started again from the language page." / "Arbeideren ga opp denne kjøringen: {error}. Den kan startes igjen fra språksiden."; `repair.subject` "{language}: {remaining} translations need a reviewer" / "{language}: {remaining} oversettelser trenger en vurderer"; `repair.heading` "Repair is done with what it can do" / "Reparasjonen er ferdig med det den kan"; `repair.body` "{remaining} units failed automated repair three times and are waiting in the review queue." / "{remaining} enheter feilet automatisk reparasjon tre ganger og venter i vurderingskøen."; `repair.bodyStalled` "The repair run could not fix anything — usually the AI provider is unavailable. {remaining} units are still held. Start it again from the language page when the provider is back." / "Reparasjonskjøringen klarte ikke å rette noe — vanligvis er KI-leverandøren utilgjengelig. {remaining} enheter holdes fortsatt. Start igjen fra språksiden når leverandøren er tilbake."
- [ ] **Step 5: PASS. Commit** — `spec-19: run outcome emails`

### Task 22: Sample-first dry run

**Files:**
- Create: `src/server/services/i18n/sample.ts`
- Modify: `run-control.ts` (`startBackgroundRun` `kind: "SAMPLE"` → `planSampleRun`), `actions.ts` (`startSampleRunAction`, `sampleResultsAction`), `language-board.tsx` (button + `<SampleResults>`)
- Create: `src/components/admin/languages/sample-results.tsx`
- Test: `src/server/services/i18n/sample.integration.test.ts`

- [ ] **Step 1: Failing test**

```ts
it("plans about five units spread across entity kinds, and reports them beside the source", async () => {
  const plan = await planSampleRun(db, CODE, { size: 5, startedById: actor.id });
  expect(plan.plannedUnits).toBeGreaterThan(0);
  expect(plan.plannedUnits).toBeLessThanOrEqual(5);
  expect(Object.keys(plan.byEntity).length).toBeGreaterThan(1); // more than one kind when the bank has them
  await executeRun(db, plan.runId, { leaseOwner: "t-sample" });
  const results = await sampleResults(db, plan.runId);
  expect(results.status).toBe("COMPLETED");
  expect(results.items.length).toBe(plan.plannedUnits);
  expect(results.items[0]).toMatchObject({ source: expect.any(Object), value: expect.any(Object) });
  const language = await db.language.findUniqueOrThrow({ where: { code: CODE }, select: { lastSyncedAt: true } });
  expect(language.lastSyncedAt).toBeNull(); // a sample is not a sync
});
```

- [ ] **Step 2: Implement `sample.ts`**

```ts
import type { PrismaClient, TranslatableEntity } from "@prisma/client";
import { extractAll, pendingUnits } from "./extract";
import { sourceFor } from "./review";
import { ESTIMATED_USD_PER_1K_TOKENS } from "./run-math";
import type { RunPlan } from "./runs";
import type { TranslationUnit, UnitPayload } from "./units";

export async function planSampleRun(db: PrismaClient, locale: string, input: { size?: number; startedById: string | null }): Promise<RunPlan> {
  const size = input.size ?? 5;
  const language = await db.language.findUniqueOrThrow({ where: { code: locale }, select: { glossaryVersion: true } });
  const all = await extractAll(db, { glossaryVersion: language.glossaryVersion });
  const pending = await pendingUnits(db, locale, all);
  // Round-robin across entity kinds so a 5-unit sample shows a question, a topic, a sign, a
  // message… rather than five UI strings.
  const byEntity = new Map<TranslatableEntity, TranslationUnit[]>();
  for (const unit of pending) byEntity.set(unit.entity, [...(byEntity.get(unit.entity) ?? []), unit]);
  const chosen: TranslationUnit[] = [];
  const queues = [...byEntity.values()];
  for (let i = 0; chosen.length < size && queues.some((q) => q.length > 0); i++) {
    const queue = queues[i % queues.length];
    const next = queue.shift();
    if (next) chosen.push(next);
  }
  const run = await db.translationRun.create({ data: { locale, kind: "SAMPLE", status: "PENDING", plannedUnits: chosen.length, startedById: input.startedById, estimatedUsd: ((chosen.length * 680) / 1000) * ESTIMATED_USD_PER_1K_TOKENS, enqueuedAt: new Date() }, select: { id: true, estimatedUsd: true } });
  if (chosen.length > 0) await db.translationJob.createMany({ data: chosen.map((u) => ({ runId: run.id, entity: u.entity, entityId: u.entityId, sourceHash: u.sourceHash })) });
  const counts: Record<string, number> = {};
  for (const u of chosen) counts[u.entity] = (counts[u.entity] ?? 0) + 1;
  return { runId: run.id, locale, plannedUnits: chosen.length, byEntity: counts, estimatedPromptTokens: chosen.length * 420, estimatedCompletionTokens: chosen.length * 260, estimatedUsd: run.estimatedUsd };
}

export interface SampleItem { entity: TranslatableEntity; entityId: string; label: string; source: UnitPayload | null; value: UnitPayload | null; status: string | null; qaFlags: string[]; }
export interface SampleResultsView { runId: string; status: string; items: SampleItem[]; }

/** Joined through the run's jobs, not `Translation.runId` — a later sync would re-stamp that. */
export async function sampleResults(db: PrismaClient, runId: string): Promise<SampleResultsView> {
  const run = await db.translationRun.findUniqueOrThrow({ where: { id: runId }, select: { locale: true, status: true, jobs: { select: { entity: true, entityId: true }, orderBy: { entity: "asc" } } } });
  const rows = await db.translation.findMany({ where: { locale: run.locale, OR: run.jobs.map((j) => ({ entity: j.entity, entityId: j.entityId })) }, select: { entity: true, entityId: true, value: true, status: true, qaFlags: true } });
  const byKey = new Map(rows.map((r) => [`${r.entity}:${r.entityId}`, r]));
  const items = await Promise.all(run.jobs.map(async (job) => {
    const row = byKey.get(`${job.entity}:${job.entityId}`);
    return { entity: job.entity, entityId: job.entityId, label: job.entityId, source: await sourceFor(db, job.entity, job.entityId), value: (row?.value as UnitPayload | undefined) ?? null, status: row?.status ?? null, qaFlags: row?.qaFlags ?? [] };
  }));
  return { runId, status: run.status, items };
}
```

- [ ] **Step 3: Wiring** — `startBackgroundRun` gains `kind === "SAMPLE" → planSampleRun`; actions `startSampleRunAction` (form with `code`) and `sampleResultsAction(runId)` (read-only). `sample-results.tsx` polls `sampleResultsAction` every 3 s until `status` is terminal, then renders a two-column grid per item (copy the layout from `translation-review.tsx:192-255`, `lang`/`dir` on the right pane, QA chips from `FLAG_KEYS`). The board's plan card gets a third form "Translate 5 as a sample" (`sampleFirst` / "Oversett 5 som prøve") and renders `<SampleResults runId={sampleState.data.runId} />` under it when started.
- [ ] **Step 4: PASS + browser check. Commit** — `spec-19: sample-first dry run`

### Task 23: Final verification, deploy runbook, status board

- [ ] `pnpm test` (with dev DB up) — all green; `pnpm exec tsc --noEmit && pnpm exec eslint && pnpm build` — clean.
- [ ] Walk the spec's acceptance checklist item by item into `specs/notes/spec-19-notes.md` with evidence: test names, the `kill -9` experiment, screenshots of the panel at 390 px in `en` and `nb`, the stale-heartbeat state (stop the worker mid-run and wait 3 min), the readiness list emptying exactly when the Show toggle unlocks, captured emails.
- [ ] Deploy runbook (append to the notes; execute with the user's `ai-dev` password — see memory `vps-production-deployment`): `git push origin main`; on the VPS `cd ~/applications/driving-school && cp ecosystem.config.cjs ecosystem.config.cjs.pre-spec19 && git pull && pnpm install && pnpm prisma generate && pnpm prisma migrate deploy && pnpm build && diff ecosystem.config.cjs.pre-spec19 ecosystem.config.cjs; pm2 startOrReload ecosystem.config.cjs --update-env && pm2 save && pm2 logs teoripro-i18n-worker --lines 20`; confirm the board chip shows "Background worker online".
- [ ] `specs/README.md` row 19 → ✅ Done; `DECISIONS.md` entries confirmed. Commit — `spec-19: verification evidence — all checklist items PASS`.

---

## Verification (end-to-end)

1. **Unit + integration:** `docker compose -f docker-compose.dev.yml up -d db redis && pnpm test` — new suites: `deadline`, `run-math`, `runs.integration`, `run-control.integration`, `worker`, `repair`, `repair.integration`, `blockers`, `notify`, `sample.integration`, `prompts/translation`.
2. **The worker for real:** `pnpm dev` + `pnpm i18n:worker`; add a language; Plan → Start in background; close the tab; reopen; the panel has advanced. `kill -9` the worker mid-run; restart; `SELECT state, count(*) FROM "TranslationJob" WHERE "runId"=… GROUP BY 1` shows no `RUNNING`, and `SELECT count(*) FROM "Translation" WHERE locale=…` equals the planned units (nothing doubled).
3. **Layer 0 against a live hang:** `node -e 'require("http").createServer(()=>{}).listen(9999)'`, add an OpenAI-compatible provider with base URL `http://127.0.0.1:9999/v1`, Test connection → fails within `pingTimeoutMs` with "no response within …ms", not a hang.
4. **Repair:** hand-flag a row (`UPDATE "Translation" SET status='NEEDS_REVIEW', "qaFlags"='{NUMBER_DRIFT}' …`), click Repair, watch the REPAIR run, confirm the row returns to `MACHINE` with `repairAttempts=1`; set `repairAttempts=3`, confirm it is left for the queue and the exhaustion email lands in Mailpit (`http://localhost:8025`, `MAIL_TRANSPORT=smtp`, `SMTP_URL=smtp://localhost:1025`).
5. **Accessibility:** keyboard through Start / Pause / Resume / Cancel / checklist links; `aria-live` panel announces status changes; 390 px layout; `nb` locale.

