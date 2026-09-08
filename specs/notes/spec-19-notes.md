# Spec 19 — Unattended Translation & Publish Readiness · verification evidence

**Status: phase 2 of 3 complete.** The request deadline (phase 0), the background worker, run
controls and live progress (phase 1), and auto-repair (phase 2) are implemented and verified.
Readiness/notifications/sample (phase 3) is the remaining work; see `specs/plans/spec-19-plan.md`.

```
pnpm test    # 486 passed (54 files)
pnpm exec tsc --noEmit && pnpm exec eslint     # clean
```

Work is on branch `spec-19-translation-automation`, not yet merged.

## Phase 0 — a deadline on every AI request

### ✅ No provider request can hang for ever

Before this, `fetch` was called with **no `signal` anywhere in `src/server/ai/`**. Attended use hid
it — a person reloads a hung page — but an unattended worker has nobody to give up, and one hung
call would block its run until the lease lapsed while every retry layer above waited on a promise
that never settled.

All five provider fetch sites now go through `fetchWithDeadline`. Verified by grep rather than by
reading the diff: exactly one raw `fetch(` remains in the whole of `src/server/ai/`, and it is the
one inside the wrapper.

```
src/server/ai/providers/types.ts:121:    return await fetch(url, { ...init, signal });
```

### ✅ Every way a request can die is retryable, including the ones that were not

`asProviderError` maps `TimeoutError` → 504, `AbortError` → 499, and undici's
`TypeError("fetch failed")` → 503, all **retryable**; a `ProviderError` passes through; anything
unrecognised is returned untouched rather than swallowed (asserted with a `RangeError`).

That last mapping fixes a real pre-existing bug, not just a theoretical one. `client.ts` computes
`error instanceof ProviderError ? error.retryable : false`, so a provider that was genuinely **down**
— ECONNREFUSED, DNS failure, TLS reset — surfaced as a bare `TypeError` and **stopped the fallback
chain at the first route**, which is precisely the outage the chain exists for.

The deadline is proven against a server that accepts the connection and never answers — a fetch stub
whose promise can only be settled by the signal — not merely against one that returns an error:

```
✓ aborts a server that never responds and reports it as retryable   (<2s, deadline 120ms)
✓ honours an outer signal (worker shutdown) as retryable too
✓ maps a network failure (undici TypeError) to a retryable 503
✓ passes a ProviderError through untouched and leaves unknown errors alone
```

A regression worth naming: `openai-compatible`'s `ping` still deliberately omits `maxTokens`. A
1-token cap made the self-hosted gateway 502 on roughly half of all calls (measured 11/24 against
24/24 at the default, interleaved to rule out warm-up) — see `eb9a48e`. `pingTimeoutMs` is 60 s, not
the 20 s first proposed, because a healthy ping measured 7–13 s and 29.7 s under load.

## Phase 1 — the worker, controls and progress

### ✅ A crashed worker loses no completed work, and re-translates nothing

The headline acceptance item, run for real against the live AI gateway rather than asserted from the
unit test. A 32-unit run on a throwaway language, worker started, then the **actual node process**
`kill -9`'d mid-batch (the first attempt at this killed only the `pnpm` wrapper and the real worker
carried on — that run proved nothing and was discarded).

State immediately after the hard kill — 5 units finished, 5 stranded mid-flight, the run still
holding a dead worker's lease:

```
jobs:  DONE 5 · RUNNING 5 · QUEUED 22
run:   status RUNNING · translatedUnits 5 · leaseOwner worker-ds-MS-7E27-692805-34a7fd
```

A second worker was started and **correctly declined to touch it** while the lease was still live
(`leaseExpiresAt 08:23:24`, `now 08:22:27`, `expired: false`) — a runner must not steal a lease that
has not lapsed. Once it lapsed, it claimed the run and finished it:

```
jobs:  DONE 32
run:   status COMPLETED · translatedUnits 32 / 32 · leaseOwner null
translations: 32
```

The five jobs stranded in `RUNNING` were re-queued and completed — before this change nothing ever
re-queued them, and the run would have reported COMPLETED with those units silently missing, because
completion counted only `QUEUED`.

And the work already done was **not** redone. Comparing each pre-crash unit's `finishedAt` before and
after, and the `updatedAt` of its translation:

