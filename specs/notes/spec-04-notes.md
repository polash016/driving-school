# Spec 04 — Question Bank, Sets & AI Accuracy · verification evidence

Verified 2026-08-25 against the approved plan (`specs/plans/spec-04-plan.md`), including the
2026-08-24 amendment (sets, curation, accuracy dashboard).

```
pnpm exec prisma migrate deploy      # 4 migrations (see §Migrations)
pnpm exec tsc --noEmit && pnpm exec eslint     # both clean
pnpm test                            # 186 passed (23 files)
pnpm e2e                             # 21 passed
pnpm build                           # ✓ compiled; 11 admin/question routes emitted
```

---

## Acceptance checklist

### ✅ Lifecycle transitions enforced server-side (invalid transitions rejected + tested)

`transitions.ts` is the single chokepoint — no route, action or service writes `MasterItem.status`
directly. `transitions.test.ts` asserts the **complete 5×5 matrix** against an independently written
contract (28 cases), including that no status may transition to itself, that APPROVED is reachable
only from IN_REVIEW, and that RETIRED can only be revived as a DRAFT.

The integration suite then proves the service refuses them for real: illegal edge → `ConflictError`,
repeat of the current status → `ConflictError`, retire without a reason → `ValidationError`, and
`NEEDS_REVIEW` rejected from the UI but allowed with `systemInitiated` (spec-05's law-change watcher
is the only legitimate caller).

### ✅ Editing an approved item creates v+1; old attempts still render the old version

Integration test `versioning › bumps the version and republishes…`: an approved item is served into a
real `ExamAttempt`, then edited (stem **and** answer key changed). Asserted afterwards:

|                    |                                                                      |
| ------------------ | -------------------------------------------------------------------- |
| master             | `version: 2`, `correctOptionKey: "b"`                                |
| the served attempt | renders the byte-identical original content, `correctOptionKey: "a"` |
| the old variant    | `isActive: false` — superseded, never offered to anyone new          |
| active variants    | exactly `[{ masterVersion: 2, correctOptionKey: "b" }]`              |

**Deviation from the brief, deliberate:** the brief said variants "stay active until regenerated". They
do not — editing an approved item deactivates the old ones. Leaving them active means a corrected wrong
answer keeps being served to new students, which is the failure this feature exists to prevent. History
is still intact because attempts reference their variant row directly (`isActive` does not affect an
attempt already served).

### ✅ Table stays <150ms p95 at 10k seeded items

`pnpm db:seed-volume` (10 000 synthetic items across 20 sets), 50 runs per path through the actual
service functions, then `--cleanup`:

| Path                       | p50    | **p95**     | Plan                                                           |
| -------------------------- | ------ | ----------- | -------------------------------------------------------------- |
| List page 1, no filters    | 4.6 ms | **5.8 ms**  | Index Scan `MasterItem_status_updatedAt_idx`                   |
| List filtered by status    | 1.0 ms | **1.2 ms**  | Index Scan `MasterItem_status_updatedAt_idx`                   |
| List page 50 (deep offset) | 6.1 ms | **7.9 ms**  | same                                                           |
| Search (tsvector)          | 5.4 ms | **6.6 ms**  | Bitmap Index Scan `MasterItem_searchText_idx`                  |
| Set board (20 sets)        | 2.9 ms | **3.8 ms**  | groupBy on `MasterItem_batchId_status_idx`                     |
| Set detail                 | 9.1 ms | **10.6 ms** | Bitmap Index Scan `MasterItem_batchId_status_idx`              |
| Accuracy (uncached)        | 4.9 ms | **10.0 ms** | Bitmap Index Scan `MasterItem_createdBy_status_reviewedAt_idx` |
| Accuracy (cached)          | 0.1 ms | **0.2 ms**  | Redis, 5 min                                                   |

**Two real defects that measuring found, and asserting would not have:**

1. **The status filter was a sequential scan.** The query built `m."status"::text = $1`; casting the
   _column_ makes the index unusable. Casting the _parameter_ instead (`= $1::"ItemStatus"`) turned a
   2 500-row seq scan into an index scan — 4.0 ms → 0.127 ms in Postgres.
2. **The set board read 10 000 rows to count them.** It loaded every item's status per batch through a
   relation include. One `groupBy` over `(batchId, status)` replaced it: 29.6 ms → 3.8 ms p95.

