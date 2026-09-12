# Spec-21 — Broken translations: detect, mark, repair · verification evidence

**Status: implemented and verified on branch `spec-21-broken-translations`** (2026-09-12), then
deployed and used to repair production. Final gate and the production repair at the bottom.

## What was wrong, measured before anything changed

Production served "Tumi aage signal dile tader oboshshoi tomar jonno raastaa chhere dite hobe" —
Bengali in Latin letters. On the production database:

```
bn MASTER_ITEM rows with no Bengali script:  stem 18 · explanation 19 · any option 23   (of 722)
bn UI_MESSAGE rows with no Bengali script:   1                                          (of 291)
producer: Gemini / gemini-3.5-flash-lite, flags QA_UNAVAILABLE (13) and NUMBER_DRIFT+QA_UNAVAILABLE (5)
es, ar: none
```

Two causes in `validation.ts`: the script table did not contain Bengali, so the check never ran
for `bn`; and where it ran, one character of the target script anywhere in the payload passed the
whole unit. Neither prompt asked for a script.

## Task 1 — the gate, per field

```
RED   refuses a romanised translation…   expected [] to include 'SCRIPT_MISMATCH'   ← Banglish passed
GREEN ✓ refuses a romanised translation and names every field that is in the wrong script
        detail: "stem, option a, option b, option c, explanation"
      ✓ accepts Bengali script, and names only the one field that slipped into Latin  (detail "option c")
      ✓ does not demand script where the source has none to give — numbers, units, a bracketed name
      ✓ checks message-shaped units the same way                                       (detail "text")
      ✓ refuses English for an Arabic request — a silent, total failure — as SCRIPT_MISMATCH
      ✓ never asks a Latin-script language for a script
```

Twenty-one scripts are in the table now. `SCRIPT_MISMATCH` is blocking and a quality flag: the
repair run re-translates it, and bulk approve needs it ticked by name. Latin inside a field stays
legal — a number, a unit, a `§`, the bracketed original of an institution name (prompt rule 6);
the check requires the target script's presence, not Latin's absence.

## Task 2 — the prompts say it

```
✓ both prompts tell the model to write in the language's own script, never romanised
✓ asks a Latin-script language for its own orthography instead, and both prompts are 1.1.0
```

Rule 9 (units) / rule 8 (repair): "Write every field in Bengali script. Never romanise or
transliterate the translation into Latin letters; Latin appears only in numbers, units, legal
references and the bracketed original of a name." `translateBatch` and `repairBatch` pass the
script name from the same table the gate uses. Memory keys carry no prompt version, so the bump
re-translates nothing by itself.

## Task 3 — mark broken (admin only)

```
✓ only an admin may mark a translation broken                                 (ForbiddenError; row untouched)
✓ takes an approved row out of service, keeps the note for the model, and resets the repair budget
      status NEEDS_REVIEW · qaFlags ⊇ ["ADMIN_FLAGGED"] · repairAttempts 3 → 0
      qaReport { source: "admin", issues ∋ { code: ADMIN_FLAGGED, blocking: true, detail: <note> } }
      → a repairCandidates member
✓ queues a repair run in the same act when asked                              (REPAIR, enqueued, plannedUnits > 0)
```

The note is written into `qaReport.issues`, not only `reviewNote`: `storeRepairs` nulls the note
when it writes the repaired text, but `repairProblems` reads the report, and that is what reaches
the prompt. The repair queue helper lives in its own module (`queue-repair.ts`) because
`run-control` reaches `review.ts` through `sample.ts` and importing it back would close a cycle.

## Task 4 — the audit

```
✓ reports what the current gate refuses without touching a row     checked 3 · flagged 2 · { SCRIPT_MISMATCH: 2 }
✓ on apply, flags them for repair with a fresh budget and leaves the good row alone
      Banglish rows → NEEDS_REVIEW, qaFlags ["SCRIPT_MISMATCH"], repairAttempts 2 → 0
      Bengali row and stale row untouched · tp:i18n:msg:<locale> cleared · second apply flags 0
✓ queues one repair run for what it flagged when asked              (REPAIR · enqueued · plannedUnits 2)
```

Stale rows are skipped on purpose: they are the sync's to re-translate, and judging a translation
against text it was never made from would flag it for the wrong reason.

## Task 5 — board, question page, review page, CLI

Board: "Re-check translations" on every language card (hidden while a run is live), result alert
"{flagged} of {checked} held after re-check · SCRIPT_MISMATCH 23 · A repair run is queued for
them." Question page: a "Mark broken" row under "This question in every language" — note, "Repair
with AI now", one form per language — for ADMIN only (the page passes `canFlag`, the action
`requireUser("ADMIN")`, the service refuses anyone else). Review page: the admin's note under the
flag chips. Both catalogues; `messages.test.ts` parity green. `pnpm i18n:audit <code>
[--apply] [--repair]` mirrors the button.

## Acceptance checklist

| Item | Result | Evidence |
|---|---|---|
| Romanised Bengali refused with `SCRIPT_MISMATCH` naming the fields; numeric option and bracketed name not flagged; Spanish untouched | PASS | translation.test.ts (6 cases) |
| Both prompts state the script rule at 1.1.0 | PASS | prompts/translation.test.ts |
| Admin marks an APPROVED translation broken with a note; out of service at once; note in the repair prompt; repair queued; instructor refused | PASS | review.integration.test.ts (3), board e2e |
| Re-check flags what the gate refuses, writes nothing on a dry run, queues a repair on apply | PASS | audit.integration.test.ts (3) |
| A repaired unit returns to `MACHINE` and is served; three failures reach the queue | PASS | spec-19 repair suites unchanged and green (662 total); production run below |
| Both languages, 390 px, keyboard on the form and button | PASS | board e2e at Pixel 7 viewport, both catalogues |
| Production: no Bangla row without Bengali script after the repair; two repaired questions read correctly | see below | |
| `pnpm test`, `tsc`, `eslint`, `pnpm build`, e2e clean | see below | |

## Final gate

```
pnpm test                       69 files · 662 tests passed (19.0 s) — integration suites RAN against teoripro_test
pnpm exec tsc --noEmit          clean
pnpm exec eslint                clean (whole project)
pnpm build                      ✓ Compiled successfully
pnpm e2e                        36 passed · 1 skipped · 0 failed (7.2 s against the freshly built server)
```

The skipped e2e is the pre-existing environment skip in `e2e/sign-test.spec.ts` (no approved sign
questions in that database). One e2e run preceded the clean one: the new "Mark broken" step first
matched the bulk-approve consent checkbox that carries the same words as the row's badge — the
locator now targets the badge by its title, as the review spec already does.

## Production repair

PRODUCTION_PLACEHOLDER