```
UNCHANGED  cmt6tckkx000  2026-09-08 08:21:24.403
UNCHANGED  cmt6tckl1000  2026-09-08 08:21:24.403
UNCHANGED  cmt6tckl6000  2026-09-08 08:21:24.403
UNCHANGED  cmt6tckl9000  2026-09-08 08:21:24.403
UNCHANGED  cmt6tcklb000  2026-09-08 08:21:24.403

Translation.updatedAt:  …kkx 08:21:24.386 · …l10 08:21:24.392 · …l60 08:21:24.394
                        …l90 08:21:24.397 · …lb0 08:21:24.400   ← pre-crash, untouched
                        …le0 08:23:34.246                        ← first unit of the recovered run
```

32 planned, 32 translation rows, zero duplicated spend.

### ✅ Four defects in the existing runner, found before they could bite

An adversarial review of the design against the real code found four faults that only an unattended
worker exposes. All four are fixed in `executeRun`, and each has a test.

1. **The lease was extended only _after_ a batch.** A batch is up to three provider calls, and on the
   self-hosted model one call measured 29.7 s — so a QA'd batch routinely outlived the 2-minute
   lease. Another runner could then claim the run while the first was still working, and because the
   per-batch writes used `where: { id: runId }` with **no owner guard**, the first never learned it
   had lost the lease and both wrote status. Now a keepalive refreshes the lease on an owner-guarded
   `updateMany` every 30 s, and every run-row write is owner-guarded; `count === 0` sets `lostLease`
   and the runner leaves the run to its new owner without touching it.
2. **A partial job claim translated the whole batch.** The claim bailed only when `count === 0`, so
   if another runner had taken 2 of 5, the code proceeded with all 5. Jobs now carry `claimedBy` and
   the batch is re-read as exactly the rows this runner won.
3. **Orphaned `RUNNING` jobs were never re-queued** (above).
4. **No cooperative stop.** `pauseRequested`/`cancelRequested` are read between batches, and an
   `AbortSignal` threads from the worker through `executeRun` → `translateBatch`/`semanticCheck` →
   `aiJson`/`aiEmbed` → the adapter, so a deploy's SIGTERM aborts the in-flight call in milliseconds
   instead of waiting out a 3-minute deadline.

Two corrections were made to the plan during implementation, both recorded in `DECISIONS.md`:

- **`executeRun` must NOT clear `pauseRequested` when it writes `PAUSED`.** The plan's code did, and
  its own test contradicted it: an admin's pause has to outlive the runner that honoured it, or the
  worker re-claims the run on its very next tick — which is the entire reason the flag exists
  separately from the `PAUSED` status. Only `resumeRun` clears it. The test proves claimability
  rather than the flag's value: `executeRun(..., { maxUnits: 0 })` returns `notClaimed` while paused
  and `budget` (i.e. claimed) the moment resume lands.
- **`workerTick` now guards `afterRun` on the success path** as it already did on the failure path.
  It was inert at the time — `defaultAfterRun` only logged; it now plans the repair chain too — but
  once `afterRun` sends mail (task 21), a
  transport failure on a run that completed cleanly would have been logged as "run failed", had a
  `FAILED` status attempted over it, and been reported twice.

### ✅ Containment holds at every layer

| Layer                                 | Covered by                                                                                                                 |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 0 · per-call deadline                 | `deadline.test.ts`, and the hanging-server test in `openai-compatible.test.ts`                                             |
| 1 · per-unit, 3 attempts then SKIPPED | pre-existing, unchanged                                                                                                    |
| 2 · per-batch try/catch               | pre-existing, plus the abort path returning the batch **without** charging an attempt                                      |
| 3 · per-run FAILED, worker continues  | `worker.test.ts` — a throwing run is marked FAILED and the tick reports `"failed"` rather than throwing                    |
| 4 · tick backoff, loop never exits    | `worker.test.ts` — three failing ticks with growing waits, then the signal stops it; `backoffMs` doubles and caps at 5 min |
| 5 · pm2 autorestart                   | `ecosystem.config.cjs`                                                                                                     |

Layer 4 was also seen for real: during an earlier smoke test a fixture was deleted from under a
running batch, and the worker logged `"run failed"`, backed off (`failures: 1, retryInMs: 10000`) and
kept running rather than dying.

**Known gap:** the keepalive interval itself is never fired in a test — `KEEPALIVE_MS` is 30 s and
every test finishes in milliseconds. What is covered is the shape of the guarded write and the
`lostLease` consequence, not the timer.