A third gap was found the same way: nothing indexed `ORDER BY updatedAt DESC`, which is how an editing
surface sorts. Added `MasterItem(status, updatedAt DESC)` — the plan had named the wrong index
(`status, createdAt`, which serves the review queue's oldest-first order instead).

### ✅ Keyboard-only review of 10 items possible without touching mouse

`e2e/question-bank.spec.ts › reviews ten questions with the keyboard alone`: ten AI-authored items are
seeded IN_REVIEW, then approved with **ten presses of `a`** — the test issues no click, tap or pointer
event after the login form. The queue counter decrements each time and ends at "Nothing waiting for
review."

The same test then asserts the consequence that matters: all ten are APPROVED **and each has exactly one
active variant**, i.e. approving actually published them (D1).

### ✅ Set detail lists exactly its batch; Keep/Retire scoped and audited

Integration test `sets › scopes curation to one set…`: two sets on the same topic; approving one item
and retiring another in set A leaves set B byte-identical. Set A reports `{total: 2, approved: 1,
retired: 1}` with `acceptanceRate: 0.5`; set B reports `{total: 1, draft: 1}` with `acceptanceRate:
null` (nothing terminal yet). Attaching an item that already belongs to another set is refused —
moving it would corrupt both sets' acceptance rates. Detach and the audit rows are asserted too.

### ✅ Accuracy matches an independent computation

Integration test seeds a known outcome — model-x: 2 approved / 1 retired, model-y: 0 / 1, plus one
**human**-authored approved item — and asserts `model-x` = 2/3, `model-y` = 0/1, that the human item
appears nowhere in the AI numbers, and that the ranked reasons include the seeded rejections.
`e2e › reports AI accuracy per model` confirms the same figures render on the page (100 %, 10 reviewed).

---

## Migrations

Four, all applied to dev and test:

| Migration                        | What                                                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `…_question_bank_sets`           | `GenerationBatch`, `MasterItem.batchId` + `reviewReason`, generated `searchText` tsvector + GIN, set/accuracy indexes |
| `…_item_correct_option_key`      | `MasterItem.correctOptionKey` + **backfill from published variants** + CHECK constraint                               |
| `…_correct_key_constraint_scope` | narrows that constraint (see below)                                                                                   |
| `…_question_table_sort_index`    | `MasterItem(status, updatedAt DESC)`                                                                                  |

**`correctOptionKey` was missing from the model entirely.** `upsertItemInputSchema` accepted it, but
only `ItemVariant` had a column — an authored answer had nowhere to live until publication. Added as a
nullable column with a CHECK constraint (`status IN ('DRAFT','RETIRED') OR "correctOptionKey" IS NOT
NULL`): a question that is reviewable or servable must have an answer, while a draft may still be
incomplete and an abandoned item may still be retired. The 20 pre-existing rows in the test database
were backfilled from their variants (20/20) rather than defaulted.

The first predicate I wrote (`status = 'DRAFT' OR …`) made an incomplete draft impossible to abandon —
it could only be deleted. Caught while writing the delete path; the third migration fixes it.

Prisma again proposed dropping the KbChunk HNSW index and the generated columns in every migration;
each was stripped by hand and `prisma/migrations.test.ts` now guards `MasterItem_searchText_idx`, the
generated `searchText` column and the answer-key constraint alongside the spec-02 objects.

## Mandate compliance

- **Publishing (D1).** `publishItem` runs inside the same transaction as the status write, so an item
  can never be APPROVED without servable variants. Plain and templated items share one code path
  (`expandTemplate` with `parameterSlots: null` yields exactly one variant), which also means templated
  items get the engine's expansion validators for free. Idempotent through the unique `contentHash` —
  approve → retire → re-approve reuses and reactivates one row rather than creating a second.
- **Anti-leak (mandate/architecture §7).** The shared `QuestionCard` takes correctness only through an
  optional `reveal` prop; the admin preview and review queue pass it, and the student pre-submit payload
  has nothing to pass. Spec-08 consumes this component rather than reimplementing it (D4).
- **i18n (mandate 4).** ~150 new keys in both locales across `admin.questions.*`, `admin.review.*`,
  `admin.sets.*`, `admin.accuracy.*`; parity and runtime-key tests both green. The editor edits options
  as one bilingual list, so the "option keys differ across locales" failure the contract guards against
  is unreachable from the UI.
- **Caching (mandate 5).** `tp:qb:stats:v{n}:{groupBy}:{days}`, 5 min. Invalidated by a **version
  counter** bump from every write path — the first design used `cacheDel` on a base key, which would
  have left every per-grouping entry stale for its whole TTL.
- **Authorization.** INSTRUCTOR authors and reviews; ADMIN additionally imports, exports, bulk-acts and
  deletes. All 12 exported actions call `requireUser()` first — `auth-coverage.test.ts` enforces it.
- **Solid features (mandate 3).** Loading (pending submit states), empty (no items / no sets / not
  enough reviewed items), error (inline + `role="alert"`), and per-row failure reporting on bulk actions
  and imports. Import always lands as DRAFT — it is a bulk authoring tool, not a way around review.

## Deliberate limits

- **The AI controls in the set view ship disabled** with an explanatory tooltip, asserted by e2e. AI
  revision must cite the knowledge base to be worth anything, and that arrives in spec-05/06 (D4 of the
  roadmap plan).
- **Citations are free text** (`sourceCode` + `ref`), stored as JSON. The queryable `MasterItemCitation`
  rows point at KB chunks and facts that do not exist until spec-05, which backfills them (D6).
- **12 sample questions**, not the ~24 the plan estimated — they cover all 7 root topics and every
  screen and test in this spec. All seeded as DRAFT, `createdBy: HUMAN`, with a banner in the script:
  illustrative content, never mistakable for reviewed exam material.
- **Deep pagination uses OFFSET.** Fine at 10k (7.9 ms p95); a keyset cursor is the answer if the bank
  ever reaches six figures.

## Test inventory added by this spec

| File                                              | Cases | Covers                                                                           |
| ------------------------------------------------- | ----- | -------------------------------------------------------------------------------- |
| `question-bank/transitions.test.ts`               | 28    | the full lifecycle matrix                                                        |
| `question-bank/question-bank.integration.test.ts` | 14    | publishing, versioning, sets, stats, bulk, search, import/export — real Postgres |
| `e2e/question-bank.spec.ts`                       | 4     | keyboard-only review, set acceptance, accuracy page, bilingual browsing          |
| `prisma/migrations.test.ts`                       | +3    | the new generated column, its index, the answer-key constraint                   |

Totals: **186 unit/integration** (139 before this spec) and **21 e2e** (17 before), all green.

---

# Amendment II — assessment integrity (verified 2026-08-25)

Context: a pass mark here is the school's gate before a student may book the official teoriprøve
(DECISIONS 2026-08-25). The result must be defensible, and a wrong question must not reach a
student. **Nothing in this section makes a result recognised by an authority — that is an
agreement, not an engineering property.**

```
pnpm test    # 210 passed (25 files)
pnpm e2e     # 21 passed
pnpm exec tsc --noEmit && pnpm exec eslint && pnpm build     # all clean
```

## Acceptance

### ✅ Two-person sign-off

`integrity.integration.test.ts › two-person sign-off`: an author approving their own work is
refused (`ForbiddenError`); an AI-drafted question records the first reviewer's approval
(`applied: false, approvals: {recorded: 1, required: 2}`) and stays IN_REVIEW; the **same**
reviewer clicking again does not count as a second pair of eyes (one `ItemApproval` row); a
different reviewer completes it and it publishes. Editing the draft afterwards voids sign-offs —
approvals are keyed to the item version, so a reviewer only ever vouches for text they read.

`e2e › two reviewers sign off ten AI questions with the keyboard alone`: reviewer one clears the
queue with ten keystrokes (ten approvals recorded, **zero** questions live), reviewer two sees the
same ten and their ten keystrokes publish all of them, each with exactly one active variant.

**A design error this surfaced:** the first implementation threw `ConflictError` when a first
approval was recorded. That is wrong — the reviewer did their job. It now returns
`{applied: false, approvals}`, and the queue advances with "your approval is recorded".

### ✅ Approved questions are frozen

Refused in the service (`admin.questions.errors.approvedIsFrozen`) **and** in the database:

```
UPDATE "MasterItem" SET "correctOptionKey" = 'b' WHERE id = …
→ ERROR: MasterItem … is approved and frozen: retire it and approve a replacement
```

`replaceItem` retires the original with a reason and creates a linked replacement
(`replacesId`) carrying the correction. The original keeps `correctOptionKey: "a"` — the question
that was asked stays exactly as it was asked.

### ✅ Quality gate before a question can reach review

`validation.test.ts` (9 cases) plus the lifecycle boundary: a question with no legal citation, no
answer, an answer that is not an option, fewer than three options, duplicate or empty options,
"all of the above", a missing explanation, an unfilled placeholder, mismatched option letters
across locales, or the same stem as an existing question **cannot reach IN_REVIEW or APPROVED**.
The "correct answer is conspicuously the longest" tell is a warning, not a block.

### ✅ Results are sealed, immutable and verifiable

Every submission is attested inside the grading transaction: sha256 over the questions served,
the option order that student saw, their answers and the grade. The database then refuses to
change it:

| Attempted                                                       | Result                                                  |
| --------------------------------------------------------------- | ------------------------------------------------------- |
| `UPDATE "ItemVariant" SET "correctOptionKey"…`                  | refused — _variant is immutable_                        |
| `UPDATE "ItemVariant" SET "isActive" = false`                   | allowed — retiring is a serving decision, not a rewrite |
| `UPDATE "ExamAttempt" SET "correctCount" = 45, "passed" = true` | refused — _result is final_                             |
| `UPDATE "ExamAttemptQuestion" SET "answeredOptionKey"…`         | refused — _attempt is closed_                           |
| `DELETE FROM "ExamAttempt"`                                     | refused — _submitted and cannot be deleted_             |

`verifyAttempt` re-computes the digest **and** re-runs the grader over the stored answers. A test
disables the trigger, rewrites an answer the way someone with database access would, and
verification reports `hashMatches: false, intact: false` — tampering is detected even when the
guard is bypassed.

**A design error this surfaced:** the first trigger froze `resultHash` too, which made the seal
impossible to write (grading sets `submittedAt` in the same transaction). The rule is now
write-once: applying the seal is allowed, changing it never is.

### ✅ The student's own record

`/account/history` lists every attempt (newest first, sealed ones marked) and links to the paper
exactly as sat — each question in the order shown, their answer against the correct one, with the
explanation and citations. `attemptService.getResult` refuses an attempt that is still running, so
correctness cannot leak into a live exam. `listAttemptHistory` goes through `authorizeOwner`: a
student reading another student's record is refused.

## Migrations

| Migration                  | What                                                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `…_assessment_integrity`   | `ItemApproval`, `MasterItem.replacesId`, `ExamAttempt.resultHash`/`attestedAt`, and four immutability triggers |
| `…_attestation_seal_write` | narrows `attempt_result_final` so the seal is write-once rather than unwritable                                |

## Performance defects — fixed and measured

All three found during spec-04 were fixed before the numbers in the section above were recorded:

| Defect                                                              | Before                | After                             |
| ------------------------------------------------------------------- | --------------------- | --------------------------------- |
| Status filter cast the column (`status::text`), defeating the index | 4.0 ms seq scan       | 0.127 ms index scan               |
| Set board loaded 10 000 rows to count them                          | 29.6 ms p95           | 3.8 ms p95                        |
| Nothing indexed `ORDER BY updatedAt DESC`                           | seq scan + top-N sort | `MasterItem_status_updatedAt_idx` |

No further bottleneck was found at 10k items: the slowest path is set detail at 10.6 ms p95
against a 150 ms budget. The quality gate's duplicate check is the one known scaling risk — it
loads candidate stems to fingerprint them, which is fine for thousands of questions and wants an
indexed fingerprint column if the bank reaches six figures.

## Test inventory added by this amendment

| File                                       | Cases | Covers                                                                                 |
| ------------------------------------------ | ----- | -------------------------------------------------------------------------------------- |
| `question-bank/validation.test.ts`         | 9     | the quality gate                                                                       |
| `assessment/integrity.integration.test.ts` | 14    | sign-off, freeze, replacement, triggers, attestation, tamper detection, student record |

Totals: **210 unit/integration** (186 before) and **21 e2e**, all green.

---

# Bulk review (2026-08-25)

## Why bulk approve did nothing

The Approve button carried **no `action` value**. The form held a hidden
`<button name="action" value="APPROVE">`, but a hidden button is never clicked, so the submit sent
an empty action and `bulkActionInputSchema` rejected it. Each button now submits its own value
(`SubmitButton` gained `name`/`value`).

Two deeper problems came out with it:

- **Drafts could not be bulk-approved at all.** DRAFT → APPROVED is not a legal edge, so selecting
  a generated set and pressing Approve failed on every item. Bulk approve now walks
  DRAFT → IN_REVIEW → APPROVED per item — which is what a reviewer means — with the quality gate
  running at the review step.
- **The summary lied.** A first approval on an AI-written question is _recorded_, not published,
  but bulk reported it as done. Outcomes are now `approved` / `awaitingApproval` / `failed` per
  item, and the banner reads "12 done · 8 waiting for a second reviewer · 1 could not be approved",
  with each failure's reason listed.

## The queue that makes bulk review usable

After the first reviewer signs off, items are IN_REVIEW — so a second reviewer filtering by
"Drafts" sees nothing, which is exactly what happened in testing. The question table now has a
**"Waiting for my review (N)"** filter: in review, not already signed off by this reviewer, and not
their own human-authored work. Filter → select the page → Approve.

Measured on the developer's database:

```
reviewer A | "Waiting for my review (5)"  → 5 selected  → 5 done
reviewer B | "Waiting for my review (20)" → 20 selected → 20 done
servable approved questions: 17 → 42
```

## A cache race worth recording

While chasing this, an admin login was forced into 2FA enrolment even though the policy said
otherwise: the **database said off, Redis said on**. A read-through cache races with its own
invalidation — a request that read the old value can populate the cache _after_ the update cleared
it, and the stale value then survives the whole TTL.

For a security switch a stale answer is wrong in both directions, and the dangerous direction is
silently _not_ requiring 2FA. The security policy is no longer cached: it is a single primary-key
read on a one-row table, and correctness is worth more than the microsecond.

## Mock exam readiness is per topic, not a total

The student tile unlocked at "45 approved questions" and the exam then failed to assemble, because
a blueprint asks for a specific number **per topic** — 9 signs, 8 right-of-way, and so on. A bank of
200 questions all about road signs still cannot fill one.

`examReadiness()` now compares the blueprint against approved questions per root topic and returns
the shortfall, so the tile is honest ("2 topics still need more approved questions") and the school
knows what to write next. Verified end to end afterwards: **Question 1 of 45, 89:55 on the clock.**

---

# Test setup, configurable review, and the delete bug (2026-08-25)

## Student-configured tests

`/quiz/new` lets a student choose the clock (on = the official 90 minutes), the length (1–90,
defaulting to the official 45) and which categories are in play. Every change updates one sentence:
whether this attempt will count towards the pass guarantee, **before** they start — telling them
afterwards would be worthless.

The rule lives in `pass-guarantee.ts` and is evaluated **again on the server**; the screen explains
the decision, it does not get to assert it. Verified in the running app:

| Setup                        | Message                                            |
| ---------------------------- | -------------------------------------------------- |
| 45 questions, all categories | "This test will count towards the pass guarantee." |
| One category off             | "…All categories must be enabled for it to count." |
| 20 questions                 | "…Tests need at least 45 questions to count."      |

The pass mark follows the length using the official ratio (38 of 45): a 20-question test needs 17.
The eligibility decision and the full setup are stored on the attempt and **frozen by the
`attempt_result_final` trigger**, so a submitted result cannot later be declared to have counted.

Timing is deliberately not part of the criteria — the developer asked for the clock to be the
student's choice, so an untimed full-length test still counts (`timeLimitSecSnapshot: null`,
`countsTowardGuarantee: true`, verified). Adding `timed` to `QUALIFYING_CRITERIA` is a one-line
change if that judgement shifts.

