# Spec-19 Amendment A — Translation Throughput · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]` checkboxes.
>
> **On approval:** copy to `specs/plans/spec-19a-throughput-plan.md`; add an amendment section "A — throughput (2026-09-09)" to `specs/spec-19-translation-automation.md`; log the decisions in §"Decisions" to `DECISIONS.md`; status board row 19 → 🔨 amendment A in progress.

**Goal:** Take a Spanish translation run from 3.2 units/min to well over 100 units/min without lowering accuracy — first by fixing where the QA check runs (no code), then by removing the structural limits in the runner.

**Architecture:** Nothing new. The runner gains N in-flight batches with a per-slot claim token, batches grow from 5 to a config-driven 20 with truncation-aware halving, and the per-batch overhead that is O(whole bank) becomes O(batch). The QA bar is untouched: every unit still passes the same deterministic checks and the same semantic check at the same threshold.

**Tech stack:** unchanged (Prisma 6.19, Node 24, vitest). Touches `runs.ts`, `translate.ts`, `qa.ts`, `extract.ts`, `memory.ts`, `run-math.ts`, the three adapters, `client.ts`, `school.config.ts`.

---

## Context — where the 94 seconds actually go

Measured on the live Spanish run (worker log, 38 AI calls over 19 batches; batch cadence 96 s):

| Call                                                                          | Route                           | Calls           | avg        | p95   | Share of batch |
| ----------------------------------------------------------------------------- | ------------------------------- | --------------- | ---------- | ----- | -------------- |
| Back-translation QA (`task: validation`)                                      | **Teori2 / ollama gemma4-fast** | 17              | **82.8 s** | 117 s | **88%**        |
| Back-translation fallback (after the gateway returned a Cloudflare HTML page) | Teori2 / gemma4:e4b-it-qat      | 1               | 240 s      | —     | —              |
| Translation (`task: translation`)                                             | Gemini / gemini-3.5-flash-lite  | 20              | **3.6 s**  | 4.5 s | 4%             |
| Embeddings                                                                    | Gemini                          | —               | ~0.6 s     | —     | <1%            |
| DB + bank re-extract + bookkeeping                                            | —                               | ~22 round trips | ~5 s       | —     | ~6%            |

**Your instinct was right: the AI translates 5 questions in 3.6 seconds.** The 94 seconds is the _verification_ of that translation running on the self-hosted model — a second full generation, serial, on hardware that also returned an HTML error page mid-run.

The "77% held for review" decomposes the same way: 62 of 64 flags are `QA_UNAVAILABLE` from batches that ran before the `EMBEDDING` route existed (added 10:29 UTC, mid-run). Since then: 0–2 of 5 flagged per batch, all `ANSWER_PERMUTED` — a ~7% real rate. The 62 stale ones are cleared by the repair pass at no model cost (`isReQaOnly`).

Code-level facts the plan builds on (from the trace; file:line cited in tasks): three AI calls per batch, strictly serial; batches strictly serial; `unitsFor` re-loads all 529 approved questions (~690 KB) every batch to keep 5; `storeTranslations` is 5 sequential upserts; `BATCH_SIZE = 5` uses ~15% of the 8192-token output window; no adapter reads `finish_reason`, so an oversized batch fails 3× at full cost; in-process parallel claims are unsafe today because both slots share `leaseOwner` and the read-back returns the winner's rows to the loser; the EWMA is a read-modify-write across two queries.

**Decisions (user, 2026-09-09):** VALIDATION → Gemini flash-lite; 3 parallel slots.

## Decisions to log in `DECISIONS.md`