### ✅ SIGTERM finishes cleanly

```
{"component":"i18n-worker","signal":"SIGTERM","msg":"shutdown requested — finishing the current batch"}
{"component":"i18n-worker","msg":"worker stopped"}
```

Process exits, lease released, run resumes on the next start.

### ✅ The panel says what is happening, in both languages

Driven in a browser against a seeded run, not asserted from the component source.

**`/en/admin/languages`** — "Background worker online"; the Español card showing `Full run` /
`Running`, bar at 42%, `Done 96 / 240`, `Held for review 11`, `Failed 3`, `From memory 42`,
`Rate 18.4 / min`, `Time left 8 min`, `Cost $0.15 of ~$0.51`, per-entity chips
(`TOPIC: 24/27 · 3 given up`), and Pause / Cancel.

**`/no/admin/languages`** — fully Norwegian, no English leaked: "Bakgrunnsarbeider pålogget",
"Full-kjøring", "Kjører", "Ferdig 96 / 240", "Til vurdering", "Fra minne", "Tempo 18.4 / min",
"Tid igjen 8 min", "$0.15 av ~$0.51", "3 oppgitt", "Pause", "Avbryt kjøring".

| Checked                            | Result                                                                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Polling                            | `translatedUnits` changed in Postgres → panel moved 96 → 140 within 4 s, no reload                                                       |
| Pause → Resume → Cancel            | "Pausing after this batch" → Resume replaces Pause → "Cancelling after this batch", controls withdraw, `cancelRequested: true` in the DB |
| Terminal run                       | bar 100% green, controls gone, **0 server-action POSTs over 8 s** — polling really stops                                                 |
| Stale heartbeat (>3 min)           | red "Worker not responding" chip + the "nothing is lost" alert                                                                           |
| Worker offline (Redis key deleted) | "Background worker offline" + the fallback note                                                                                          |
| 390 px                             | `scrollWidth === clientWidth === 390`, no horizontal overflow                                                                            |
| Keyboard                           | tab order Pause → Cancel run → Review, visible focus ring                                                                                |
| Console                            | no errors                                                                                                                                |

The ETA comes from an EWMA of per-batch throughput with memory hits excluded, not from a time
window: a window flickers to "unknown" on any slow batch and collapses to seconds when a batch is
served from translation memory. It shows "estimating…" until two model batches have landed.

**Two deviations from the plan, both deliberate:** "Start in background" sits in each language card's
action row rather than the board-level plan card (the plan's snippet referenced `language.code` from
a board-level component that has no locale, so it could not compile as written); and the heartbeat
renders with `format.dateTime`, not `format.relativeTime`, which threw `IntlError:
ENVIRONMENT_FALLBACK` on every render and disagreed between SSR and hydration.

## Phase 2 — auto-repair

A translation that fails a QA check is stored `NEEDS_REVIEW`, and `NEEDS_REVIEW` is served under no
policy, never counts towards coverage, and is refused by bulk approve unless a reviewer names the
very code that flagged it (amendment B, below). So before this, the flagged pile could only be
cleared one unit at a time by a human. Phase 2 removes that wall by making the machine fix its own
mistakes — never by lowering the bar.

### ✅ The bar did not move — a quality finding is still not bulk-approvable

The invariant the whole spec is built to protect, and the first thing to check after building
something whose whole purpose is to shrink the flagged pile. Against the real database, with a
clean `MACHINE` row and a `NEEDS_REVIEW` row that has spent **all three** repair attempts — the
strongest possible temptation to wave through, and exactly the row a human has to read:

```
✓ still refuses a flagged unit, even one the machine has given up on
    bulkApproveTranslations → { approved: 1, skipped: 1 }
    flagged row after:  status NEEDS_REVIEW · qaFlags ["NUMBER_DRIFT"] · repairAttempts 3
                        reviewedById null · reviewedAt null      ← untouched in every respect
```

At the time this was written the refusal was categorical: `includeFlagged: z.literal(false)`, with
a companion test asserting the refusal sat on the `includeFlagged` path rather than incidentally on
`locale`'s `min(2)`. Amendment B replaced that boolean with per-code consent; the schema assertions
now live in `review.integration.test.ts`, and the test above is unchanged because a `NUMBER_DRIFT`
nobody consented to is still refused.

### ✅ Three safety rules, each with a test

