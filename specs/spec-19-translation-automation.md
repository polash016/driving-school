# Spec 19 — Unattended Translation & Publish Readiness

## Objective

An admin starts a language translating and walks away. The work continues in the background for as
long as it takes, survives provider outages and deploys without losing progress, repairs its own QA
failures rather than handing them to a human, and reports what it is doing well enough that nobody
has to wonder whether it is still alive. A language reaches students because the system finished the
job, not because someone clicked a button four hundred times.

## Why this is needed

Spec-15 built the engine and it works. What it did not build is a way to _finish_. Three facts about
the current system compound into the same wall:

1. **The admin screen advances 25 units per click.** `runSliceAction` is bounded on purpose — a
   request handler is the wrong place to hold a ten-minute AI run open — but a 3000-unit language is
   then 120 deliberate clicks, and the only unattended path is a terminal script on the VPS.

2. **QA-flagged units are never served, under any policy.** A unit that fails a check is stored
   `NEEDS_REVIEW`, and `servableStatuses()` excludes it whether or not the language requires
   approval. Turning off "requires approval" promotes clean `MACHINE` output and does nothing for
   the flagged pile.

3. **Bulk approve deliberately refuses flagged rows** (`qaFlags: { isEmpty: true }`), because a
   `NUMBER_DRIFT` on a speed limit is the entire reason the checks exist.

Publishing needs 100% coverage, flagged units never count toward it, and no bulk path clears them.
So the flagged pile is the bottleneck, and one-by-one review is the only way through it. This spec
attacks that pile by **making the machine fix its own mistakes**, not by lowering the bar.

## In scope

- **A background worker** (`teoripro-i18n-worker`, its own pm2 app) that claims runs by lease and
  works them to completion, with error containment at five layers and a graceful `SIGTERM` path.
- **Auto-repair**: a `REPAIR` run kind that re-translates every `NEEDS_REVIEW` unit with the QA
  finding fed back into the prompt, re-QAs the result, and only surfaces to a human what survives
  three repair attempts.
- **Live progress**: rate, ETA, running cost against estimate, per-entity breakdown, and an honest
  "worker not responding" state when the heartbeat goes stale.
- **Run controls**: pause, resume and cancel as cooperative flags the worker reads between batches.
- **Publish-readiness checklist**: coverage stops being a bare percentage and becomes a list of what
  specifically blocks publishing, each line clickable through to the filtered queue.
- **Notifications** by email on run completion, run failure, and repair exhaustion.
- **Sample-first dry run**: translate ~5 representative units and show them beside the source before
  committing to a full bank.

## Out of scope

- **BullMQ, or any job queue.** Spec-15's reasoning stands: the run IS the queue — planned into
  rows, claimed under a lease, resumable by construction. A queue would add infrastructure to
  replace a mechanism that already works.
- **Lowering the QA bar.** Bulk approve continues to refuse flagged rows. Repair shrinks the pile;
  it never sweeps it.
- **Changing translation quality for the initial pass.** Repair adds scrutiny on failure; the
  first-pass prompt, glossary and memory behaviour are untouched.
- **Multi-worker parallelism.** The lease design permits it and nothing here forbids it later, but
  one worker per deployment is what this spec builds and tests.
- **Translating admin chrome or the knowledge base** — unchanged from spec-15.

## Design

### Data model

Additive only; no existing column changes meaning.

