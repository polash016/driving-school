# Spec 16 — Task Sets & Student Panel Restructure

> Approved 2026-09-03. Supersedes the quick-start tile block of **spec-08** and section 2 of
> **spec-09**; both carry an amendment pointing here. Depends on 04 (question bank), 05 (AI
> gateway), 07 (quiz engine), 08/09 (student UI). Its companion is **spec-17** (AI variant
> generator), which this spec is designed to absorb without rework.

## Objective

Collapse the student panel from four test entry points to **three**, and make the middle of the
product a numbered **Task Set** — a full mock exam that is the same *set* for every student and a
different *paper* every time it is sat.

## Why this exists

The student panel currently offers Theory Test, Image Quiz, Sign Test and Mock Exam as four
sibling tiles. That is a menu, not a study path: nothing tells a student where to start, nothing
tracks how much of the material they have covered, and the split between Theory and Image
questions is an authoring distinction that the official teoriprøven does not make — the real exam
mixes text, image and sign questions in one paper.

Task Sets replace that menu with a progression. Each set is a full mock exam; passing one turns a
tile green; finishing them all provably means the student has met every question in the bank.

## The pool-slice model (the core decision)

A task set owns a **slice of the bank**, and each sitting draws a paper **from that slice**.

```
BANK (APPROVED master items, mixed TEXT / IMAGE / SIGN)
      │  partitioned by an admin-triggered AI run
      ▼
  #6 · 68 items      #7 · 68 items      #8 · 68 items      …
                          │
             ┌────────────┴────────────┐
             ▼                         ▼
   Student A sits #7            Student B sits #7
   45 of those 68               a different 45 of the 68
   seeded on (attempt)          seeded on (attempt)
```

`poolSize = ceil(paperSize × 1.5)`. Paper size is the official question count from
`LicenseClass` config (45 for class B).

The **final slice holds the remainder** of the bank. Where a slice is short (`poolSize < paperSize`)
its paper is the whole slice and its pass mark scales: `ceil(poolSize × passMark / officialCount)`.
A remainder smaller than `paperSize / 2` is **merged into the previous slice** rather than published
as a stub — a "task set" of nine questions is not a mock exam and would misreport a student's
readiness.

Three properties follow, and all three were requirements:

| Requirement | How the model delivers it |
|---|---|
| **Leak-proof** | A student cannot memorise "set #7 = these 45 questions", because it is 45-of-68, reshuffled, with per-attempt option order. This holds **with today's single-variant bank** — it does not depend on spec-17 landing. |
| **Full coverage** | `TaskSetMember` is unique on `masterItemId`: every approved question belongs to exactly one slice. Completing every set provably means meeting the whole bank. |
| **Set identity** | #7 is a stable chunk of material, so "passed #7" means something and the numbered grid is not decoration. |

**Rejected alternatives**, recorded so they are not relitigated:

- *Fixed 45-question sets* — identical papers for every student; memorisable; the leak the school
  is trying to avoid.
- *Shape-only sets* (a blueprint drawn fresh from the whole bank) — unleakable but sets become
  interchangeable, coverage is never provable, and the grid stops meaning anything.

## In scope

### Schema

```prisma
enum TaskSetStatus { DRAFT PUBLISHED ARCHIVED }

model TaskSet {
  id             String        @id @default(cuid())
  number         Int           // student-facing #N
  licenseClassId String
  status         TaskSetStatus @default(DRAFT)
  poolSize       Int
  paperSize      Int           // snapshot of LicenseClass.questionCount at publish
  passMark       Int           // snapshot, scaled for a short final slice
  timeLimitSec   Int           // snapshot
  composition    Json          // { topicCounts, typeCounts, avgDifficulty, warnings[] }
  buildId        String?
  publishedAt    DateTime?
  …
  // Unique WITHIN A BUILD, not within a class: a rebuild re-issues preserved numbers, so a DRAFT
  // #7 must coexist with the PUBLISHED #7 it replaces. The invariant that matters — one PUBLISHED
  // #7 per class — is a PARTIAL unique index in the migration SQL, which Prisma cannot express.
  // (Corrected 2026-09-03; the original constraint made rebuilds impossible. See DECISIONS.md.)
  @@unique([buildId, number])
  @@index([licenseClassId, status, number])   // the grid: published sets in order
}

model TaskSetMember {
  masterItemId String @id   // ← one slice per question: the coverage guarantee, enforced by the DB
  taskSetId    String
  @@index([taskSetId])      // assembly: candidates of one slice
}

model TaskSetBuild {
  id          String      @id @default(cuid())
  status      BatchStatus @default(PENDING)
  providerId  String?
  modelVersion String?
  promptVersion String?
  stats       Json        // sets proposed, items placed, items orphaned
  warnings    Json
  requestedById String?
  …
  @@index([status, createdAt(sort: Desc)])
}

model TaskSetProgress {
  userId        String
  taskSetId     String
  attempts      Int      @default(0)
  bestCorrect   Int?
  bestOutOf     Int?
  passedAt      DateTime?   // set once, NEVER cleared — a failed retry cannot un-pass a set
  lastAttemptId String?
  lastAttemptAt DateTime?
  @@id([userId, taskSetId])
  @@index([userId])          // the grid: one indexed read for all of a user's sets
}
```