1. **Never overwrite a human.** A repair run is planned from exactly the rows a reviewer is working
   through, so `storeRepairs` writes conditionally — `updateMany` guarded on the row still being
   `NEEDS_REVIEW` on the same `sourceHash` — rather than upserting the way `storeTranslations`
   does. `count === 0` means a human approved, edited or rejected it while the batch was in the
   model: that unit is reported superseded, its job is SKIPPED, and nothing is written, remembered
   included.
2. **Scrutiny goes up, never down.** `repairSlice` calls `repairBatch` with `qaSampleRate: 1`, so
   every repaired unit is re-QA'd whatever the language's sampling says. A repair that passes the
   structural gate and still means something else is precisely what a second attempt produces.
3. **The budget must bind.** Three attempts, persisted on the row (not the job) so the ceiling
   survives across runs — and charged only where one was actually spent. Units whose only flags are
   infrastructure (`QA_UNAVAILABLE`) or advisory (`LENGTH_OUTLIER`) are re-QA'd on the existing
   value and never re-translated: their text was never the problem, and without that rule one
   provider outage would burn every flagged unit's whole quality budget.

### ✅ A repair that fixes nothing does not plan another

The failure mode this exists for: the AI provider is down, so every repair batch fails, its jobs
exhaust `MAX_ATTEMPTS` and go SKIPPED, and the run still reaches COMPLETED with `translatedUnits: 0`
— while the same `NEEDS_REVIEW` rows are still candidates with their `repairAttempts` untouched,
because `storeRepairs` never ran to charge one. Nothing about the world changed, so the worker would
plan the identical run, and again: a tight plan/fail/plan loop spamming audit rows and mail and
burning the recovery window. `maybePlanRepair` therefore returns `stalled` when the finishing run is
a REPAIR whose `translatedUnits - flaggedUnits <= 0`, and the admin's button is the way back in.

The decision is pure — `RepairPorts` injects the three database reads — so all four branches are
unit-tested with no Postgres:

```
✓ chains a repair after a sync that left flagged units
✓ does not chain when a repair made no progress (provider down), and reports it
✓ reports exhaustion once nothing is under the ceiling but flagged rows remain
✓ is a no-op for samples and failed runs
```

And run against the real database on a throwaway language seeded with four flagged topics — three
under the ceiling, one already at three attempts:

```
candidates under the ceiling: 3
manual REPAIR run: {"kind":"REPAIR","status":"PENDING","plannedUnits":3,"enqueuedAt":"…","jobs":3}
second run refused: ConflictError                      ← the live-run guard the button relies on
after SYNC:                         {"action":"planned","runId":"cmtsf8xwv…","planned":3}
after a REPAIR that fixed nothing:  {"action":"stalled"}
REPAIR runs now on this locale: 1 (1 = the chain, not 2)   ← the loop really is broken
everything at the ceiling:          {"action":"exhausted","remaining":4}
```

`repairCandidates` needs its own planner rather than reusing `pendingUnits`, which deliberately will
not return these: a `NEEDS_REVIEW` row whose hash still matches its source is not stale, so a SYNC
skips it for ever. It also excludes `ITEM_VARIANT` — `extractAll` has no branch for variants (they
are derived from their master), so a repair job for one could only fail three times and end SKIPPED.
A row whose source has since moved is left to SYNC: re-translating from new source is a fresh
translation with a fresh budget, not a second attempt at the old one.

### ✅ Two ways in

The worker chains a repair after every SYNC / FULL / SINGLE_ENTITY / REPAIR that completes
(`defaultAfterRun` → `maybePlanRepair`); `notifyRunEvent` is task 21 and the seam is marked. And the
language card grows **"Repair {count} flagged in background"** — shown only when
`coverage.flagged > 0` and no run is live — which routes `kind: "REPAIR"` through
`startBackgroundRun` to `planRepairRun`. Both catalogues carry the string
("Reparer {count} merkede i bakgrunnen"); parity is test-enforced.

**Known gap:** the button was verified by driving the action and the planner against the dev
database (above), not by clicking it in a browser — a live repair execution needs the AI gateway,
which phase 3's sample-first dry run is the right place to exercise end to end.

## Phase 3 — readiness, notifications, sample run

### ✅ Coverage stops being a percentage and names what blocks publishing