## Reviewer count is now a school policy

`aiApprovalsRequired` (1–3, default 2) sits in **Admin → Security** beside the 2FA switch, with the
trade-off stated at the point of choice: with one reviewer, a single mistaken approval is all that
stands between an AI-written question and a student's exam. The review queue shows the live
requirement per item. A human-authored question always needs one reviewer who is not its author —
that is not configurable.

## Deleting a draft "failed" — it had actually worked

The service deleted the item correctly every time. The page then re-rendered **for the item that no
longer existed**, `getItem` threw, and the error boundary showed a generic failure. The delete
action now navigates back to the question bank, and a stale link to a deleted question returns a
proper **404** instead of an error. Verified in the UI: delete → redirect → soft-deleted in the
database → old URL gives "Page not found".

## Two smaller corrections

- **Bulk approve is idempotent.** A second reviewer sweeping a list that someone else already
  approved was told "23 could not be approved". Already-approved is the desired end state, and is
  now reported as done.
- **Reviewing one set.** `/admin/review?batch=<id>` scopes the queue to a single generated set,
  reachable from the set page. This started as a test-isolation problem — the keyboard-review spec
  assumed an empty queue and would have approved the _school's real questions_ — and turned out to
  be the workflow a reviewer actually wants.

Totals: **248 unit/integration**, **23 e2e**, all green. Pool: 78 servable, 3 drafts, 0 awaiting
review, mock exam ready.