Additions to existing models: `AttemptMode` gains `TASK_SET`; `ExamAttempt` gains
`taskSetId String?` with `@@index([taskSetId, userId])`.

**Why `TaskSetProgress` is denormalized rather than derived:** the grid needs pass state, best
score and attempt count for ~32 sets in one render. Derived, that is a `groupBy` plus a
correlated best-score lookup per set. Denormalized, it is one `findMany` on `TaskSetProgress_userId_idx`
— which is what mandate 2 requires. Rows are written inside the existing grading transaction, so
they cannot drift from the attempts they summarise.

### Engine

`assembly.ts` is **not modified**. It is already pure, already seeded per attempt, and already
enforces one-master-item-per-paper, `conceptGroupId` de-duplication, the difficulty spread and the
seen-window exclusion. All of that applies unchanged to a 45-of-68 draw.

The only engine change is one optional filter on the port:

```ts
// ports.ts
candidatesByTopic(params: {
  topicSlugs: string[];
  type?: ItemType;
  licenseClassId?: string | null;
  taskSetId?: string;          // NEW — restricts candidates to one slice
}): Promise<Record<string, VariantCandidate[]>>
```

`PrismaVariantSource` adds `masterItem: { taskSetMember: { taskSetId } }` to its where clause.

`startQuizInputSchema` gains optional `taskSetId`. Mode `TASK_SET`:
- always timed, from the set's `timeLimitSec` snapshot;
- grades server-side at submit, correctness withheld until then (the spec-04b security invariant);
- writes `TaskSetProgress` in the grading transaction;
- always qualifies for the pass guarantee.

**Config discipline:** 45 / 90 / 38 appear nowhere in code. Paper size, time limit and pass mark
come from `LicenseClass` and are snapshotted onto `TaskSet` at publish, so changing class config
later cannot retroactively alter a set a student already passed.

### Task set builder (admin)

`/admin/task-sets` → **Rebuild sets** → a `TaskSetBuild` runs through `src/server/ai/client.ts`
(model from the provider registry, never an inline string). It partitions APPROVED master items
into slices of `poolSize`, balancing against the exam blueprint: topic mix, difficulty spread, and
TEXT/IMAGE/SIGN ratio. Output is DRAFT sets with a composition table and per-set warnings
(`thin on images`, `topic X over-represented`). An admin reviews and publishes; **nothing reaches a
student unreviewed**.

Rebuild rules:
- A set whose membership is unchanged **keeps its number**. A student's passed #7 must not
  silently become different material.
- Newly approved questions land in the first slice with room, or open a new final slice.
- Items that leave the bank (RETIRED) are removed from their slice; the slice is topped up on the
  next rebuild rather than immediately, so a rebuild is the only moment membership moves.
- A build that would orphan an item fails loudly rather than publishing partial coverage.
- An **ARCHIVED** set disappears from the grid but its `TaskSetProgress` rows and past attempts are
  never deleted: `/account/history` and a result page must still explain a test the student sat.

### Student UI

Approved visual references (open in a browser): `specs/assets/spec-16/home-tiles-v2.html`
(tile block, option B3), `specs/assets/spec-16/icons.html` (glyph choice),
`specs/assets/spec-16/taskset-grid.html` (grid density G1 + start sheet),
`specs/assets/spec-16/taskset-model.html` (why pool-slice). The student homepage reference
`specs/assets/reference-teorimester-homepage.png` still governs the sections below the tiles.

| Route | State |
|---|---|
| `/` | Task-set hero card (progress bar, "12 of 32 passed", "Next up #13") · 2-up **Practice** / **Sign test** tiles, bare 54px fill glyphs (`Car`, `TrafficSign`) · 2 stat cards (pass rate, passed) · How I'm doing · **latest 10 attempts, all types**, + See all → `/account/history` |
| `/task-sets` | Compact 3-up numbered grid. Passed = green + tick (**stays green after a failed retry**). In progress = blue outline + Resume. Failed = last score in grey. **No red tiles** — a failed attempt is information, not punishment. |
| `/task-sets` start sheet | Tap a tile → sheet: `#N · 45 questions · 90 min · pass at 38`, best score, attempt count, pool size, one primary **Start / Try again**, and the full attempt list with dates and outcomes. |
| `/quiz/new` | Unchanged mechanics, restrung as **Practice** — the configurable path (length, timer, categories). |
| `/quiz/[attemptId]` | Unchanged runner. |