`languageCoverage` returns `blockers[]`, a **partition** of `total − ready`: every unit that is not
servable lands in exactly one bucket — UNTRANSLATED, FAILED, FLAGGED, AWAITING_APPROVAL — and the sum
is always the shortfall the percentage describes. `complete` is now _derived_ from that list
(`total > 0 && blockers.length === 0`) rather than computed separately, so the checklist and the
publish gate cannot drift: a language showing an empty checklist is one the gate will let through,
by construction rather than by agreement. Asserted both in a pure test and against a real 1305-unit
extraction.

Two bucket rules that took care to get right:

- **FAILED is a subset of "no fresh row", never a status.** A unit the machine gave up on in one run
  and translated in the next has a fresh row and is not counted twice.
- **Cancelled and superseded jobs are not failures.** A cancel marks every remaining job SKIPPED and
  a re-plan supersedes them; calling those "gave up after 3 tries" would put a failure notice beside
  a unit nobody ever tried. `error: { notIn: ["cancelled", "superseded"] }`.

Verified in the browser on a language seeded with all four blockers at once (1296/1305 ready):

```
/en  Blocking publication: 3 untranslated · 2 gave up after 3 tries · 2 held by a check
                           · 2 awaiting approval
/no  Hindrer publisering:  3 uoversatt · 2 oppgitt etter 3 forsøk · 2 holdt av en kontroll
                           · 2 venter på godkjenning
```

Each line filtered to exactly its own rows in both locales — including the FLAGGED link showing the
REJECTED row that the default queue omits, and the UNTRANSLATED link correctly including a unit whose
job was SKIPPED with `error: "cancelled"` rather than mis-filing it as a failure. UNTRANSLATED and
FAILED units have no `Translation` row at all, so the review queue cannot list them; that is why
`untranslatedUnits` and its own section exist, and it is what makes "each links to exactly those
rows" true rather than approximately true.

The gate moves with the list: with everything blocking, the Show toggle measured `disabled: true`;
filled to 1305/1305 the checklist collapsed to "Nothing blocks publishing — every unit is servable."
and the toggle measured `disabled: false`. A checklist link measured 44×197 px with a visible focus
ring, and `?blocker=NONSENSE` falls back to the normal queue rather than erroring.

### ✅ Nobody has to watch the page for hours

`notifyRunEvent` mails the admin who started the run, in their own language; when nobody started it
— a CLI run, or a repair the worker chained itself — every live ADMIN is told instead. Four outcomes:
finished, failed, repair exhausted (units that survived three attempts and now need a human), and
repair stalled (it fixed nothing, usually because the provider is down).

Two silences are deliberate: a SAMPLE reports nothing, and a run whose decision was `planned` reports
nothing either — the chained repair run will report when _it_ finishes, and mailing here as well
would tell the same admin twice about one piece of work.

Asserted through the in-memory `capturedMail()` sink, which `vitest.config.ts` wires up for every
test. The link is built per recipient, so a Norwegian admin gets `/no/admin/languages/<code>` whatever
the run's own locale was.

### ✅ Five units before three thousand

`planSampleRun` picks ~5 pending units **round-robin across entity kinds**, so a sample shows a
question, a topic, a sign and a message rather than five UI strings, and renders them beside their
source. A sample is not a sync: `Language.lastSyncedAt` stays null, no `translationRunFinished` audit
row is written, and `maybePlanRepair` returns `none` so it never chains a repair — all asserted.

`sampleResults` joins through the run's own `TranslationJob` rows rather than `Translation.runId`,
because `storeTranslations` overwrites `runId` on every upsert and a later sync touching a sampled
unit would otherwise detach it from the sample that produced it.

### Final gate

```
pnpm test    # 526 passed (57 files) — three consecutive clean runs
pnpm exec tsc --noEmit && pnpm exec eslint && pnpm build     # all clean
```

### ✅ A final review, and what it caught

A full adversarial pass over the branch before merge found one blocker and three important defects.
All are fixed, each with a test — they are recorded here because three of them are the kind that only
show up in the unattended case this spec exists to serve.

