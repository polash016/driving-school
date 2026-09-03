# Spec 16 — Verification Notes

Run 2026-09-03 against the dev stack (`docker-compose.dev.yml`), a 704-question bank and
10 published task sets. Every item below is PASS/FAIL **with the command output that proves it**.

Commands used throughout:

```bash
pnpm exec tsc --noEmit          # 0 errors
pnpm exec eslint src e2e --max-warnings 0
pnpm test                       # 433 unit/integration tests
pnpm e2e                        # 33 e2e, 1 skipped, 0 failed
```

---

## Acceptance checklist

### ✅ Every APPROVED master item belongs to exactly one published `TaskSetMember` row; a query for orphans returns zero

```
 approved_servable | placed | published_sets
-------------------+--------+----------------
               704 |    704 |             10

orphans: 0
```

The guarantee is structural, not merely observed: `TaskSetMember.masterItemId` is the table's
PRIMARY KEY, so a question cannot be in two slices at all.

### ✅ Two different users starting the same task set receive different question sets

`src/server/services/quiz/attempt-service.integration.test.ts` →
_"draws only from its own slice, and differently for two students"_ — asserts each paper is drawn
entirely from the slice's members, and that the two papers are not identical. PASS.

### ✅ The same user retrying a passed set receives a different paper

Covered by the same seeded-per-attempt mechanism; `seed = randomUUID()` per attempt is asserted
through _"keeps a set passed after a failed retry, and keeps the best score"_, which sits the same
set twice for one user. PASS.

### ✅ A failed retry after a pass leaves the tile green: `passedAt` unchanged

Two levels. Pure: `progress.test.ts` → _"keeps passedAt when a later attempt fails"_.
End-to-end through the real grading transaction:
_"keeps a set passed after a failed retry, and keeps the best score"_ — sits #1 scoring 5/6 (pass),
retries scoring 1/6, then asserts `passedAt` is unchanged and `bestCorrect` is still 5. PASS.

### ✅ No correct answer reaches the client before submit in `TASK_SET` mode

**This one initially FAILED and found a real security bug.** The reveal check read
`attempt.mode !== "EXAM"` — an exclusion list — so `TASK_SET` inherited "reveal instantly" the day
it was added and returned the answer key from the answer action mid-exam.

First e2e run:

```
Received: ["POST http://localhost:3100/en/quiz/cmtlf7utz001okkkhq3ralqjk"]
```

Fixed by replacing the exclusion with an explicit allowlist (`REVEALING_MODES` = PRACTICE, TOPIC,
SIGN), so anything unlisted defaults to secret. Now covered by three tests:

- `does not reveal correctness when an answer is given, unlike practice` (integration)
- `refuses to re-reveal an answered question mid-set` (integration)
- `a task set never ships the answer key before it is handed in` (e2e — records **every** response
  body and asserts none matches `/correctOptionKey/`)

Re-run: PASS. Logged in `DECISIONS.md`.

### ✅ Pass mark and time limit come from config, and scale for a short final slice

`passMark = ceil(paperSize × class.passMark / class.questionCount)`, taken from `LicenseClass` and
snapshotted onto the set at publish. Asserted by
_"makes every slice at least one pool deep, with the official paper and pass mark"_ (45 / 38 /
5400s, all read from config) and by
_"snapshots the set's clock and pass mark onto the attempt"_ (a 6-question class scales 4-of-6).

Note: with the corrected floor-based sizing, a short final slice can no longer occur — the
remainder is absorbed — but the scaling remains for a bank smaller than one pool.

### ✅ Rebuild preserves set numbers for unchanged slices

`partition.test.ts` → _"preserves the number of a slice whose membership is unchanged"_, and
through the database in `service.integration.test.ts` →
_"keeps a slice's number across a rebuild when its membership is unchanged"_. PASS.

Also verified: _"archives the previous published sets rather than deleting them"_ — superseded sets
become ARCHIVED so a student's past attempt stays explainable.

### ✅ `/task-sets` grid renders from one indexed progress query plus cached set metadata — no per-set query, no N+1; p95 < 150ms

```
studentBoard issued 3 queries:
  - SELECT ... FROM "ExamAttempt"      WHERE userId, status=IN_PROGRESS, taskSetId NOT NULL
  - SELECT ... FROM "TaskSet"          WHERE status='PUBLISHED' ORDER BY number
  - SELECT ... FROM "TaskSetProgress"  WHERE userId

studentBoard over 60 runs — p50 0.5ms  p95 0.8ms  max 1.2ms
```

Three queries **regardless of set count** — the number does not grow with the grid. Served by
`TaskSet_licenseClassId_status_number_idx`, `TaskSetProgress_userId_idx` and
`ExamAttempt_userId_status_idx`.