| Field                                  | Purpose                                                                                                                                                                             |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TranslationRun.heartbeatAt`           | Distinguishes "working" from "worker died". Separate from `leaseExpiresAt`, which is a lock, not a liveness signal.                                                                 |
| `TranslationRun.cancelRequested`       | Cooperative cancel — the worker checks it between batches rather than being killed mid-write.                                                                                       |
| `TranslationJob.repairAttempts`        | Counts **QA** failures. Deliberately separate from `attempts`, which counts infrastructure failures: conflating them would let three provider 502s exhaust a unit's quality budget. |
| `TranslationRunKind.REPAIR`, `.SAMPLE` | New kinds; `CANCELLED` already exists on the status enum and finally gets used.                                                                                                     |

### The worker

A long-lived loop in `scripts/i18n-worker.ts`, run as a second pm2 app. It polls for claimable runs,
executes them in slices, and never exits on its own. Error containment, outermost last:

| Layer           | Contains                                                                             | State  |
| --------------- | ------------------------------------------------------------------------------------ | ------ |
| 1 · per-unit    | 3 attempts, then `SKIPPED` so one bad unit cannot stall a run                        | exists |
| 2 · per-batch   | try/catch records the error; the run continues                                       | exists |
| 3 · per-run     | a run that throws is marked `FAILED`; the worker moves to the next language          | new    |
| 4 · worker loop | `unhandledRejection` / `uncaughtException` trapped, exponential backoff, never exits | new    |
| 5 · pm2         | `autorestart`, and lease expiry means an abandoned run is reclaimed                  | new    |

`SIGTERM` finishes the current batch, releases the lease, and exits clean, so a deploy never orphans
a run.

### Auto-repair

When a translation pass completes, the worker plans a `REPAIR` run over the language's
`NEEDS_REVIEW` units. Each repair re-translates with the specific QA finding stated in the prompt
("the source says 80 km/h; your translation says 50"), at `temperature: 0`, then re-runs QA.

Two rules keep the accuracy promise honest:

- **Repaired units are always QA'd** — `qaSampleRate` is forced to 1 for a repair pass regardless of
  the language's configured rate. Repair raises scrutiny; it never lowers it.
- **Three repair attempts, then a human.** "However long it takes" means not giving up early. It
  does not mean burning money forever on a unit the model cannot fix. What survives three repairs
  has earned a reviewer's attention, and should be a handful rather than hundreds.

### Progress, controls and readiness

Progress is **polled**, not streamed: a run lasts hours, 3-second polling costs one indexed query,
and it is far more robust behind nginx than a held-open SSE connection.

`languageCoverage` grows a `blockers[]` array so the language page states what stands between the
admin and publishing — `12 flagged · 4 permanently failed · 31 awaiting approval` — with each line
filtering the review queue.

## Acceptance checklist

### Phase 1 — the worker, controls and progress

- [ ] An admin starts a full run from the browser, closes the tab, and the run completes without
      further interaction.
- [ ] Killing the worker mid-run loses no completed work: on restart it reclaims the lapsed lease
      and re-translates **nothing** already done.
- [ ] A batch that throws (provider 502) is recorded and the run continues; a run that throws is
      marked `FAILED` and the worker proceeds to the next language. The loop survives both.
- [ ] `SIGTERM` during a run releases the lease and exits within one batch; the run resumes on the
      next worker start.
- [ ] The progress panel shows rate, ETA, cost against estimate and a per-entity breakdown, and
      reports "worker not responding" when `heartbeatAt` goes stale rather than appearing frozen.
- [ ] Pause, resume and cancel each take effect within one batch and are recorded in the audit log.
- [ ] Both languages, mobile layout, keyboard paths and focus states all work on the progress panel.

### Phase 2 — auto-repair

- [ ] A unit flagged `NUMBER_DRIFT` is repaired automatically and reaches `MACHINE`, with the QA
      finding demonstrably present in the repair prompt.
- [ ] A repaired unit is QA'd even when the language's `qaSampleRate` is below 1.
- [ ] A unit that cannot be repaired stops after exactly 3 repair attempts and appears in the review
      queue — it is never retried forever and never silently approved.
- [ ] `repairAttempts` and `attempts` move independently: three provider 502s on one unit do not
      consume any of its repair budget.
- [ ] Bulk approve still refuses flagged rows. Verified explicitly, because this is the invariant
      the whole spec is built to protect.

### Phase 3 — readiness, notifications, sample run

- [ ] The language page names every blocker with a count, and each links to the queue filtered to
      exactly those rows.
- [ ] The student-visible toggle unlocks precisely when the blocker list empties — no drift between
      the checklist and the existing coverage gate.
- [ ] Completion, failure and repair-exhaustion emails send in both languages through the existing
      mail layer, and are captured by the test transport.
- [ ] A sample run translates ~5 units across entity kinds and renders them beside the source
      without committing to a full run.

## Notes

- **The Ollama 502 rate matters here.** Measured 2026-09-08 against `ai.dsit.app`, roughly one call
  in six returned 502 on the self-hosted models. Layer 1 absorbs it, but a second `TRANSLATION`
  route should be configured as fallback before a full bank is run unattended, or a bad patch will
  spend real units' attempt budgets on infrastructure noise.
- **Phases ship independently.** Phase 1 alone removes the wall; 2 and 3 are improvements on a
  working system.
- Deployment adds one pm2 entry to the VPS `ecosystem.config.cjs` — see the deployment notes in
  memory for the access limits that shape it.