- **A cancelled run whose worker died was permanently wedged, and locked the language out.**
  `requestCancel` leaves `status: RUNNING` while a live lease is held, because the runner must be the
  one to finalise. If that process then died hard, nothing could reach the run again: both
  `findClaimableRun` and `executeRun`'s claim exclude `cancelRequested`, and the panel hid every
  control the moment the flag was set — so the admin could not even ask again. `startBackgroundRun`
  then refused every new run for that locale. The language was dead until someone ran SQL.
  Fixed on both sides: the worker now reaps abandoned cancels itself (`reapAbandonedCancels`), and
  the panel offers a force-cancel once the heartbeat is stale. The finalising write is one shared
  `finaliseCancelledRun` so the two paths cannot drift.
- **The board reported "worker offline" for the whole of every real run.** The heartbeat was the
  first statement of the tick, and the next statement was an hours-long `executeRun`; the Redis key's
  TTL is three polls, so it expired 15 seconds in and was not rewritten until the run ended. The
  chip said the opposite of the truth exactly when it mattered most — and the deploy check below
  would only have passed while the worker was idle. The heartbeat is now an independent interval in
  the worker script.
- **Layer 0 had a hole one line to the right of where it was closed.** Every adapter's error path did
  `classify(response.status, await response.text())`, and that body read sat outside the deadline
  wrapper. A provider returning 502 and then stalling would reject with a bare `AbortError`,
  `classify` would never run, and `withFallback` would break the chain rather than try the next
  route — the precise failure mode phase 0 was written to prevent. A `readText` helper now routes it
  through `asProviderError` at all five sites.
- **`aria-live` covered the whole progress card**, so a screen reader re-announced eight stats, the
  chips and the bar every three seconds for hours. Narrowed to the status line, matching what the
  sample screen already did.

Plus hardening: the repair ceiling is now enforced in `storeRepairs`' `where` rather than only by the
planner; `translatedUnits` no longer counts superseded units and `failedUnits` is charged once at the
FAILED→SKIPPED crossing instead of on every attempt (a 5-unit batch failing three times used to read
"failed 15 / planned 5"); the readiness list hides its ADMIN-only action from instructors; and the
sample panel stops polling after a failure instead of retrying a deleted run for ever.

### Known gaps, stated plainly

- **The sample panel and the repair button were never clicked in a browser.** Both compile (`pnpm
build` covers every admin route), both are covered by integration tests, and the readiness
  checklist and progress panel _were_ driven in a real browser in both locales — but these two were
  not. Executing either end to end spends real AI budget.
- **The lease keepalive timer is never fired in a test.** `KEEPALIVE_MS` is 30 s and every test
  finishes in milliseconds; what is covered is the shape of the guarded write and the `lostLease`
  consequence, not the timer itself.
- **Head-of-line blocking is reachable.** `findClaimableRun` takes the single oldest claimable run;
  if that run's locale is busy (an admin's 25-unit slice holding the lease, say), `executeRun`
  returns `localeBusy` and the tick idles rather than trying the next language's run. It is bounded
  rather than permanent — the blocking run finishes — but with several languages queued a short slice
  can delay an unrelated language by its own duration. The fix is for the claim to skip locales that
  already hold a live lease; it is out of the approved plan's scope and worth a follow-up decision.
- **`storeRepairs` nulls `reviewNote`** along with the other review provenance. In practice a
  `NEEDS_REVIEW` row never carries a note — both `reviewTranslation` and `editTranslation` move the
  row to APPROVED/REJECTED when they write one — so nothing observable is lost, but it is the one
  place repair discards human-written words.

## Deployment

Not yet deployed. The branch is unmerged, and `f87b19f` (the OmniRoute streaming fix) is still
unpushed, so production is running neither.

The deploy adds a second pm2 app. `ecosystem.config.cjs` is committed here and the VPS keeps its own
copy, so the two are reconciled by hand on the first deploy rather than silently overwritten:

```bash
git push origin spec-19-translation-automation      # then merge to main
# on the VPS, as ai-dev:
cd ~/applications/driving-school
cp ecosystem.config.cjs ecosystem.config.cjs.pre-spec19   # keep the hand-edited original
git pull
pnpm install
pnpm prisma generate            # pnpm skips postinstall when the lockfile is unchanged
pnpm prisma migrate deploy
pnpm build
diff ecosystem.config.cjs.pre-spec19 ecosystem.config.cjs # reconcile before reloading
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save
pm2 logs teoripro-i18n-worker --lines 20
```

Then confirm the board's chip reads **Background worker online**. `tsx` is a devDependency, so the
VPS install must keep devDependencies or the worker cannot start.

## Amendment B — bulk approve scoped to consented flag codes (2026-09-09)