1. Back-translation QA is routed to the same fast hosted model as translation. The self-hosted route stays on GENERATION only. Rationale: 88% of batch time, plus one Cloudflare error → 240 s fallback in a 19-batch sample.
2. `translationMaxTokens` defaults to **8192, not 16384**: Gemini _2.0_ Flash-Lite rejects >8192 with a non-retryable 400 that would FAIL every batch three times; 20 Spanish units need ~5100 at p90 (60% headroom), and truncation-halving covers non-Latin scripts. Raise only after verifying the routed model's cap.
3. `LENGTH_OUTLIER` stays in `qaFlags` (it is the reviewer's only view of it and the bulk-approve guard keys on `qaFlags`); only the "force a semantic check" gate switches to blocking codes.
4. Truncation halves the run's shared batch size and re-queues without charging an attempt; a single-unit truncation is a real failure (prevents an infinite loop).
5. Mid-run rejections reach the prompt on the next run, not the next batch (`recentRejections` computed once per run).

---

## Step 0 — Routing (config, no code, do this first)

In `/admin/ai` → Routes (or via `upsertRoute`/`deleteRoute` in a script):

- [ ] **Add** `VALIDATION` → provider `Gemini`, model `gemini-3.5-flash-lite`, priority `0`.
- [ ] **Remove** the two `VALIDATION` routes on `Teori2` (`ollama/gemma4-fast:latest`, `ollama/gemma4:e4b-it-qat`). They are priority 0 too and the chain order between equal priorities is undefined; leaving them means Ollama may still win. (If a free fallback is wanted later, re-add one at priority `10`.)
- [ ] `upsertRoute`/`deleteRoute` call `invalidateRoutes()`, so **the live run switches within one batch** — watch the panel's rate climb from ~3/min toward ~30/min with no restart.

Expected after Step 0 alone: 3.6 + ~3.5 + 0.6 + ~2 ≈ **10 s per batch of 5 → ~30 units/min** (9–10×). Spanish's remaining ~740 units finish in ~25 minutes instead of ~4 hours.

Also, once the run has finished and the readiness list confirms the real flag rate is low: consider `qaSampleRate` for `es` from 1 → 0.2 in the language settings. **Not part of this plan** — it trades scrutiny on 80% of units for speed and is your call, not a code change. Everything below is accuracy-neutral.

---

## Conventions

Same as the spec-19 plan: `requireUser` outside `try`; conditional-spread for optionals (`exactOptionalPropertyTypes`); both locales for any i18n key (none expected here); every new query states its index; commit per task as `spec-19a: <clause>`; TDD — failing test first.

---

# Tasks

### Task 1: Throughput knobs in school config

**Files:** `config/school.config.ts` (schema `ai` block + literal), `config/school.config.test.ts`

- [ ] **Test first** — append:

```ts
it("translation batch fits the output cap with headroom, and slots are bounded (spec-19a)", () => {
  const {
    translationBatchSize,
    translationMaxTokens,
    translationParallelSlots,
  } = schoolConfig.ai;
  // ~255 completion tokens per Spanish question at p90; 300 leaves margin for verbose models.
  expect(translationBatchSize * 300).toBeLessThanOrEqual(translationMaxTokens);
  expect(translationParallelSlots).toBeGreaterThanOrEqual(1);
  expect(translationParallelSlots).toBeLessThanOrEqual(4); // default Prisma pool is 5 on 2 vCPUs
});
```

- [ ] **Schema** (after `pingTimeoutMs`):

```ts
      /** Units per translation call. 20 fits the output window with headroom for Latin scripts;
       *  non-Latin scripts start at half and the runner halves further on truncation. */
      translationBatchSize: z.number().int().min(1).max(50),
      /** Output cap per translation call. Must not exceed the routed model's own cap — Gemini 2.0
       *  Flash-Lite rejects >8192 with a non-retryable 400. Raise only after verifying the route. */
      translationMaxTokens: z.number().int().min(1024),
      /** Batches in flight inside one run. Keep ≤ (DB pool − 2). */
      translationParallelSlots: z.number().int().min(1).max(8),
```

**Literal:** `translationBatchSize: 20, translationMaxTokens: 8192, translationParallelSlots: 3,`

- [ ] PASS + `tsc`. **Commit** — `spec-19a: batch size, output cap and parallel slots are config`

### Task 2: Truncation is a typed, non-retryable error in every adapter

**Files:** `src/server/ai/providers/types.ts`, `openai-compatible.ts` (`chatSchema` ~:21-32, after the parse ~:75), `google.ts` (`responseSchema` ~:32-48, after parse ~:117), `anthropic.ts` (`stop_reason`), `src/server/ai/client.ts` (`withFallback` ~:129)
**Tests:** extend `openai-compatible.test.ts`; new `google.test.ts`; new `client.test.ts`

- [ ] **Tests first**

`openai-compatible.test.ts`:

```ts
it("maps finish_reason=length to a non-retryable ProviderTruncatedError", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ...COMPLETION,
            choices: [
              {
                index: 0,
                finish_reason: "length",
                message: { role: "assistant", content: '{"units":[{' },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 4096 },
          }),
          { status: 200 },
        ),
    ),
  );
  await expect(
    openAiCompatibleAdapter.chat(CREDENTIALS, {
      model: "m",
      messages: [{ role: "user", content: "x" }],
      maxTokens: 4096,
    }),
  ).rejects.toSatisfy(
    (e: unknown) =>
      e instanceof ProviderTruncatedError &&
      !e.retryable &&
      e.status === 200 &&
      e.completionTokens === 4096,
  );
});
it("finish_reason=stop is not an error", async () => {
  /* COMPLETION as-is → resolves with text "hello" */
});
```

`google.test.ts` (new; same `vi.stubGlobal("fetch")` pattern; read `google.ts` for the exact request/response shape first):

```ts
it("a MAX_TOKENS candidate with no content.parts throws ProviderTruncatedError, not a ZodError", …);
it("a MAX_TOKENS candidate with partial parts throws ProviderTruncatedError", …);
it("passes maxTokens through as generationConfig.maxOutputTokens", …);  // assert body
it("a STOP candidate parses as before", …);
```

`client.test.ts` (new): mock `@/server/services/ai/providers` `resolveRoutes` to return two candidates and `adapterFor` to return a fake whose first `chat` throws `new ProviderTruncatedError(8192, 8192)`; assert `aiJson` rejects with **that same instance** and the second candidate's `chat` was never called.

- [ ] **`types.ts`** — after `ProviderError`:

```ts
/**
 * The model hit `maxTokens` before it finished. Not retryable on purpose: fallback routes around a
 * PROVIDER fault (429/5xx); a truncation is a REQUEST fault — the prompt is too large for the cap —
 * and every other route would truncate at the same cap or 400. The runner halves the batch instead.
 * status 200: the HTTP exchange succeeded; the class is the discriminator.
 */
export class ProviderTruncatedError extends ProviderError {
  constructor(
    readonly maxTokens: number | undefined,
    readonly completionTokens: number,
  ) {
    super(
      `output truncated at ${completionTokens} tokens (cap ${maxTokens ?? "default"})`,
      200,
      false,
    );
    this.name = "ProviderTruncatedError";
  }
}
```

- [ ] **`openai-compatible.ts`** — `chatSchema` choice gains `finish_reason: z.string().nullable().optional()`; after parsing:

```ts
const choice = parsed.choices[0];
if (choice.finish_reason === "length")
  throw new ProviderTruncatedError(
    request.maxTokens,
    parsed.usage?.completion_tokens ?? 0,
  );
```

- [ ] **`google.ts`** — `responseSchema` must tolerate a candidate without `content`/`parts` so the reason can be read before anything throws:

```ts
const responseSchema = z.object({
  candidates: z.array(z.object({
    content: z.object({ parts: z.array(z.object({ text: z.string().optional() })).optional() }).optional(),
    finishReason: z.string().optional(),
  })).min(1),
  usageMetadata: /* unchanged */,
});
// after parse:
const candidate = parsed.candidates[0];
if (candidate.finishReason === "MAX_TOKENS")
  throw new ProviderTruncatedError(request.maxTokens, parsed.usageMetadata?.candidatesTokenCount ?? 0);
const text = (candidate.content?.parts ?? []).map((p) => p.text ?? "").join("");
```

- [ ] **`anthropic.ts`** — `if (parsed.stop_reason === "max_tokens") throw new ProviderTruncatedError(request.maxTokens, parsed.usage?.output_tokens ?? 0);` (read its schema for the exact field names).

- [ ] **`client.ts` `withFallback`** — first line of the `catch`:

```ts
// A truncation must reach the runner as itself: it halves the batch, it does not try route 2.
if (error instanceof ProviderTruncatedError) throw error;
```

- [ ] PASS (`pnpm vitest run src/server/ai`) + `tsc`. **Commit** — `spec-19a: truncation surfaces as a typed error and skips the fallback chain`

### Task 3: Embed in chunks of ≤100 (Google's `batchEmbedContents` limit)

**Files:** `src/server/services/i18n/qa.ts` (~:197-201)
**Test:** `src/server/services/i18n/qa.test.ts` (new; `vi.mock("@/server/ai/client")`)

- [ ] **Test:** 20 question units × 4 options → 200 texts; assert `aiEmbed` called twice with 100 and 100 and every unit gets a score/pairing.
- [ ] **Code:**

```ts
const EMBED_CHUNK = 100; // Google batchEmbedContents caps requests per call at 100
async function embedAll(
  texts: string[],
  signal?: AbortSignal,
): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_CHUNK)
    out.push(
      ...(await aiEmbed(
        texts.slice(i, i + EMBED_CHUNK),
        signal ? { signal } : {},
      )),
    );
  return out;
}
```

Replace the single `aiEmbed(texts, …)` with `embedAll(texts, input.signal)`. Without this, batch 20 at `qaSampleRate 1` would 400 and flag all 20 `QA_UNAVAILABLE` — a silent accuracy regression that looks like an outage.

- [ ] PASS. **Commit** — `spec-19a: embeddings in chunks of 100`

### Task 4: `extractAll` takes `ids` — O(batch), not O(bank)

**Files:** `src/server/services/i18n/extract.ts` (`ExtractOptions` ~:240, each `extract*` ~:90-230, `extractAll` ~~:247-266), `runs.ts` `unitsFor` (~~:840-852)
**Test:** `src/server/services/i18n/extract.integration.test.ts` (new; `describe.skipIf(!TEST_DATABASE_URL)`)

- [ ] **Tests:** `extractAll with ids returns only those units`; `with ids and only for another entity returns []`; `extractSigns with ids issues WHERE id IN` (spy on `db.sign.findMany` first-arg `where.id.in`); `extractMessages honours ids`.
- [ ] **Code:** `ExtractOptions` += `ids?: string[]`; every extractor gains `ids?: string[]` and adds `...(ids ? { id: { in: ids } } : {})` to its `where` (`extractKbSources` keys on `code`; `extractMessages` filters keys in-process); `extractAll` threads `options.ids`. `unitsFor`:

```ts
const all = await extractAll(db, {
  glossaryVersion: language.glossaryVersion,
  only: [entity],
  ids,
});
const wanted = new Set(ids);
return all.filter((unit) => wanted.has(unit.entityId));
```

Removes ~690 KB read + 529 sha256 per batch (2 MB/round at 3 slots). Indexes: primary keys.

- [ ] PASS. **Commit** — `spec-19a: a batch extracts only its own units`

### Task 5: Batched writes, rejections once per run, progress from counters

**Files:** `translate.ts` (`storeTranslations` ~:312-372, `recentRejections` ~:95-115, `translateBatch` options), `memory.ts` (new `rememberTranslations`), `runs.ts` (`translateSlice`, `onProgress`)
**Test:** `src/server/services/i18n/translate.test.ts` (new, pure, stub db)

- [ ] **Tests:** `storeTranslations issues one $transaction for the batch` (stub `db.$transaction` and assert it receives N upserts); `rejections passed in are used and recentRejections is not queried`.
- [ ] **`storeTranslations`:** build the upserts into an array and `await db.$transaction(upserts)`. **Array transaction, not `Promise.all`:** 3 slots × 20 upserts under `Promise.all` is 60 concurrent statements on a default pool of 5 (2 vCPUs, no `connection_limit` in `DATABASE_URL`) — it queues past Prisma's 10 s `pool_timeout` and P2024s a batch that translated fine. One transaction = one connection per slot, and the batch becomes atomic with the DONE marking that follows.
- [ ] **`memory.ts`:** `rememberTranslations(db, inputs[])` — same array transaction inside the existing try/catch (a failure logs once and loses the batch's memory rows, the documented cost). `translateBatch` collects MACHINE candidates and calls it once. `review.ts`/`repair.ts` keep the singular.
- [ ] **`recentRejections`:** export a `Rejection` type; `translateBatch(db, language, units, options: { signal?; rejections?: Rejection[] })` uses `options.rejections ?? await recentRejections(db, language.code)`. `executeRun` computes it once before the loop and passes it through `translateSlice`. Doc-comment: mid-run rejections reach the prompt on the next run (which is when `pendingUnits` re-plans them anyway).
- [ ] **`onProgress`:** keep in-memory `counters` (seeded from the run row — add `plannedUnits, translatedUnits, flaggedUnits, failedUnits, memoryHits, rateUnitsPerMin` to the initial select) and build the `RunProgress` from them instead of calling `progressOf` (2 queries per batch). `retireExhausted` returns its count so `failed` stays accurate. The four terminal `progressOf` calls stay. Define inside `executeRun`:

```ts
const snapshot = (stopReason: StopReason): RunProgress => ({
  runId,
  status: "RUNNING",
  planned: run.plannedUnits,
  completed: counters.translated,
  failed: counters.failed,
  flagged: counters.flagged,
  memoryHits: counters.memoryHits,
  done: false,
  stopReason,
});
```

- [ ] PASS + all i18n suites. **Commit** — `spec-19a: batched writes, rejections once, progress from counters`

### Task 6: Advisory flags do not force a semantic check

**Files:** `translate.ts` (~:226-235 and the sample gate ~:259-264)
**Test:** extend `translate.test.ts`

- [ ] **Tests:** `LENGTH_OUTLIER alone does not force a semantic check` (`qaSampleRate: 0`; assert no `task:"validation"` call; `qaFlags` still contains `LENGTH_OUTLIER`; status `MACHINE`); `a blocking code still forces it at qaSampleRate 0`; `MODEL_FLAGGED forces it`.
- [ ] **Code:** keep `qaFlags = allCodes(check)` (reviewer chip, `onlyFlagged`, bulk-approve guard all key on it); add a transient `forceQa = blockingCodes(check).length > 0 || Boolean(entry.issue)` and use `candidate.forceQa || rate >= 1 || position/len < rate` in the sample filter. `flaggedUnits` is unaffected (`status !== "MACHINE"`). Pays only once a language's `qaSampleRate < 1`.
- [ ] PASS. **Commit** — `spec-19a: only blocking findings force the semantic check`

### Task 7: `RunRateMeter` — an aggregate rate that is correct under concurrency

**Files:** `src/server/services/i18n/run-math.ts`, `run-math.test.ts`

- [ ] **Tests:** `single slot: one observation equals batchRate`; `three overlapping batches of 5 over 10 s report ~90/min, not 30/min`; `window keeps 2×slots observations`; `null previous seeds the EWMA`.
- [ ] **Code** (synchronous on purpose — no `await` inside, so slots cannot interleave in it):

```ts
export class RunRateMeter {
  private readonly window: Array<{
    units: number;
    startedAtMs: number;
    finishedAtMs: number;
  }> = [];
  private ewma: number | null;
  constructor(
    previous: number | null,
    private readonly slots: number,
  ) {
    this.ewma = previous;
  }
  observe(
    modelUnits: number,
    startedAtMs: number,
    finishedAtMs: number,
  ): number {
    this.window.push({ units: modelUnits, startedAtMs, finishedAtMs });
    const keep = Math.max(2, this.slots * 2);
    while (this.window.length > keep) this.window.shift();
    const span = Math.max(
      finishedAtMs - Math.min(...this.window.map((w) => w.startedAtMs)),
      1000,
    );
    const observed =
      this.window.reduce((s, w) => s + w.units, 0) / (span / 60_000);
    this.ewma = ewmaRate(this.ewma, observed);
    return this.ewma;
  }
}
```

Per-slot `batchRate` folded into the run EWMA would make the ETA 3× too pessimistic at 3 slots; this measures throughput across overlapping batches. With `slots=1` and one observation it equals `batchRate → ewmaRate`, so the existing rate test holds.

- [ ] PASS. **Commit** — `spec-19a: aggregate rate meter`

### Task 8: Parallel slots in `executeRun`, with truncation halving

**Files:** `src/server/services/i18n/runs.ts` (`executeRun` loop ~:434-683, catch ~:632-660, keepalive ~:419-431)
**Tests:** `runs.integration.test.ts` — pin existing cancel/pause/thief tests with `{ batchSize: 5, parallelSlots: 1 }`; add the cases below (grow the fixture to 15 TOPICs).

- [ ] **Tests first:**
  1. `three slots translate 15 units; no entityId translated twice; DONE === planned` (collect ids from every `aiJson` `unitsJson`; assert set size 15 and no duplicates; `status COMPLETED`, `leaseOwner null`).
  2. `each slot's read-back returns only its own claim` (`batchSize 5, slots 3`; every id in exactly one call; each call ≤5 units of one `kind`).
  3. `cancel stops claiming but lets in-flight batches finish` (first `aiJson` sets `cancelRequested`; DONE ≥ in-flight; `SKIPPED/cancelled > 0`; `finishedAt` set once).
  4. `abort re-queues every in-flight batch without charging an attempt` (all `QUEUED`, `attempts 0`, `stopReason aborted`, `PAUSED`).
  5. `budget is not overspent across slots` (`maxUnits 7, batchSize 5, slots 3` → exactly 7 DONE, `stopReason budget`).
  6. `lost lease seen by one slot stops the others and writes nothing over the new owner`.
  7. `counters and rate under 3 slots equal the sum of batches`.
  8. `a truncated batch is re-queued without charging an attempt and the next batch is half the size` (`mockImplementationOnce` throws `new ProviderTruncatedError(8192, 8192)`; first call 5 units, next ≤2; all DONE with `attempts 1`; none FAILED).
  9. `a single unit that truncates is FAILED, not re-queued for ever` (`batchSize 1`, always truncate → all SKIPPED, `attempts 3`, run COMPLETED).
  10. `onProgress receives counters` (last payload `completed === 15`).

- [ ] **Options:** `executeRun(db, runId, { leaseOwner; maxUnits?; onProgress?; signal?; batchSize?; parallelSlots? })`; defaults from `schoolConfig.ai.translationBatchSize` / `translationParallelSlots`; non-Latin scripts start at half: export `isNonLatinScript(locale)` from `validation.ts` (it already owns `SCRIPT_RANGES`) — a heuristic, not a `Language` column (nobody would maintain it; the runtime halving learns the real size in one wasted call). In `runs.ts`:

```ts
/** Non-Latin scripts cost 2–3× the tokens per character; start at half and let truncation halve again. */
function initialBatchSize(language: LanguagePolicy): number {
  const base = schoolConfig.ai.translationBatchSize;
  return isNonLatinScript(language.code)
    ? Math.max(1, Math.ceil(base / 2))
    : base;
}
```

- [ ] **Structure** — keep the prologue (claim, dead-RUNNING sweep, `languagePolicy`, keepalive) single-threaded; replace the `for(;;)` with `runSlot(slot)` × `Promise.all`; everything after the loop runs once:

```ts
const slots = options.parallelSlots ?? schoolConfig.ai.translationParallelSlots;
let batchSize = options.batchSize ?? initialBatchSize(language); // shared: truncation is a fact about the language
const budget = options.maxUnits ?? Number.POSITIVE_INFINITY;
let reserved = 0,
  processed = 0;
const rejections = await recentRejections(db, run.locale);
const meter = new RunRateMeter(run.rateUnitsPerMin, slots);
const counters = {
  translated: run.translatedUnits,
  flagged: run.flaggedUnits,
  failed: run.failedUnits,
  memoryHits: run.memoryHits,
};

// A stop is a ranked latch: a stronger reason may replace a weaker one, never the reverse.
const STOP_RANK: Record<StopReason, number> = {
  finished: 0,
  budget: 1,
  paused: 2,
  aborted: 3,
  cancelled: 4,
  lostLease: 5,
  notClaimed: 6,
  localeBusy: 6,
};
const stop = { reason: null as StopReason | null };
const requestStop = (r: StopReason) => {
  if (stop.reason === null || STOP_RANK[r] > STOP_RANK[stop.reason])
    stop.reason = r;
};
// keepalive: `if (result.count === 0) requestStop("lostLease")`

async function runSlot(slot: number): Promise<void> {
  const claimToken = `${options.leaseOwner}#${slot}`; // exact read-back per slot; run-row guards stay on bare leaseOwner
  for (;;) {
    if (stop.reason !== null) return; // stop CLAIMING; an in-flight batch is already past here
    if (options.signal?.aborted) return requestStop("aborted");
    if (reserved >= budget) return requestStop("budget");
    const flags = await db.translationRun.findUniqueOrThrow({
      where: { id: runId },
      select: { pauseRequested: true, cancelRequested: true },
    });
    if (flags.cancelRequested) return requestStop("cancelled");
    if (flags.pauseRequested) return requestStop("paused");
    await db.translationJob.updateMany({
      where: { runId, state: "FAILED", attempts: { lt: MAX_ATTEMPTS } },
      data: { state: "QUEUED", error: null },
    });
    counters.failed += await retireExhausted(db, runId, options.leaseOwner);
    if (stop.reason !== null) return;
    const take = Math.min(batchSize, budget - reserved); // reserve synchronously — no await between compute and add
    if (take <= 0) return requestStop("budget");
    reserved += take;
    const jobs = await db.translationJob.findMany({
      where: { runId, state: "QUEUED" },
      orderBy: [{ entity: "asc" }, { id: "asc" }],
      take,
      select: { id: true, entity: true, entityId: true },
    });
    if (jobs.length === 0) {
      reserved -= take;
      return requestStop("finished");
    }
    const entity = jobs[0].entity;
    const wanted = jobs.filter((j) => j.entity === entity).map((j) => j.id);
    await db.translationJob.updateMany({
      where: { id: { in: wanted }, state: "QUEUED" },
      data: {
        state: "RUNNING",
        startedAt: new Date(),
        attempts: { increment: 1 },
        claimedBy: claimToken,
      },
    });
    const batch = await db.translationJob.findMany({
      where: { id: { in: wanted }, state: "RUNNING", claimedBy: claimToken },
      select: { id: true, entity: true, entityId: true },
    });
    reserved -= take - batch.length; // give back what another slot/runner won
    if (batch.length === 0) continue;
    const units = await unitsFor(
      db,
      language,
      entity,
      batch.map((j) => j.entityId),
    );
    const batchStarted = Date.now();
    try {
      const { translated, superseded } =
        run.kind === "REPAIR"
          ? await repairSlice(
              db,
              run.locale,
              language,
              units,
              runId,
              options.signal,
            )
          : await translateSlice(
              db,
              run.locale,
              language,
              units,
              runId,
              options.signal,
              rejections,
            );
      /* DONE / superseded / leftover-FAILED job writes: unchanged, but every `claimedBy: options.leaseOwner` → `claimedBy: claimToken` */
      const modelUnits = translated.length - memoryHits;
      const rate =
        modelUnits > 0
          ? meter.observe(modelUnits, batchStarted, Date.now())
          : null; // in-process; no read-modify-write
      const updated = await db.translationRun.updateMany({
        where: { id: runId, leaseOwner: options.leaseOwner },
        data: {
          translatedUnits: { increment: translated.length - superseded.size },
          flaggedUnits: { increment: flagged },
          memoryHits: { increment: memoryHits },
          promptTokens: { increment: promptTokens },
          completionTokens: { increment: completionTokens },
          leaseExpiresAt: leaseUntil(),
          heartbeatAt: new Date(),
          ...(rate !== null
            ? { rateUnitsPerMin: rate, modelBatches: { increment: 1 } }
            : {}),
        },
      });
      if (updated.count === 0) requestStop("lostLease");
      counters.translated += translated.length - superseded.size;
      counters.flagged += flagged;
      counters.memoryHits += memoryHits;
      processed += batch.length;
    } catch (error) {
      const ids = batch.map((j) => j.id);
      const requeue = () =>
        db.translationJob.updateMany({
          where: {
            runId,
            id: { in: ids },
            state: "RUNNING",
            claimedBy: claimToken,
          },
          data: {
            state: "QUEUED",
            startedAt: null,
            claimedBy: null,
            attempts: { decrement: 1 },
          },
        });
      if (options.signal?.aborted) {
        await requeue();
        return requestStop("aborted");
      }
      if (error instanceof ProviderTruncatedError && batch.length > 1) {
        const next = Math.max(1, Math.floor(batch.length / 2));
        if (next < batchSize) batchSize = next; // shared on purpose: a non-Latin run truncates at 20 on every batch
        logger.warn(
          { runId, entity, from: batch.length, to: batchSize },
          "output truncated — halving batch size",
        );
        await requeue();
        continue; // not charged, not counted; re-claimed within a second
      }
      // a single-unit truncation falls through: it is a real failure and is what stops an infinite loop
      logger.error({ error, runId, entity, slot }, "translation batch failed");
      await db.translationJob.updateMany({
        where: {
          runId,
          id: { in: ids },
          state: "RUNNING",
          claimedBy: claimToken,
        },
        data: {
          state: "FAILED",
          error:
            error instanceof Error ? error.message.slice(0, 300) : "unknown",
          finishedAt: new Date(),
        },
      });
      const updated = await db.translationRun.updateMany({
        where: { id: runId, leaseOwner: options.leaseOwner },
        data: {
          failedUnits: { increment: batch.length },
          leaseExpiresAt: leaseUntil(),
          heartbeatAt: new Date(),
        },
      });
      if (updated.count === 0) requestStop("lostLease");
      counters.failed += batch.length;
      processed += batch.length;
    }
    options.onProgress?.(snapshot(stop.reason ?? "finished"));
  }
}

try {
  await Promise.all(Array.from({ length: slots }, (_, slot) => runSlot(slot)));
} finally {
  clearInterval(keepalive);
}
const stopReason: StopReason = stop.reason ?? "finished";
// finalisation unchanged
```

Why this is safe: Prisma `{ increment }` is a single atomic `SET col = col + n`; the EWMA moved in-process where JS's single thread serialises it; `reserved` is bumped before any await; the read-back on `claimToken` is exact; run-row writes keep the bare `leaseOwner` so no slot trips `lostLease`; the dead-runner sweep already nulls `claimedBy`, so tokens never leak across runs. `worker.ts`, `runSliceAction` (`maxUnits: 25` → slot A 20, slot B 5, slot C budget) and `scripts/translate.ts` need no change. Do not raise slots above pool − 2 (default pool 5) without `connection_limit`.

- [ ] Also raise `maxTokens` at the translate and repair call sites to `schoolConfig.ai.translationMaxTokens` (currently 8192 both — no behaviour change today; it stops being hardcoded). `qa.ts` stays at 8192: back-translation is into English, ~200 tok/unit.

- [ ] PASS (`pnpm vitest run src/server/services/i18n` — repair/sample/run-control suites too; `repair.integration.test.ts` may assume 5-unit batches, pin if so) + `tsc` + `eslint`. **Commit** — `spec-19a: batches run in parallel slots and halve on truncation`

### Task 9: Evidence, deploy, measure

- [ ] `pnpm test` green; `tsc`, `eslint`, `build` clean.
- [ ] `specs/notes/spec-19-notes.md` — amendment A section: before/after per-call table from the worker log, the flag-rate decomposition, and the measured rate after each of Step 0 / batch 20 / 3 slots.
- [ ] Deploy per memory `pm2-worker-deploy` (`git pull`, `pnpm install`, `pnpm prisma generate`, `pnpm build`, `pm2 restart teoripro`, `pm2 restart teoripro-i18n-worker`). No migration. Confirm the running Spanish run resumes (SIGTERM → PAUSED → re-claimed) and the panel's rate.
- [ ] `specs/README.md` row 19; `DECISIONS.md` entries. **Commit** — `spec-19a: verification evidence`

---

## Expected throughput

Model: translate(n) ≈ 0.8 + 0.56·n s (fits 3.6 s at n=5); back-translation on Gemini the same shape; on Ollama ~16.6 s/unit; embed 0.6 → 1.0 s at 20; DB ~2 s/batch today → ~0.3 s after Task 5. `qaSampleRate = 1`.

| Configuration                                       | s / batch    | units / min                                                                              |
| --------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------- |
| **Today**: batch 5, 1 slot, QA on Ollama            | ~92          | **3.2 (measured)**                                                                       |
| Any code change with QA still on Ollama             | ≥ 90         | ~3.5 — the serial 83 s call dominates; slots queue on Ollama (`OLLAMA_NUM_PARALLEL` = 1) |
| **Step 0 only**: QA on Gemini                       | ~10          | **~30**                                                                                  |
| + Tasks 3–7 (batch 5, 1 slot)                       | ~8           | ~38                                                                                      |
| Batch 20, 1 slot                                    | ~25          | ~48                                                                                      |
| **Batch 20, 3 slots (this plan)**                   | ~25 per slot | **~140**                                                                                 |
| … and `qaSampleRate 0.2` (your call, not this plan) | ~16 per slot | ~230                                                                                     |

Spanish's remaining ~740 units: ~4 h today → ~25 min after Step 0 → ~5 min after the plan. Rate limits: 3 slots × batch 20 ≈ 15 requests/min on Gemini — inside paid-tier limits; if the key is free-tier, set `translationParallelSlots: 2`.

## Verification

1. Unit + integration: `docker compose -f docker-compose.dev.yml up -d db redis && pnpm test` — new/extended: `school.config`, `openai-compatible`, `google`, `client`, `qa`, `extract.integration`, `translate`, `run-math`, `runs.integration` (10 new cases).
2. Live: after Step 0, watch the panel rate on the current run climb without a restart. After deploy, start a run on Arabic (non-Latin → starts at batch 10; confirm in the worker log) and read `rateUnitsPerMin`; `pm2 logs teoripro-i18n-worker` should show three interleaved `progress` lines per ~25 s.
3. Truncation: temporarily set `translationMaxTokens: 1024` on dev, run 20 topics, confirm the log shows "halving batch size" once and every job ends DONE with `attempts 1`.
4. Accuracy guard: on the finished Spanish run compare `qaFlags` distribution before/after — the only permitted change is fewer `QA_UNAVAILABLE`; `NUMBER_DRIFT`/`ANSWER_PERMUTED`/`SEMANTIC_DRIFT` rates must be unchanged.

## Risks / do not

- Do not ship `translationMaxTokens` above 8192 without verifying the routed Google model's cap (2.0 Flash-Lite 400s, non-retryable → every batch FAILED ×3).
- Do not let `withFallback` wrap `ProviderTruncatedError`; the runner needs the class (tested).
- Do not move `LENGTH_OUTLIER` out of `qaFlags` — it would make length outliers bulk-approvable.
- Do not raise batch size without Task 3's embed chunking — question batches would all flag `QA_UNAVAILABLE`.
- Do not use `Promise.all` for the upserts; array `$transaction` keeps one connection per slot.
- Do not put an `await` inside `RunRateMeter.observe` or between computing `take` and `reserved += take`.
- Do not make `batchSize` per-slot; do not decrement attempts on a single-unit truncation.