**Removed:** the Theory Test tile, the Image Quiz tile, the Mock Exam tile, and the topic-practice
dropdown card on the homepage. `startQuizInput.itemType` **stays in the engine** — Sign test uses
it, and Practice keeps category selection.

**Sign test is unchanged**: one tap into a sign run, exactly as it behaves today.

### Pass guarantee

A completed `TASK_SET` attempt always counts. The existing `evaluateGuarantee` rule is kept
alongside it, so a full-length, all-categories, timed **Practice** run also counts. No change to
`pass-guarantee.ts` beyond the `TASK_SET` short-circuit.

### i18n

No user-facing string outside `next-intl`. Norwegian vocabulary, fixed at approval:

| en | nb |
|---|---|
| Task set / Task sets | Oppgavesett |
| Task set #7 | Oppgavesett #7 |
| Practice | Øving |
| Sign test | Skiltest |
| Passed | Bestått |
| Try again | Prøv igjen |
| In progress | Pågår |

### Caching

The homepage aggregate and the task-set grid read through Redis, keyed per user
(`taskset:grid:{userId}`, `home:agg:{userId}`), invalidated by the existing `GradedHook` on
submit. Published-set metadata is cached globally (`taskset:published:{licenseClassId}`) and
invalidated on publish/archive.

### UI states (mandate 3 — a feature is not done without all of them)

Skeletons on the grid and hero (never spinners on navigation) · empty state when no set is
published yet, naming the admin action · offline: cached grid renders, Start is disabled with an
explanation · error boundary per section, not per page · 390px mobile-first with no horizontal
scroll · 44px targets, visible focus rings, full keyboard path into and out of the sheet (Esc
closes, focus returns to the tile) · both languages.

## Suggested build order (one spec, three landable slices)

1. **Schema + engine** — models, migration, `taskSetId` on the port and `PrismaVariantSource`,
   `TASK_SET` mode, progress written in the grading transaction. Provable by tests alone.
2. **Admin builder** — `TaskSetBuild`, the partitioner, `/admin/task-sets`, publish. A deterministic
   partitioner is written first so the AI pass is an improvement over a working baseline, not a
   prerequisite for one.
3. **Student UI** — home restructure, `/task-sets`, start sheet, i18n, caching.

## Out of scope

- The AI variant generator — **spec-17**. This spec is leak-proof without it and gains from it
  with no rework.
- Per-set difficulty progression (set #1 easier than #32). Slices are balanced, not graded.
- Image-valued answer options (still deferred from spec-08).

## Acceptance checklist

- [ ] Every APPROVED master item belongs to exactly one published `TaskSetMember` row; a query for
      orphans returns zero. Evidence: SQL count.
- [ ] Two different users starting the same task set receive different question sets. Evidence:
      integration test asserting variant-id overlap < 100%.
- [ ] The same user retrying a passed set receives a different paper. Evidence: integration test.
- [ ] A failed retry after a pass leaves the tile green: `passedAt` unchanged. Evidence: unit test
      on the progress transition.
- [ ] No correct answer reaches the client before submit in `TASK_SET` mode. Evidence: serializer
      test + payload assertion in the e2e run.
- [ ] Pass mark and time limit come from config for a full slice, and scale correctly for a short
      final slice. Evidence: unit test over `ceil(n × passMark / officialCount)`.
- [ ] Rebuild preserves set numbers for unchanged slices. Evidence: unit test over the partitioner.
- [ ] `/task-sets` grid renders from **one indexed progress query** plus cached published-set
      metadata — no per-set query, no N+1; p95 < 150ms. Evidence: query log + timing.
- [ ] Homepage shows the latest 10 attempts of all types with correct labels in both locales.
- [ ] Rendered at 390px: no horizontal scroll on `/` or `/task-sets`. Desktop renders centered
      max-w-md. Evidence: Playwright screenshots at 390px and 1280px.
- [ ] Keyboard-only path: home → grid → sheet → start → submit, in both locales. Esc closes the
      sheet and restores focus to the originating tile.
- [ ] No hardcoded 45 / 90 / 38 anywhere in the diff. Evidence: grep.
- [ ] No user-facing string outside the i18n layer. Evidence: grep over changed components.
- [ ] Theory Test, Image Quiz and Mock Exam tiles are gone from the student panel; `itemType`
      still serves the Sign test. Evidence: grep + passing sign-test e2e.