`QA_UNAVAILABLE` means the semantic check could not run — there was no `EMBEDDING` route at the
time — which is not a statement about the translation. It was holding **405 rows** of one
production language behind a one-at-a-time workflow. Bulk approve is now scoped: `allowFlags`
replaces `includeFlagged`, the review screen lists every code still holding rows with the two
non-quality codes pre-ticked, and a row is approved only when EVERY flag it carries was consented
to. Decision and its consequences: [DECISIONS.md](../../DECISIONS.md).

### ✅ The partition, against the real database

`src/server/services/i18n/review.integration.test.ts` — 9 tests, run against `teoripro_test` (not
skipped). Fixtures are five real extracted UI-message units with their real source hashes: one
clean `MACHINE`, one `NEEDS_REVIEW` flagged only `QA_UNAVAILABLE`, one flagged
`["QA_UNAVAILABLE", "NUMBER_DRIFT"]`, one flagged only `NUMBER_DRIFT`, and one flagged
`QA_UNAVAILABLE` whose `sourceHash` is `"stale"`.

```
✓ flagCounts → [ { QA_UNAVAILABLE, 3, quality: false }, { NUMBER_DRIFT, 2, quality: true } ]
✓ allowFlags: []                  → { approved: 1, skipped: 4 }   only the clean row moves
✓ no allowFlags at all            → { approved: 0, skipped: 4 }   the default is the safe end
✓ allowFlags: ["QA_UNAVAILABLE"]  → { approved: 1, skipped: 3 }
      infra row  APPROVED · reviewedById set · qaFlags kept (consented to, not disproved)
      mixed row  NEEDS_REVIEW   ← the row that matters: the NUMBER_DRIFT beside it holds it back
      quality    NEEDS_REVIEW
      stale      NEEDS_REVIEW
✓ audit meta → { bulk: true, allowFlags: ["QA_UNAVAILABLE"] }
✓ allowFlags: ["QA_UNAVAILABLE", "NUMBER_DRIFT"] → { approved: 2, skipped: 1 }
      the one row left behind is the stale one, reviewedById/reviewedAt still null
✓ an approved flagged MASTER_ITEM still derives its ITEM_VARIANT (variant row → APPROVED),
  and the derived variant is never itself a bulk-approve candidate
✓ schema: allowFlags defaults to [], `includeFlagged` is refused by .strict(), 33 codes is refused
```

### ✅ A row whose English has moved is never approved

The failure this closes: `languageCoverage` treats a stale row as untranslated, but `loadOverlay`
serves on `status` alone — so an APPROVED stale row is shown to students against English it was not
translated from. Until bulk approve could touch a flagged row this was unreachable, because a
flagged row only reached APPROVED through `reviewQueue`, which renders the current source beside it.
Candidates are now intersected with `extractAll`'s live `entity:entityId:sourceHash` set. The test
above ticks _every_ code the stale row carries and it is still refused, so the refusal is the hash
and nothing else.

Structural companion: the partition also requires `qaFlags.length > 0 || status === "MACHINE"`, so
a future `NEEDS_REVIEW` writer that forgets to attach a flag cannot be auto-approved by a vacuously
true `[].every()`.

---

## Amendment A — throughput (verified 2026-09-09)

### Where the 94 seconds went

Instrumented from the worker's own `ai call` log lines on the live Spanish run (38 calls / 19
batches, cadence 96 s):

| Call                                        | Route                          | avg        | p95   | Share   |
| ------------------------------------------- | ------------------------------ | ---------- | ----- | ------- |
| Back-translation QA (`task: validation`)    | Teori2 / ollama gemma4-fast    | **82.8 s** | 117 s | **88%** |
| … its fallback after a Cloudflare HTML page | Teori2 / gemma4:e4b-it-qat     | 240 s      | —     | —       |
| Translation (`task: translation`)           | Gemini / gemini-3.5-flash-lite | **3.6 s**  | 4.5 s | 4%      |
| Embeddings                                  | Gemini                         | ~0.6 s     | —     | <1%     |

The model translated 5 questions in 3.6 s. The 94 s was _verifying_ that translation on the
self-hosted box — a second full generation, serial.

**Step 0 (routing only, no code): `VALIDATION` → Gemini flash-lite, the two Ollama validation routes
removed.** The live run picked it up within one batch: **3.2 → 37 units/min**, an 11× improvement
before a line of code changed. Measured after: 12 consecutive validation calls at 3.4-3.9 s, batch
cadence 8-9 s.