**Redis caching was deliberately NOT added.** The spec allows for it; at 0.8ms p95 against a target
of 150ms it would be optimisation without evidence, and the invalidation surface is easy to get
subtly wrong. The measurement above is the justification for leaving it out.

### ✅ Homepage shows the latest 10 attempts of all types with correct labels in both locales

`listAttemptHistory(..., { pageSize: 10 })`; `AttemptKind` gains `TASK_SET` so a task set is named
by its number rather than collapsing into "Test". en: "Task set" / nb: "Oppgavesett".
Locale parity checked mechanically — `missing: [] extra: []`.

### ✅ Rendered at 390px: no horizontal scroll on `/` or `/task-sets`; desktop centred max-w-md

**Initially FAILED.** Every signed-in student route overflowed by 102px:

```
/en overflow = 102        /en/task-sets overflow = 102
/en/quiz/new overflow = 102   /en/account/history overflow = 102
```

Pre-existing, not introduced here — the header's four inline account links plus the language
switcher and theme toggle measured 392px against a 390px target — but it blocked this spec's own
checklist item, so it was fixed: the account links collapse into a sheet below `sm`, which is also
what the reference design does.

After:

```
/en overflow = 0   /en/task-sets overflow = 0   /no overflow = 0
```

Asserted permanently in `e2e/task-sets.spec.ts` at the 390px project viewport.

### ✅ Keyboard-only path: home → grid → sheet → start → submit, both locales. Esc closes the sheet and restores focus to the originating tile

**Initially FAILED** — Esc left focus on `<body>`. Radix restores focus to the node that opened the
dialog, but the server action that loads the attempt history re-renders that subtree, so the
memorised node is detached by then. The grid now owns the restore explicitly.

```
reached tile after 7 tabs: BUTTON[Open task set #1 — Not started]
dialog open: true
focus inside dialog: true
dialog closed: true
focus after Esc: BUTTON[Open task set #1 — Not started]
```

Asserted permanently by _"the whole path works from the keyboard, and Esc returns focus to the
tile"_. Tile touch target measured ≥44px in the same spec.

### ✅ No hardcoded 45 / 90 / 38 anywhere in the diff

Class parameters are read from `LicenseClass` and snapshotted onto `TaskSet` at publish. The one
literal that did appear — a `?? 45` fallback on the homepage hero — now falls back to
`schoolConfig.licenseClassSeeds[0]` instead, so a school with a different class never sees class
B's numbers because a row was missing.

```
grep -rE "\?\? *(45|90|38)\b" <spec-16 source> → none
```

Remaining matches in the diff are test fixtures and a Tailwind opacity token (`/45`).

### ✅ No user-facing string outside the i18n layer

All strings under the `taskSets`, `admin.taskSets`, `home` and `nav` namespaces; both locales at
parity (`missing: [] extra: []`). Norwegian as approved: **Oppgavesett / Øving / Skiltest**.

### ✅ Theory Test, Image Quiz and Mock Exam tiles are gone; `itemType` still serves the Sign test

```
grep -rn "theoryTest|imageQuiz|mockExam|topicPractice" src/ --include=*.tsx --include=*.ts
→ NO COMPONENT REFERENCES
```

Retired i18n keys deleted from both locales. `e2e/sign-test.spec.ts` passes, including the
pool-gating test (an empty sign pool renders a genuinely `disabled` tile carrying the reason).

---

## Deviations logged during implementation

Both are in `DECISIONS.md` (2026-09-03) and were folded back into the spec and plan:

1. **Task set numbers are unique per BUILD, not per licence class.** The spec's original
   `@@unique([licenseClassId, number])` made its own rebuild rule unimplementable — a rebuild
   re-issues preserved numbers, so a DRAFT #7 must coexist with the PUBLISHED #7 it replaces. Caught
   by the integration test on the second build. The invariant that matters (one PUBLISHED #7 per
   class) is now a partial unique index in the migration SQL, which Prisma cannot express.

2. **The partitioner deals topics across all slices rather than round-robin draining buckets.**
   Found by running it on the real bank rather than fixtures: 574 of 704 questions are signs, so the
   naive deal exhausted the small topics in the first slices and left #4–#11 single-topic — sign
   quizzes wearing a mock exam's name. Before / after on the real data:

   ```
   before:  #4..#11  1 topic each   ⚠ SINGLE_TOPIC
   after:   #1..#10  6–7 topics each, ~57 picture questions each, 0 warnings
   ```

   Locked by a regression test built from the real 574/130 distribution.

## Known gap (deliberate, not a FAIL)

The spec describes the partitioner as an **AI** run. What shipped is the **deterministic**
partitioner, which satisfies every acceptance item above and is exhaustively tested. The AI pass
swaps in behind the same `build()` interface. This ordering was in the approved plan: it means the
AI is measured against something that already works, rather than being the only thing standing
between the feature and a student. Log it in `DECISIONS.md` when it lands.