### The 77% "held for review" was not a quality problem

62 of 64 flags were `QA_UNAVAILABLE` — the semantic check could not run because there was **no
`EMBEDDING` route** (added mid-run at 10:29 UTC; `gemini-embedding-001`, 1536 dims in ~600 ms).
Post-fix the real flag rate is ~7%, almost all `ANSWER_PERMUTED`. See the amendment-B note below and
the `embedding-route-required` memory: this single missing route also explains the stalled KB
embedding coverage, since `aiEmbed` serves both.

### What the code change bought

`BATCH_SIZE = 5` used ~15% of the output window; batches were strictly serial; `unitsFor` re-read the
whole 529-question bank every batch to keep five; no adapter read `finish_reason`, so an oversized
batch failed three times at full cost.

- Batch size, output cap and slot count are `schoolConfig.ai.*` (20 / 8192 / 3). 8192 not 16384:
  Gemini 2.0 Flash-Lite rejects anything larger with a non-retryable 400.
- `ProviderTruncatedError` in all three adapters, rethrown unwrapped by `withFallback` so the runner
  halves its batch instead of burning three attempts. A single-unit truncation is a real failure —
  that is what stops an infinite re-queue.
- A 429 is now waited out on the **same** route (5/10/20/40 s, capped at 60 s) rather than routed
  around. This was found the hard way: at 37 units/min the run hit Gemini's per-minute quota within
  ten minutes — 83 embedding + 33 translation 429s, and the immediate FAILED→QUEUED sweep burned
  **190 units to SKIPPED in one minute**. A probe 90 s later succeeded, proving the quota is
  per-minute and the right answer is to wait.
- Embeddings chunk at 100 (Google's `batchEmbedContents` cap) — without it a 20-unit question batch
  is 200 texts and 400s, which `semanticCheck` would have recorded as `QA_UNAVAILABLE` on all 20.
- `extractAll` takes `ids`, so a batch reads its own units instead of ~690 KB of bank.
- Advisory findings (`LENGTH_OUTLIER`) no longer force the expensive semantic pass; they stay in
  `qaFlags` for the reviewer.

### What the adversarial audit found, and why it was worth running

A spec-compliance review passed the parallel runner. A separate adversarial concurrency audit did
not, and it was right. Seven findings, all confirmed in the source before being fixed:

- **The lease keepalive swallowed its own failures.** Under connection-pool pressure the lease could
  lapse while the runner kept working: another runner claims the same jobs and translates them again
  (double provider spend), while the first still writes `Translation` rows — nulling
  `reviewedById`/`reviewedAt`/`reviewNote` and resetting `repairAttempts`. Now two consecutive
  keepalive failures fence the runner, and the store is gated _between the model call and the write_,
  not merely before the call — the window that matters, since batches run 30-540 s and the keepalive
  ticks every 30 s. **Measured red: 8 model calls unfenced against 2 fenced.**
- **A run could finalise `COMPLETED` with retryable `FAILED` jobs**, stamp `Language.lastSyncedAt`
  and mail "your language is ready" with units untranslated and uncounted — `remaining` counted only
  `QUEUED`/`RUNNING`. Both it and `progressOf` now count `FAILED` with attempts to spare.
- `unitsFor` sat outside the `try`, so one pool timeout failed the entire run.
- The budget leaked on every failure path, and could double-release: a bounded slice could translate
  35 units against `maxUnits: 25`, or deliver 5 of 25 during an outage.
- The batch size halved what a slot _won_ rather than the configured size, so contention could pin it
  at 1 for a whole run; recovery now converges instead of oscillating.
- Four terminal job writes lacked the lease guard `retireExhausted` has.

**Verdict after the fixes: safe unattended at `translationParallelSlots: 3`, conditional on
`connection_limit=12&pool_timeout=20` on the worker's `DATABASE_URL`** — the production host has 2
vCPUs, so Prisma's default pool is 5, and 3 slots plus the keepalive plus `extractAll`'s fan-out
needs more. Verified at deploy: `max_connections` 100, 27 in use.

```
pnpm test    # 601 passed (64 files) — i18n dir 176, integration suites RAN
pnpm exec tsc --noEmit && pnpm exec eslint && pnpm build     # all clean
```
