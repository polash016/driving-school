# Spec 16 — Task Sets & Student Panel Restructure — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the four-tile student panel with three entry points — Task set, Practice, Sign
test — where a task set is a numbered full mock exam drawn from its own slice of the question bank.

**Architecture:** A `TaskSet` owns a slice of APPROVED master items (`TaskSetMember`, unique on
`masterItemId`, so every question sits in exactly one slice). Sitting a set draws `paperSize`
candidates from that slice through the **existing** assembly engine — the only engine change is one
optional `taskSetId` filter on the `VariantSource` port. `assembly.ts` is not modified. Per-user
outcomes are denormalized into `TaskSetProgress` inside the existing grading transaction so the grid
renders from one indexed read.

**Tech Stack:** Next.js 15 App Router (RSC by default), TypeScript strict, Prisma + PostgreSQL,
Redis (ioredis), Zod at every boundary, next-intl, Tailwind + `theme.css` tokens, Vitest, Playwright.

**Read before starting:** `CLAUDE.md` (mandates 1–4), `specs/spec-16-task-sets.md` (the contract),
`DECISIONS.md` entries dated 2026-09-03, and the mockups in `specs/assets/spec-16/`.

---

## File structure

| Path | Responsibility |
|---|---|
| `prisma/schema.prisma` | 4 new models, `TaskSetStatus`, `AttemptMode.TASK_SET`, `ExamAttempt.taskSetId` |
| `src/server/services/task-sets/partition.ts` | **Pure** partitioner: bank → balanced slices. No I/O. |
| `src/server/services/task-sets/partition.test.ts` | Coverage, balance, number preservation, tiny-remainder merge |
| `src/server/services/task-sets/service.ts` | Build / publish / archive / read. Prisma-facing. |
| `src/server/services/task-sets/progress.ts` | `TaskSetProgress` upsert, called from the grading transaction |
| `src/server/services/task-sets/progress.test.ts` | `passedAt` is set once and never cleared |
| `src/server/services/task-sets/index.ts` | Composition root (mirrors `services/assessment/index.ts`) |
| `src/server/contracts/task-sets.ts` | Zod input **and** output schemas |
| `src/server/services/quiz/ports.ts` | `taskSetId?` on `candidatesByTopic` |
| `src/server/services/quiz/prisma-variant-source.ts` | Applies the slice filter |
| `src/server/services/quiz/attempt-service.ts` | `TASK_SET` branch in `startQuiz`; progress write in `gradeAndClose` |
| `src/app/[locale]/(student)/task-sets/page.tsx` | The grid (RSC) |
| `src/components/task-sets/task-set-grid.tsx` | Numbered tiles (client — opens the sheet) |
| `src/components/task-sets/task-set-sheet.tsx` | Start sheet: meta, best, attempts, Start/Try again |
| `src/components/task-sets/task-set-hero.tsx` | Homepage hero card |
| `src/components/quiz/start-tiles.tsx` | Reduced to Practice + Sign test |
| `src/app/[locale]/(admin)/admin/task-sets/page.tsx` | Build board |
| `src/i18n/messages/{en,nb}.json` | `taskSets.*` namespace; `home.*` rewrites |

---

## Phase 1 — Schema & engine

### Task 1: Prisma models and migration

**Files:** Modify `prisma/schema.prisma`; create `prisma/migrations/<ts>_add_task_sets/migration.sql`

> ⚠️ **Migration procedure (DECISIONS 2026-08-26):** this repo REQUIRES `--create-only`, then hand
> editing the SQL to strip Prisma's proposed drops of the HNSW index and generated columns, then
> `migrate deploy`. Never `migrate dev` straight through, and never edit a migration after it has
> been applied.

- [ ] **Step 1: Add the enum and models to `prisma/schema.prisma`**

Place `TaskSetStatus` beside the other enums, and the models after `ExamAttemptQuestion`:

```prisma
enum TaskSetStatus {
  DRAFT
  PUBLISHED
  ARCHIVED
}

/// One numbered task set: a SLICE of the approved bank (spec-16). A sitting draws `paperSize`
/// questions from `poolSize` members, so the paper differs per student and per attempt while the
/// set itself stays a stable, nameable chunk of material.
model TaskSet {
  id             String        @id @default(cuid())
  number         Int
  licenseClassId String
  status         TaskSetStatus @default(DRAFT)
  poolSize       Int
  /// Snapshots of LicenseClass config, frozen at publish. Changing class config later must not
  /// retroactively alter a set a student has already passed.
  paperSize      Int
  passMark       Int
  timeLimitSec   Int
  composition    Json
  buildId        String?
  publishedAt    DateTime?
  createdAt      DateTime      @default(now())
  updatedAt      DateTime      @updatedAt

  licenseClass LicenseClass      @relation(fields: [licenseClassId], references: [id])
  build        TaskSetBuild?     @relation(fields: [buildId], references: [id])
  members      TaskSetMember[]
  progress     TaskSetProgress[]
  attempts     ExamAttempt[]

  @@unique([licenseClassId, number])
  // The grid: published sets of one class, in order
  @@index([licenseClassId, status, number])
}

/// A question's membership of exactly one slice. `masterItemId` is the primary key, so the
/// database itself guarantees full coverage: no question can sit in two sets, and a count of
/// members against a count of approved items proves none is orphaned.
model TaskSetMember {
  masterItemId String @id
  taskSetId    String
  createdAt    DateTime @default(now())

  masterItem MasterItem @relation(fields: [masterItemId], references: [id], onDelete: Cascade)
  taskSet    TaskSet    @relation(fields: [taskSetId], references: [id], onDelete: Cascade)

  // Assembly: candidates of one slice
  @@index([taskSetId])
}

/// One partitioning run. Sets stay DRAFT until an admin publishes the build.
model TaskSetBuild {
  id            String      @id @default(cuid())
  status        BatchStatus @default(PENDING)
  providerId    String?
  modelVersion  String?
  promptVersion String?
  stats         Json
  warnings      Json
  requestedById String?
  createdAt     DateTime    @default(now())
  updatedAt     DateTime    @updatedAt

  requestedBy User?     @relation("TaskSetBuildRequester", fields: [requestedById], references: [id])
  taskSets    TaskSet[]

  @@index([status, createdAt(sort: Desc)])
}

/// Denormalized per-user standing on one set (spec-16). The grid needs pass state, best score and
/// attempt count for ~32 sets in a single render; derived, that is a groupBy plus a correlated
/// best-score lookup per set. Written inside the grading transaction, so it cannot drift.
model TaskSetProgress {
  userId        String
  taskSetId     String
  attempts      Int       @default(0)
  bestCorrect   Int?
  bestOutOf     Int?
  /// Set once, NEVER cleared. A failed retry does not take a passed set away.
  passedAt      DateTime?
  lastAttemptId String?
  lastAttemptAt DateTime?
  updatedAt     DateTime  @updatedAt

  user    User    @relation(fields: [userId], references: [id], onDelete: Cascade)
  taskSet TaskSet @relation(fields: [taskSetId], references: [id], onDelete: Cascade)

  @@id([userId, taskSetId])
  // The grid: every set's standing for one user, one indexed read
  @@index([userId])
}
```

- [ ] **Step 2: Extend the existing models**

```prisma
// enum AttemptMode — add TASK_SET after SIGN
enum AttemptMode {
  PRACTICE
  EXAM
  TOPIC
  SIGN
  TASK_SET
}
```

On `ExamAttempt`, add the column, relation and index:

```prisma
  taskSetId             String?
  taskSet               TaskSet?      @relation(fields: [taskSetId], references: [id])
  // "attempts at this set by this user" — the sheet's history list
  @@index([taskSetId, userId])
```

On `MasterItem` add `taskSetMember TaskSetMember?`; on `LicenseClass` add `taskSets TaskSet[]`;
on `User` add `taskSetProgress TaskSetProgress[]` and
`taskSetBuilds TaskSetBuild[] @relation("TaskSetBuildRequester")`.

- [ ] **Step 3: Create the migration WITHOUT applying it**

```bash
pnpm exec prisma migrate dev --create-only --name add_task_sets
```

- [ ] **Step 4: Hand-edit the generated SQL**

Open the new `prisma/migrations/*_add_task_sets/migration.sql` and **delete any statement that
drops** `MasterItem.searchText`, `MasterItem.stemEmbedding`, or the HNSW/GIN indexes. Prisma
re-proposes these on every migration because it cannot model generated columns or pgvector. Keep
only the `CREATE TYPE`, `CREATE TABLE`, `ALTER TABLE ... ADD COLUMN`, `CREATE INDEX` and
`ADD CONSTRAINT` statements for the new task-set objects.

- [ ] **Step 5: Apply and regenerate**

```bash
pnpm exec prisma migrate deploy && pnpm exec prisma generate
```

Expected: `All migrations have been successfully applied.`

- [ ] **Step 6: Verify the schema is clean**

```bash
pnpm exec prisma migrate status
```

Expected: `Database schema is up to date!`

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "spec-16: task set schema — slices, builds, per-user progress"
```

---

### Task 2: The partitioner (pure, no I/O)

**Files:** Create `src/server/services/task-sets/partition.ts` and `partition.test.ts`

The partitioner is pure so it can be tested exhaustively without a database, and so the AI pass in
Task 6 becomes an *improvement over a working baseline* rather than a prerequisite for one.

- [ ] **Step 1: Write the failing tests**

```ts
// src/server/services/task-sets/partition.test.ts
import { describe, expect, it } from "vitest";
import { partitionBank, type PartitionItem } from "./partition";

function bank(count: number, topics = ["signs", "yield", "vehicle"]): PartitionItem[] {
  return Array.from({ length: count }, (_, i) => ({
    masterItemId: `m${i}`,
    topicSlug: topics[i % topics.length],
    type: i % 7 === 0 ? "IMAGE" : i % 5 === 0 ? "SIGN" : "TEXT",
    difficulty: (i % 5) + 1,
  }));
}

describe("partitionBank", () => {
  it("places every item in exactly one slice", () => {
    const result = partitionBank(bank(300), { paperSize: 45, poolRatio: 1.5 });
    const placed = result.slices.flatMap((s) => s.masterItemIds);
    expect(placed).toHaveLength(300);
    expect(new Set(placed).size).toBe(300);
  });

  it("sizes full slices at ceil(paperSize * poolRatio)", () => {
    const result = partitionBank(bank(300), { paperSize: 45, poolRatio: 1.5 });
    expect(result.slices[0].masterItemIds).toHaveLength(68);
  });

  it("merges a remainder smaller than half a paper into the previous slice", () => {
    // 68 + 68 + 10 → the 10 fold back, because a 10-question 'mock exam' misreports readiness
    const result = partitionBank(bank(146), { paperSize: 45, poolRatio: 1.5 });
    expect(result.slices).toHaveLength(2);
    expect(result.slices[1].masterItemIds).toHaveLength(78);
  });

  it("keeps a remainder of half a paper or more as its own slice", () => {
    const result = partitionBank(bank(160), { paperSize: 45, poolRatio: 1.5 });
    expect(result.slices).toHaveLength(3);
    expect(result.slices[2].masterItemIds).toHaveLength(24);
  });

  it("spreads topics rather than filling a slice from one topic", () => {
    const result = partitionBank(bank(300), { paperSize: 45, poolRatio: 1.5 });
    for (const slice of result.slices) {
      expect(Object.keys(slice.composition.topicCounts).length).toBeGreaterThan(1);
    }
  });

  it("preserves the number of a slice whose membership is unchanged", () => {
    const items = bank(136);
    const first = partitionBank(items, { paperSize: 45, poolRatio: 1.5 });
    const second = partitionBank(items, {
      paperSize: 45,
      poolRatio: 1.5,
      existing: first.slices.map((s) => ({
        number: s.number,
        masterItemIds: s.masterItemIds,
      })),
    });
    expect(second.slices.map((s) => s.number)).toEqual(first.slices.map((s) => s.number));
    expect(second.slices[0].masterItemIds).toEqual(first.slices[0].masterItemIds);
  });

  it("warns when a slice holds no image or sign questions", () => {
    const textOnly: PartitionItem[] = Array.from({ length: 68 }, (_, i) => ({
      masterItemId: `t${i}`,
      topicSlug: i % 2 ? "signs" : "yield",
      type: "TEXT",
      difficulty: 3,
    }));
    const result = partitionBank(textOnly, { paperSize: 45, poolRatio: 1.5 });
    expect(result.slices[0].composition.warnings).toContain("NO_VISUAL_QUESTIONS");
  });

  it("returns an empty result for an empty bank rather than throwing", () => {
    expect(partitionBank([], { paperSize: 45, poolRatio: 1.5 }).slices).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run src/server/services/task-sets/partition.test.ts`
Expected: FAIL — `Failed to resolve import "./partition"`

- [ ] **Step 3: Implement the partitioner**

```ts
// src/server/services/task-sets/partition.ts
import type { ItemType } from "@prisma/client";

/**
 * Bank → balanced slices (spec-16). PURE: no I/O, no clock, no randomness.
 *
 * A slice is a task set's identity, so this function's contract is stricter than "split a list":
 * - every item lands in exactly one slice (the coverage guarantee the DB then enforces);
 * - a slice draws from several topics, because a paper drawn from a single-topic slice would not
 *   be a mock exam;
 * - a slice whose membership is unchanged KEEPS ITS NUMBER — a student's passed #7 must not
 *   silently become different material on the next rebuild;
 * - a remainder under half a paper folds into the previous slice instead of being published as a
 *   stub that would misreport a student's readiness.
 */

export interface PartitionItem {
  masterItemId: string;
  /** ROOT topic slug — the distribution level, matching the exam blueprint. */
  topicSlug: string;
  type: ItemType;
  /** 1..5 */
  difficulty: number;
}

export interface SliceComposition {
  topicCounts: Record<string, number>;
  typeCounts: Record<string, number>;
  avgDifficulty: number;
  warnings: string[];
}

export interface PartitionedSlice {
  number: number;
  masterItemIds: string[];
  composition: SliceComposition;
}

export interface PartitionResult {
  slices: PartitionedSlice[];
  /** Items that could not be placed. Non-empty means the caller must fail, not publish. */
  orphaned: string[];
}

export interface PartitionOptions {
  paperSize: number;
  /** poolSize = ceil(paperSize * poolRatio). 1.5 by spec-16. */
  poolRatio: number;
  /** Previous published membership, so unchanged slices keep their numbers. */
  existing?: { number: number; masterItemIds: string[] }[];
}

export function partitionBank(
  items: PartitionItem[],
  options: PartitionOptions,
): PartitionResult {
  if (items.length === 0) return { slices: [], orphaned: [] };

  const poolSize = Math.ceil(options.paperSize * options.poolRatio);

  // Round-robin over topic buckets, then difficulty within each. Deterministic: the same bank
  // produces the same slices, which is what makes number preservation checkable.
  const byTopic = new Map<string, PartitionItem[]>();
  for (const item of [...items].sort((a, b) => a.masterItemId.localeCompare(b.masterItemId))) {
    const bucket = byTopic.get(item.topicSlug) ?? [];
    bucket.push(item);
    byTopic.set(item.topicSlug, bucket);
  }
  for (const bucket of byTopic.values()) {
    bucket.sort((a, b) => a.difficulty - b.difficulty || a.masterItemId.localeCompare(b.masterItemId));
  }

  const topics = [...byTopic.keys()].sort();
  const interleaved: PartitionItem[] = [];
  let exhausted = false;
  while (!exhausted) {
    exhausted = true;
    for (const topic of topics) {
      const bucket = byTopic.get(topic)!;
      const next = bucket.shift();
      if (next) {
        interleaved.push(next);
        exhausted = false;
      }
    }
  }

  const chunks: PartitionItem[][] = [];
  for (let i = 0; i < interleaved.length; i += poolSize) {
    chunks.push(interleaved.slice(i, i + poolSize));
  }

  // A stub set is worse than a fat one: fold a short tail back into its predecessor.
  if (chunks.length > 1) {
    const tail = chunks[chunks.length - 1];
    if (tail.length < options.paperSize / 2) {
      chunks[chunks.length - 2].push(...tail);
      chunks.pop();
    }
  }

  const previousByKey = new Map<string, number>();
  for (const slice of options.existing ?? []) {
    previousByKey.set(membershipKey(slice.masterItemIds), slice.number);
  }
  const takenNumbers = new Set<number>();

  const slices: PartitionedSlice[] = chunks.map((chunk) => ({
    number: 0,
    masterItemIds: chunk.map((item) => item.masterItemId),
    composition: describe(chunk),
  }));

  // Pass 1: any slice whose exact membership survived keeps its old number.
  for (const slice of slices) {
    const kept = previousByKey.get(membershipKey(slice.masterItemIds));
    if (kept !== undefined && !takenNumbers.has(kept)) {
      slice.number = kept;
      takenNumbers.add(kept);
    }
  }
  // Pass 2: everything else takes the lowest free number, in order.
  let next = 1;
  for (const slice of slices) {
    if (slice.number !== 0) continue;
    while (takenNumbers.has(next)) next += 1;
    slice.number = next;
    takenNumbers.add(next);
  }
  slices.sort((a, b) => a.number - b.number);

  return { slices, orphaned: [] };
}

function membershipKey(ids: string[]): string {
  return [...ids].sort().join(",");
}

function describe(chunk: PartitionItem[]): SliceComposition {
  const topicCounts: Record<string, number> = {};
  const typeCounts: Record<string, number> = {};
  let difficultyTotal = 0;
  for (const item of chunk) {
    topicCounts[item.topicSlug] = (topicCounts[item.topicSlug] ?? 0) + 1;
    typeCounts[item.type] = (typeCounts[item.type] ?? 0) + 1;
    difficultyTotal += item.difficulty;
  }
  const warnings: string[] = [];
  if ((typeCounts.IMAGE ?? 0) + (typeCounts.SIGN ?? 0) === 0) {
    warnings.push("NO_VISUAL_QUESTIONS");
  }
  if (Object.keys(topicCounts).length < 2) warnings.push("SINGLE_TOPIC");
  return {
    topicCounts,
    typeCounts,
    avgDifficulty: chunk.length === 0 ? 0 : difficultyTotal / chunk.length,
    warnings,
  };
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm exec vitest run src/server/services/task-sets/partition.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/services/task-sets/partition.ts src/server/services/task-sets/partition.test.ts
git commit -m "spec-16: deterministic bank partitioner with number preservation"
```

---

### Task 3: Slice filter on the candidate port

**Files:** Modify `src/server/services/quiz/ports.ts`, `src/server/services/quiz/prisma-variant-source.ts`

- [ ] **Step 1: Widen the port type**

In `ports.ts`, add to `candidatesByTopic`'s params:

```ts
    /**
     * Restrict candidates to ONE task set's slice (spec-16). This is the whole engine change that
     * task sets need: a set is a slice, and a sitting is the ordinary assembly path run against
     * that slice. `assembly.ts` never learns task sets exist.
     */
    taskSetId?: string;
```

Add the same optional field to `InMemoryVariantSource.candidatesByTopic` so the in-memory test
double keeps implementing the interface; it may ignore the value.

- [ ] **Step 2: Apply the filter in Prisma**

In `prisma-variant-source.ts`, widen the signature with `taskSetId?: string;` and add to the
`masterItem.findMany` where clause, directly after the `licenseClassId` block:

```ts
        // One extra predicate is the entire cost of task sets on the hot path.
        // Served by TaskSetMember_taskSetId_idx.
        ...(params.taskSetId
          ? { taskSetMember: { taskSetId: params.taskSetId } }
          : {}),
```

- [ ] **Step 3: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/server/services/quiz/ports.ts src/server/services/quiz/prisma-variant-source.ts
git commit -m "spec-16: optional taskSetId filter on the candidate port"
```

---

### Task 4: `TASK_SET` mode in `startQuiz`

**Files:** Modify `src/server/contracts/quiz.ts`, `src/server/services/quiz/attempt-service.ts`

- [ ] **Step 1: Extend the contract**

In `startQuizInputSchema`, after `itemType`:

```ts
    /**
     * The task set being sat (spec-16). Required for TASK_SET mode, rejected elsewhere — the
     * service validates it, because a slice filter silently ignored would produce a paper drawn
     * from the whole bank while claiming to be set #7.
     */
    taskSetId: idSchema.optional(),
```

- [ ] **Step 2: Write the failing integration test**

Append to `src/server/services/quiz/attempt-service.integration.test.ts` (follow the existing
fixture helpers in that file for seeding a bank):

```ts
  it("draws a TASK_SET paper only from its own slice, differently per user", async () => {
    const { taskSetId, memberIds } = await seedTaskSet({ poolSize: 30, paperSize: 20 });

    const a = await attemptService.startQuiz(userA.id, {
      mode: "TASK_SET", taskSetId, locale: "en",
    });
    const b = await attemptService.startQuiz(userB.id, {
      mode: "TASK_SET", taskSetId, locale: "en",
    });

    const idsOf = async (attemptId: string) =>
      (await db.examAttemptQuestion.findMany({
        where: { attemptId },
        select: { variant: { select: { masterItemId: true } } },
      })).map((q) => q.variant.masterItemId);

    const fromA = await idsOf(a.attemptId);
    const fromB = await idsOf(b.attemptId);

    expect(fromA).toHaveLength(20);
    expect(fromA.every((id) => memberIds.includes(id))).toBe(true);
    expect(fromB.every((id) => memberIds.includes(id))).toBe(true);
    // 20 of 30 twice: overlap is expected, identity is not.
    expect(fromA.join(",")).not.toEqual(fromB.join(","));
  });

  it("rejects TASK_SET without a taskSetId rather than serving the whole bank", async () => {
    await expect(
      attemptService.startQuiz(userA.id, { mode: "TASK_SET", locale: "en" }),
    ).rejects.toThrow();
  });
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm exec vitest run src/server/services/quiz/attempt-service.integration.test.ts -t "TASK_SET"`
Expected: FAIL — the mode is not handled.

- [ ] **Step 4: Implement the branch**

In `startQuiz`, declare `let taskSetId: string | null = null;` beside the other locals, then insert
a branch **before** the existing `if (input.mode === "EXAM")`:

```ts
    if (input.mode === "TASK_SET") {
      if (!input.taskSetId) {
        throw new ValidationError({ reason: "taskSetId required for TASK_SET" });
      }
      const set = await db.taskSet.findFirst({
        where: { id: input.taskSetId, status: "PUBLISHED" },
        select: {
          id: true,
          licenseClassId: true,
          paperSize: true,
          passMark: true,
          timeLimitSec: true,
          poolSize: true,
        },
      });
      if (!set) throw new NotFoundError({ taskSetId: input.taskSetId });

      // Snapshots, never live config: a set a student passed must stay the set they passed.
      taskSetId = set.id;
      licenseClassId = set.licenseClassId;
      timeLimitSec = set.timeLimitSec;
      passMark = set.passMark;

      const roots = await db.topic.findMany({
        where: { parentId: null, isActive: true, deletedAt: null },
        select: { slug: true },
      });
      // The slice already carries the topic balance; spread the paper evenly over what is in it
      // and let rebalanceToAvailability settle the remainder.
      distribution = evenDistribution(
        roots.map((r) => r.slug),
        Math.min(set.paperSize, set.poolSize),
      );
    } else if (input.mode === "EXAM") {
```

Change the existing `if (input.mode === "EXAM") {` to `} else if (input.mode === "EXAM") {` — i.e.
fold the existing chain under the new branch.

Pass the filter to the candidate source:

```ts
    const candidates = await variantSource.candidatesByTopic({
      topicSlugs: Object.keys(distribution),
      type: typeFilter,
      licenseClassId,
      ...(taskSetId ? { taskSetId } : {}),
    });
    if (input.mode !== "EXAM") {
      distribution = rebalanceToAvailability(distribution, candidates);
    }
```

Persist the link and the guarantee flag in the `examAttempt.create` data:

```ts
          taskSetId,
          countsTowardGuarantee:
            input.mode === "TASK_SET" ? true : (options.countsTowardGuarantee ?? false),
```

Also add `taskSetId: true` to the `select` in `loadOwnedAttempt`, so `gradeAndClose` can read it in
Task 5 without a second query.

- [ ] **Step 5: Run the tests**

Run: `pnpm exec vitest run src/server/services/quiz/attempt-service.integration.test.ts`
Expected: PASS, including the two new cases.

- [ ] **Step 6: Commit**

```bash
git add src/server/contracts/quiz.ts src/server/services/quiz/attempt-service.ts src/server/services/quiz/attempt-service.integration.test.ts
git commit -m "spec-16: TASK_SET attempt mode draws from one slice"
```

---

### Task 5: `TaskSetProgress` written in the grading transaction

**Files:** Create `src/server/services/task-sets/progress.ts` and `progress.test.ts`;
modify `src/server/services/quiz/attempt-service.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/server/services/task-sets/progress.test.ts
import { describe, expect, it } from "vitest";
import { nextProgress } from "./progress";

const passedRun = { correctCount: 41, outOf: 45, passed: true, attemptId: "a1", at: new Date("2026-09-01") };
const failedRun = { correctCount: 29, outOf: 45, passed: false, attemptId: "a2", at: new Date("2026-09-02") };

describe("nextProgress", () => {
  it("records a first attempt", () => {
    const next = nextProgress(null, passedRun);
    expect(next).toMatchObject({ attempts: 1, bestCorrect: 41, bestOutOf: 45, lastAttemptId: "a1" });
    expect(next.passedAt).toEqual(passedRun.at);
  });

  it("keeps passedAt when a later attempt fails", () => {
    const first = nextProgress(null, passedRun);
    const second = nextProgress(first, failedRun);
    expect(second.passedAt).toEqual(passedRun.at);   // a green tile is not taken away
    expect(second.attempts).toBe(2);
    expect(second.lastAttemptId).toBe("a2");
  });

  it("keeps the BEST score, not the latest", () => {
    const first = nextProgress(null, passedRun);
    const second = nextProgress(first, failedRun);
    expect(second.bestCorrect).toBe(41);
  });

  it("raises the best score when a later attempt beats it", () => {
    const first = nextProgress(null, failedRun);
    const second = nextProgress(first, passedRun);
    expect(second.bestCorrect).toBe(41);
    expect(second.passedAt).toEqual(passedRun.at);
  });

  it("does not set passedAt on a failed first attempt", () => {
    expect(nextProgress(null, failedRun).passedAt).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run src/server/services/task-sets/progress.test.ts`
Expected: FAIL — `Failed to resolve import "./progress"`

- [ ] **Step 3: Implement**

```ts
// src/server/services/task-sets/progress.ts
import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * Per-user standing on one task set (spec-16).
 *
 * `nextProgress` is pure so the one rule that matters is testable without a database: a pass is
 * permanent. A student who passes #7 and then fails a retry still sees a green tile — the retry is
 * practice, and taking the pass away would punish them for practising.
 */

export interface GradedRun {
  correctCount: number;
  outOf: number;
  passed: boolean;
  attemptId: string;
  at: Date;
}

export interface ProgressState {
  attempts: number;
  bestCorrect: number | null;
  bestOutOf: number | null;
  passedAt: Date | null;
  lastAttemptId: string | null;
  lastAttemptAt: Date | null;
}

export function nextProgress(
  current: ProgressState | null,
  run: GradedRun,
): ProgressState {
  const previousBest = current?.bestCorrect ?? -1;
  const beatsBest = run.correctCount > previousBest;
  return {
    attempts: (current?.attempts ?? 0) + 1,
    bestCorrect: beatsBest ? run.correctCount : current!.bestCorrect,
    bestOutOf: beatsBest ? run.outOf : current!.bestOutOf,
    // Set once, never cleared.
    passedAt: current?.passedAt ?? (run.passed ? run.at : null),
    lastAttemptId: run.attemptId,
    lastAttemptAt: run.at,
  };
}

/** Applied inside the grading transaction so progress can never drift from the attempts. */
export async function recordTaskSetRun(
  tx: Prisma.TransactionClient | PrismaClient,
  params: { userId: string; taskSetId: string; run: GradedRun },
): Promise<void> {
  const current = await tx.taskSetProgress.findUnique({
    where: { userId_taskSetId: { userId: params.userId, taskSetId: params.taskSetId } },
    select: {
      attempts: true,
      bestCorrect: true,
      bestOutOf: true,
      passedAt: true,
      lastAttemptId: true,
      lastAttemptAt: true,
    },
  });
  const next = nextProgress(current, params.run);
  await tx.taskSetProgress.upsert({
    where: { userId_taskSetId: { userId: params.userId, taskSetId: params.taskSetId } },
    create: { userId: params.userId, taskSetId: params.taskSetId, ...next },
    update: next,
  });
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm exec vitest run src/server/services/task-sets/progress.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Call it from `gradeAndClose`**

In `attempt-service.ts`, import `recordTaskSetRun` from `@/server/services/task-sets/progress`, and
inside the existing `db.$transaction` in `gradeAndClose` — after the `examAttempt.update`, before
`attestAttempt` — add:

```ts
      // Denormalized standing, written in the SAME transaction as the grade so the grid can never
      // show a result the attempt table disagrees with.
      if (attempt.taskSetId) {
        await recordTaskSetRun(tx, {
          userId: attempt.userId,
          taskSetId: attempt.taskSetId,
          run: {
            correctCount: grade.correctCount,
            outOf: attempt.questionCountSnapshot,
            passed: grade.passed,
            attemptId: attempt.id,
            at: clock.now(),
          },
        });
      }
```

- [ ] **Step 6: Run the full engine suite**

Run: `pnpm exec vitest run src/server/services/quiz src/server/services/task-sets`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server/services/task-sets/progress.ts src/server/services/task-sets/progress.test.ts src/server/services/quiz/attempt-service.ts
git commit -m "spec-16: task set progress written in the grading transaction"
```

---

## Phase 2 — Admin builder

### Task 6: Task set service — build, publish, archive, read

**Files:** Create `src/server/contracts/task-sets.ts`, `src/server/services/task-sets/service.ts`,
`src/server/services/task-sets/index.ts`, `src/server/services/task-sets/service.integration.test.ts`

- [ ] **Step 1: Write the contracts (Zod in AND out — mandate)**

```ts
// src/server/contracts/task-sets.ts
import { z } from "zod";
import { idSchema } from "./common";

export const buildTaskSetsInputSchema = z
  .object({ licenseClassCode: z.string().min(1) })
  .strict();
export type BuildTaskSetsInput = z.infer<typeof buildTaskSetsInputSchema>;

export const sliceCompositionSchema = z.object({
  topicCounts: z.record(z.string(), z.number().int()),
  typeCounts: z.record(z.string(), z.number().int()),
  avgDifficulty: z.number(),
  warnings: z.array(z.string()),
});

export const taskSetSummarySchema = z.object({
  id: idSchema,
  number: z.int().min(1),
  status: z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]),
  poolSize: z.int(),
  paperSize: z.int(),
  passMark: z.int(),
  timeLimitSec: z.int(),
  composition: sliceCompositionSchema,
});
export type TaskSetSummary = z.infer<typeof taskSetSummarySchema>;

export const buildResultSchema = z.object({
  buildId: idSchema,
  sets: z.array(taskSetSummarySchema),
  itemsPlaced: z.int(),
  orphaned: z.array(idSchema),
  warnings: z.array(z.string()),
});
export type BuildResult = z.infer<typeof buildResultSchema>;

/** One numbered tile as the student's grid needs it. */
export const studentTaskSetSchema = z.object({
  id: idSchema,
  number: z.int().min(1),
  paperSize: z.int(),
  passMark: z.int(),
  timeLimitSec: z.int(),
  attempts: z.int(),
  bestCorrect: z.number().int().nullable(),
  bestOutOf: z.number().int().nullable(),
  passed: z.boolean(),
  inProgressAttemptId: idSchema.nullable(),
});
export type StudentTaskSet = z.infer<typeof studentTaskSetSchema>;

export const studentTaskSetBoardSchema = z.object({
  sets: z.array(studentTaskSetSchema),
  passedCount: z.int(),
  totalCount: z.int(),
  nextNumber: z.number().int().nullable(),
});
export type StudentTaskSetBoard = z.infer<typeof studentTaskSetBoardSchema>;
```

- [ ] **Step 2: Write the failing integration test**

```ts
// src/server/services/task-sets/service.integration.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { taskSetService } from ".";

describe("taskSetService", () => {
  beforeEach(async () => {
    await db.taskSetMember.deleteMany();
    await db.taskSetProgress.deleteMany();
    await db.taskSet.deleteMany();
    await db.taskSetBuild.deleteMany();
  });

  it("places every approved item and reports zero orphans", async () => {
    const result = await taskSetService.build({ licenseClassCode: "B" }, null);
    const approved = await db.masterItem.count({
      where: { status: "APPROVED", deletedAt: null, variants: { some: { isActive: true } } },
    });
    expect(result.orphaned).toEqual([]);
    expect(result.itemsPlaced).toBe(approved);
  });

  it("publishes DRAFT sets and only then serves them to students", async () => {
    const built = await taskSetService.build({ licenseClassCode: "B" }, null);
    expect((await taskSetService.studentBoard("user-1")).sets).toHaveLength(0);
    await taskSetService.publish(built.buildId);
    expect((await taskSetService.studentBoard("user-1")).sets.length).toBeGreaterThan(0);
  });

  it("keeps a slice's number across a rebuild when its membership is unchanged", async () => {
    const first = await taskSetService.build({ licenseClassCode: "B" }, null);
    await taskSetService.publish(first.buildId);
    const before = (await taskSetService.studentBoard("user-1")).sets.map((s) => s.number);

    const second = await taskSetService.build({ licenseClassCode: "B" }, null);
    await taskSetService.publish(second.buildId);
    const after = (await taskSetService.studentBoard("user-1")).sets.map((s) => s.number);

    expect(after).toEqual(before);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm exec vitest run src/server/services/task-sets/service.integration.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the service**

```ts
// src/server/services/task-sets/service.ts
import type { PrismaClient, Prisma } from "@prisma/client";
import {
  buildResultSchema,
  buildTaskSetsInputSchema,
  studentTaskSetBoardSchema,
  type BuildResult,
  type StudentTaskSetBoard,
} from "@/server/contracts/task-sets";
import { InternalError, NotFoundError } from "@/server/http/errors";
import { partitionBank, type PartitionItem } from "./partition";

/** poolSize = ceil(paperSize × POOL_RATIO). Spec-16: 1.5. */
const POOL_RATIO = 1.5;

export function createTaskSetService(db: PrismaClient) {
  /**
   * Partition the approved bank into DRAFT sets. Nothing here reaches a student: publishing is a
   * separate, deliberate act, so an admin always sees a set's composition before anyone sits it.
   */
  async function build(rawInput: unknown, requestedById: string | null): Promise<BuildResult> {
    const input = buildTaskSetsInputSchema.parse(rawInput);

    const licenseClass = await db.licenseClass.findFirst({
      where: { code: input.licenseClassCode, isEnabled: true },
      select: { id: true, questionCount: true, passMark: true, timeLimitMin: true },
    });
    if (!licenseClass) throw new NotFoundError({ licenseClassCode: input.licenseClassCode });

    // Only what can actually be served: approved, undeleted, with a live variant.
    // Served by MasterItem_topicId_status_type_idx + ItemVariant_masterItemId_isActive_idx.
    const rows = await db.masterItem.findMany({
      where: {
        status: "APPROVED",
        deletedAt: null,
        variants: { some: { isActive: true } },
        OR: [{ licenseClassId: null }, { licenseClassId: licenseClass.id }],
      },
      select: { id: true, type: true, difficulty: true, topic: { select: { slug: true, parentId: true } }, topicId: true },
    });

    const rootSlug = await rootSlugByTopicId(db);
    const items: PartitionItem[] = rows.map((row) => ({
      masterItemId: row.id,
      topicSlug: rootSlug.get(row.topicId) ?? row.topic.slug,
      type: row.type,
      difficulty: row.difficulty,
    }));

    const existing = await db.taskSet.findMany({
      where: { licenseClassId: licenseClass.id, status: "PUBLISHED" },
      select: { number: true, members: { select: { masterItemId: true } } },
    });

    const partition = partitionBank(items, {
      paperSize: licenseClass.questionCount,
      poolRatio: POOL_RATIO,
      existing: existing.map((set) => ({
        number: set.number,
        masterItemIds: set.members.map((m) => m.masterItemId),
      })),
    });

    // Publishing partial coverage would silently break the guarantee the whole model rests on.
    if (partition.orphaned.length > 0) {
      throw new InternalError({ reason: "partition orphaned items", count: partition.orphaned.length });
    }

    const warnings = partition.slices.flatMap((slice) =>
      slice.composition.warnings.map((w) => `#${slice.number}: ${w}`),
    );

    const build = await db.taskSetBuild.create({
      data: {
        status: "READY",
        stats: { setsProposed: partition.slices.length, itemsPlaced: items.length } as Prisma.InputJsonValue,
        warnings: warnings as unknown as Prisma.InputJsonValue,
        requestedById,
      },
      select: { id: true },
    });

    const created = [];
    for (const slice of partition.slices) {
      const paperSize = Math.min(licenseClass.questionCount, slice.masterItemIds.length);
      const set = await db.taskSet.create({
        data: {
          number: slice.number,
          licenseClassId: licenseClass.id,
          status: "DRAFT",
          poolSize: slice.masterItemIds.length,
          paperSize,
          // The official ratio, scaled when a short final slice cannot fill a full paper.
          passMark: Math.ceil((paperSize * licenseClass.passMark) / licenseClass.questionCount),
          timeLimitSec: licenseClass.timeLimitMin * 60,
          composition: slice.composition as unknown as Prisma.InputJsonValue,
          buildId: build.id,
        },
        select: { id: true, number: true, status: true, poolSize: true, paperSize: true, passMark: true, timeLimitSec: true, composition: true },
      });
      created.push(set);
    }

    return buildResultSchema.parse({
      buildId: build.id,
      sets: created,
      itemsPlaced: items.length,
      orphaned: partition.orphaned,
      warnings,
    });
  }

  /**
   * Swap a build's DRAFT sets in for the current PUBLISHED ones, atomically. Old sets are ARCHIVED
   * rather than deleted: their progress rows and attempts must still explain a test a student sat.
   */
  async function publish(buildId: string): Promise<void> {
    const drafts = await db.taskSet.findMany({
      where: { buildId, status: "DRAFT" },
      select: { id: true, licenseClassId: true, number: true },
    });
    if (drafts.length === 0) throw new NotFoundError({ buildId });
    const licenseClassId = drafts[0].licenseClassId;

    await db.$transaction(async (tx) => {
      await tx.taskSet.updateMany({
        where: { licenseClassId, status: "PUBLISHED", buildId: { not: buildId } },
        data: { status: "ARCHIVED" },
      });
      await tx.taskSet.updateMany({
        where: { buildId, status: "DRAFT" },
        data: { status: "PUBLISHED", publishedAt: new Date() },
      });
    });
  }

  /** The student grid: published sets + this user's standing, in ONE progress read. */
  async function studentBoard(userId: string): Promise<StudentTaskSetBoard> {
    const sets = await db.taskSet.findMany({
      where: { status: "PUBLISHED" },
      orderBy: { number: "asc" },
      select: { id: true, number: true, paperSize: true, passMark: true, timeLimitSec: true },
    });
    // Served by TaskSetProgress_userId_idx — one round trip for every set.
    const progress = await db.taskSetProgress.findMany({
      where: { userId },
      select: { taskSetId: true, attempts: true, bestCorrect: true, bestOutOf: true, passedAt: true },
    });
    const open = await db.examAttempt.findMany({
      where: { userId, status: "IN_PROGRESS", taskSetId: { not: null } },
      select: { id: true, taskSetId: true },
    });

    const byId = new Map(progress.map((p) => [p.taskSetId, p]));
    const openById = new Map(open.map((a) => [a.taskSetId!, a.id]));

    const mapped = sets.map((set) => {
      const p = byId.get(set.id);
      return {
        ...set,
        attempts: p?.attempts ?? 0,
        bestCorrect: p?.bestCorrect ?? null,
        bestOutOf: p?.bestOutOf ?? null,
        passed: Boolean(p?.passedAt),
        inProgressAttemptId: openById.get(set.id) ?? null,
      };
    });

    return studentTaskSetBoardSchema.parse({
      sets: mapped,
      passedCount: mapped.filter((s) => s.passed).length,
      totalCount: mapped.length,
      nextNumber: mapped.find((s) => !s.passed)?.number ?? null,
    });
  }

  return { build, publish, studentBoard };
}

async function rootSlugByTopicId(db: PrismaClient): Promise<Map<string, string>> {
  const topics = await db.topic.findMany({
    where: { deletedAt: null },
    select: { id: true, slug: true, parentId: true },
  });
  const byId = new Map(topics.map((t) => [t.id, t]));
  const out = new Map<string, string>();
  for (const topic of topics) {
    let node = topic;
    while (node.parentId && byId.has(node.parentId)) node = byId.get(node.parentId)!;
    out.set(topic.id, node.slug);
  }
  return out;
}
```

```ts
// src/server/services/task-sets/index.ts
import { db } from "@/server/db";
import { createTaskSetService } from "./service";

export const taskSetService = createTaskSetService(db);
export { nextProgress, recordTaskSetRun } from "./progress";
export { partitionBank } from "./partition";
```

- [ ] **Step 5: Run the tests**

Run: `pnpm exec vitest run src/server/services/task-sets`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/contracts/task-sets.ts src/server/services/task-sets
git commit -m "spec-16: task set build/publish/read service"
```

---

### Task 7: Admin build board

**Files:** Create `src/app/[locale]/(admin)/admin/task-sets/page.tsx` and `actions.ts`

- [ ] **Step 1: Server actions**

```ts
// src/app/[locale]/(admin)/admin/task-sets/actions.ts
"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/server/auth/require-user";
import type { ActionResult } from "@/server/contracts/common";
import { toActionError } from "@/server/http/action-result";
import { taskSetService } from "@/server/services/task-sets";
import { schoolConfig } from "../../../../../../config/school.config";

export async function buildTaskSetsAction(): Promise<ActionResult> {
  const user = await requireRole("ADMIN");
  try {
    await taskSetService.build(
      { licenseClassCode: schoolConfig.licenseClassSeeds[0].code },
      user.id,
    );
  } catch (error) {
    return toActionError(error);
  }
  revalidatePath("/admin/task-sets");
  return { ok: true };
}

export async function publishTaskSetsAction(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  await requireRole("ADMIN");
  try {
    await taskSetService.publish(String(formData.get("buildId") ?? ""));
  } catch (error) {
    return toActionError(error);
  }
  revalidatePath("/admin/task-sets");
  revalidatePath("/task-sets");
  return { ok: true };
}
```

> Check the exact export name of the role guard in `src/server/auth/require-user.ts` and match it —
> other admin routes in `src/app/[locale]/(admin)/admin/*/page.tsx` show the established pattern.
> Follow whichever they use rather than introducing a second one.

- [ ] **Step 2: The page**

An RSC listing the latest builds and their sets: number, pool size, paper size, pass mark, topic
count, average difficulty and warnings; a **Rebuild sets** button; a **Publish** button per DRAFT
build. Desktop-first (admin panel rule), all strings from `admin.taskSets.*`.

- [ ] **Step 3: Verify by hand**

```bash
pnpm dev
```
Visit `/en/admin/task-sets`, click Rebuild, confirm sets appear as DRAFT with compositions, click
Publish, confirm they flip to PUBLISHED.

- [ ] **Step 4: Commit**

```bash
git add "src/app/[locale]/(admin)/admin/task-sets"
git commit -m "spec-16: admin task set build board"
```

---

## Phase 3 — Student UI

### Task 8: i18n keys

**Files:** Modify `src/i18n/messages/en.json`, `src/i18n/messages/nb.json`

- [ ] **Step 1: Add the `taskSets` namespace**

`en`:

```json
"taskSets": {
  "title": "Task sets",
  "heroTitle": "Task sets",
  "heroSubtitle": "Full mock exams · {count} questions · {minutes} min",
  "progress": "{passed} of {total} passed",
  "nextUp": "Next up: #{number}",
  "setNumber": "Task set #{number}",
  "meta": "{count} questions · {minutes} min · pass at {mark}",
  "best": "Best",
  "attempts": "Attempts",
  "inPool": "In pool",
  "start": "Start",
  "tryAgain": "Try again",
  "resume": "Resume",
  "passed": "Passed",
  "failed": "Failed",
  "inProgress": "In progress",
  "yourAttempts": "Your attempts",
  "noAttempts": "You have not sat this set yet.",
  "emptyTitle": "No task sets yet",
  "emptyBody": "Your driving school is still preparing them. This page will open as soon as the first sets are published.",
  "poolNote": "Each sitting draws {paper} questions from {pool}, so no two attempts are the same.",
  "close": "Close"
}
```

`nb` — the vocabulary fixed at approval:

```json
"taskSets": {
  "title": "Oppgavesett",
  "heroTitle": "Oppgavesett",
  "heroSubtitle": "Fullstendige prøveeksamener · {count} spørsmål · {minutes} min",
  "progress": "{passed} av {total} bestått",
  "nextUp": "Neste: #{number}",
  "setNumber": "Oppgavesett #{number}",
  "meta": "{count} spørsmål · {minutes} min · bestått ved {mark}",
  "best": "Beste",
  "attempts": "Forsøk",
  "inPool": "I utvalget",
  "start": "Start",
  "tryAgain": "Prøv igjen",
  "resume": "Fortsett",
  "passed": "Bestått",
  "failed": "Ikke bestått",
  "inProgress": "Pågår",
  "yourAttempts": "Dine forsøk",
  "noAttempts": "Du har ikke tatt dette settet ennå.",
  "emptyTitle": "Ingen oppgavesett ennå",
  "emptyBody": "Trafikkskolen din forbereder dem fortsatt. Denne siden åpnes så snart de første settene er publisert.",
  "poolNote": "Hvert forsøk trekker {paper} spørsmål fra {pool}, så ingen to forsøk er like.",
  "close": "Lukk"
}
```

- [ ] **Step 2: Rewrite the `home` keys that changed**

Replace `mockExam` / `mockExamLocked` / `mockExampLockedHint` / `topicPractice` usage with:

```json
"practice": "Practice",
"practiceSub": "Your rules",
"signTest": "Sign test",
"signTestSub": "{count} signs",
"previousTests": "My previous tests"
```

nb: `"practice": "Øving"`, `"practiceSub": "Dine regler"`, `"signTest": "Skiltest"`,
`"signTestSub": "{count} skilt"`, `"previousTests": "Mine tidligere prøver"`.

Leave `theoryTest*` / `imageQuiz*` keys in place for now; remove them in Task 11 once no component
references them, so a half-applied change cannot produce a missing-key crash.

- [ ] **Step 3: Verify both files parse and have the same shape**

```bash
node -e "
const en=require('./src/i18n/messages/en.json'), nb=require('./src/i18n/messages/nb.json');
const keys=o=>Object.entries(o).flatMap(([k,v])=>typeof v==='object'&&v?keys(v).map(s=>k+'.'+s):[k]);
const a=new Set(keys(en)), b=new Set(keys(nb));
const miss=[...a].filter(k=>!b.has(k)), extra=[...b].filter(k=>!a.has(k));
console.log('missing in nb:',miss); console.log('extra in nb:',extra);
if(miss.length||extra.length) process.exit(1);
"
```
Expected: two empty arrays, exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/i18n/messages
git commit -m "spec-16: task set i18n, en + nb"
```

---

### Task 9: The task set grid and start sheet

**Files:** Create `src/app/[locale]/(student)/task-sets/page.tsx`,
`src/app/[locale]/(student)/task-sets/loading.tsx`,
`src/components/task-sets/task-set-grid.tsx`, `src/components/task-sets/task-set-sheet.tsx`;
modify `src/app/[locale]/(student)/quiz/actions.ts`

Visual reference: `specs/assets/spec-16/taskset-grid.html` (option G1 + the sheet).

- [ ] **Step 1: Add the start action**

In `quiz/actions.ts`:

```ts
export async function startTaskSetAction(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const locale = String(formData.get("locale") ?? "en") as AppLocale;

  let attemptId: string;
  try {
    const attempt = await attemptService.startQuiz(user.id, {
      mode: "TASK_SET",
      taskSetId: String(formData.get("taskSetId") ?? ""),
      locale,
    });
    attemptId = attempt.id;
  } catch (error) {
    const mapped = toActionError(error);
    if (mapped.code === "EXAM_STATE") {
      return { ...mapped, messageKey: "quiz.errors.noQuestions" };
    }
    return mapped;
  }

  redirect({ href: `/quiz/${attemptId}`, locale });
  return { ok: true };
}
```

- [ ] **Step 2: The page (RSC)**

```tsx
// src/app/[locale]/(student)/task-sets/page.tsx
import { getTranslations, setRequestLocale } from "next-intl/server";
import { TaskSetGrid } from "@/components/task-sets/task-set-grid";
import { requireUser } from "@/server/auth/require-user";
import { taskSetService } from "@/server/services/task-sets";
import type { AppLocale } from "../../../../../config/school.config";

export default async function TaskSetsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requireUser();

  const [t, board] = await Promise.all([
    getTranslations("taskSets"),
    taskSetService.studentBoard(user.id),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col gap-5 px-4 py-6">
      <header className="space-y-1.5">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {t("title")}
        </h1>
      </header>
      <TaskSetGrid board={board} locale={locale as AppLocale} />
    </div>
  );
}
```

- [ ] **Step 3: The grid component**

`task-set-grid.tsx` (client): renders the empty state when `board.sets.length === 0`; otherwise a
`grid-cols-3 gap-2.5` of tiles. Tile states, per the approved mockup:

- passed → `bg-[--status-success-soft] border-[--status-success]`, a tick badge, best score below
- in progress → `border-[--brand-primary]`, `t("resume")` below
- attempted, not passed → default surface, `bestCorrect/bestOutOf` in `text-muted-foreground`
- fresh → default surface, no sub-label

Each tile is a `<button>` at `min-h-[70px]` (≥44px), opens the sheet, and carries an
`aria-label` of `t("setNumber", { number })` plus its state.

- [ ] **Step 4: The sheet component**

`task-set-sheet.tsx` (client): a `role="dialog"` `aria-modal="true"` bottom sheet. Contents: title,
`t("meta")`, a three-up of best / attempts / in-pool, the primary form posting
`startTaskSetAction` (label `t("start")` when `attempts === 0`, else `t("tryAgain")`; when
`inProgressAttemptId` is set, a link to `/quiz/{id}` labelled `t("resume")`), `t("poolNote")`, then
the attempt list. **Esc closes and focus returns to the originating tile.** Animate with
`transform`/`opacity` only, and respect `prefers-reduced-motion`.

- [ ] **Step 5: The skeleton**

`loading.tsx` renders a header block plus 12 rounded `bg-muted` tiles at the same dimensions as
real ones — no spinner, no layout shift when data arrives.

- [ ] **Step 6: Verify at 390px**

```bash
pnpm dev
```
Open `/en/task-sets` at 390px width. Confirm: no horizontal scroll, tiles ≥44px, tab reaches every
tile, Enter opens the sheet, Esc closes it and focus lands back on the tile.

- [ ] **Step 7: Commit**

```bash
git add "src/app/[locale]/(student)/task-sets" src/components/task-sets "src/app/[locale]/(student)/quiz/actions.ts"
git commit -m "spec-16: task set grid and start sheet"
```

---

### Task 10: Homepage restructure

**Files:** Modify `src/app/[locale]/page.tsx`, `src/components/quiz/start-tiles.tsx`,
`src/components/quiz/recent-tests.tsx`; create `src/components/task-sets/task-set-hero.tsx`

Visual reference: `specs/assets/spec-16/home-tiles-v2.html` (layout B3) and
`specs/assets/spec-16/icons.html` (glyphs).

- [ ] **Step 1: The hero card**

```tsx
// src/components/task-sets/task-set-hero.tsx
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import type { StudentTaskSetBoard } from "@/server/contracts/task-sets";

/**
 * The homepage's primary action (spec-16). Task sets are the product loop, so they carry the
 * weight — and they are the only entry point with a progress story to tell.
 */
export async function TaskSetHero({
  board,
  paperSize,
  minutes,
}: {
  board: StudentTaskSetBoard;
  paperSize: number;
  minutes: number;
}) {
  const t = await getTranslations("taskSets");
  const pct =
    board.totalCount === 0 ? 0 : (board.passedCount / board.totalCount) * 100;

  return (
    <Link
      href="/task-sets"
      className="block rounded-[calc(var(--radius-base)+2px)] bg-[var(--brand-primary)] p-4 text-[var(--brand-primary-fg)] shadow-[var(--shadow-card)] transition-transform duration-150 active:scale-[0.99] motion-reduce:transition-none"
    >
      <div className="flex items-center gap-3">
        {/* icon */}
        <div>
          <p className="text-lg font-semibold tracking-tight">{t("heroTitle")}</p>
          <p className="text-xs/relaxed opacity-85">
            {t("heroSubtitle", { count: paperSize, minutes })}
          </p>
        </div>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/25">
        <div
          className="h-full rounded-full bg-white transition-[width] duration-500 motion-reduce:transition-none"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-2 flex justify-between text-xs opacity-90">
        <span>{t("progress", { passed: board.passedCount, total: board.totalCount })}</span>
        {board.nextNumber ? <span>{t("nextUp", { number: board.nextNumber })}</span> : null}
      </div>
    </Link>
  );
}
```

- [ ] **Step 2: Reduce `StartTiles` to two**

Delete the `theoryTest`, `imageQuiz` and `mockExam` tiles and the topic-practice `<Card>` entirely.
What remains is a `grid-cols-2` of:

- **Practice** → a `<Link href="/quiz/new">` (it opens the setup screen — no form post)
- **Sign test** → the existing form posting `startQuizAction` with `mode=SIGN`, `itemType=SIGN`,
  `questionCount=10`, unchanged and still gated on `counts.SIGN > 0`

Both use a bare 54px glyph with **no tinted container**, per the approved mockup:

```tsx
import { Car, TrafficSign } from "@phosphor-icons/react/dist/ssr";
// …
<Car size={54} weight="fill" aria-hidden />
<TrafficSign size={54} weight="fill" aria-hidden />
```

Drop the now-unused `Exam`, `ImageSquare` and `CarProfile` imports, and the `examReady` /
`examShortfall` / `topics` props along with the values feeding them in `page.tsx`.

- [ ] **Step 3: Homepage query changes**

In `page.tsx`: drop the `examReadiness` and root-`topics` reads (nothing consumes them now), add
`taskSetService.studentBoard(user.id)` and the `LicenseClass` read for `paperSize` / `minutes` to
the existing `Promise.all`, and raise the history page size from 3 to **10**. Render order:
`ResumeCard` → `TaskSetHero` → `StartTiles` → stats → `CategoryProgress` → `RecentTests`.

- [ ] **Step 4: `RecentTests` labels every type**

Add a mode label per row: `TASK_SET` → `t("setNumber", { number })`, `SIGN` → `t("signTest")`,
everything else → practice with its question count. Add the **See all** link to
`/account/history` under the list.

- [ ] **Step 5: Verify**

```bash
pnpm exec tsc --noEmit && pnpm exec eslint src --max-warnings 0
```
Expected: clean. Then `pnpm dev` and check `/en` and `/nb` at 390px.

- [ ] **Step 6: Commit**

```bash
git add "src/app/[locale]/page.tsx" src/components/quiz src/components/task-sets
git commit -m "spec-16: homepage — task set hero, Practice + Sign test only"
```

---

### Task 11: Remove the dead keys and prove nothing references them

- [ ] **Step 1: Confirm no component uses the retired keys**

```bash
grep -rn "theoryTest\|imageQuiz\|mockExam\|topicPractice" src/ --include="*.tsx" --include="*.ts"
```
Expected: no output.

- [ ] **Step 2: Delete those keys from both message files, then re-run the parity check from Task 8 Step 3.**

- [ ] **Step 3: Commit**

```bash
git add src/i18n/messages
git commit -m "spec-16: drop retired theory/image/mock-exam strings"
```

---

### Task 12: End-to-end proof

**Files:** Create `e2e/task-sets.spec.ts`

- [ ] **Step 1: Write the spec**

Following the existing helpers in `e2e/`:

```ts
import { expect, test } from "@playwright/test";

test.describe("task sets", () => {
  test("home → grid → sheet → sit → pass → retry keeps the tile green", async ({ page }) => {
    await loginAsStudent(page);                       // existing helper

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/en");

    // No horizontal scroll at the design target.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    await page.getByRole("link", { name: /task sets/i }).click();
    await expect(page).toHaveURL(/\/task-sets/);

    await page.getByRole("button", { name: /task set #1/i }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();

    // Esc closes and focus returns to the tile that opened it.
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(page.getByRole("button", { name: /task set #1/i })).toBeFocused();

    await page.getByRole("button", { name: /task set #1/i }).click();
    await sheet.getByRole("button", { name: /^start$/i }).click();
    await expect(page).toHaveURL(/\/quiz\//);

    await answerEveryQuestionCorrectly(page);          // existing helper
    await submitAttempt(page);                         // existing helper

    await page.goto("/en/task-sets");
    await expect(page.getByRole("button", { name: /task set #1.*passed/i })).toBeVisible();
  });

  test("no correct answer reaches the client before submit", async ({ page }) => {
    const bodies: string[] = [];
    page.on("response", async (r) => {
      if (r.url().includes("/quiz/")) bodies.push(await r.text().catch(() => ""));
    });
    await loginAsStudent(page);
    await startTaskSetOne(page);                       // helper added in this task
    expect(bodies.join("")).not.toMatch(/correctOptionKey/);
  });
});
```

- [ ] **Step 2: Run**

Run: `pnpm e2e -- task-sets`
Expected: both tests PASS.

- [ ] **Step 3: Commit**

```bash
git add e2e/task-sets.spec.ts
git commit -m "spec-16: e2e — task set flow, a11y and the pre-submit invariant"
```

---

### Task 13: Verification pass (WORKFLOW Phase C)

- [ ] **Step 1: Run everything**

```bash
pnpm exec tsc --noEmit && pnpm exec eslint src --max-warnings 0 && pnpm test && pnpm e2e
```

- [ ] **Step 2: Prove coverage in SQL**

```bash
pnpm exec prisma db execute --stdin <<'SQL'
SELECT (SELECT count(*) FROM "MasterItem" m
        WHERE m.status='APPROVED' AND m."deletedAt" IS NULL
          AND EXISTS (SELECT 1 FROM "ItemVariant" v WHERE v."masterItemId"=m.id AND v."isActive")
       ) AS approved,
       (SELECT count(*) FROM "TaskSetMember") AS placed;
SQL
```
Expected: the two numbers match.

- [ ] **Step 3: Prove no hardcoded exam constants entered the diff**

```bash
git diff main --unified=0 -- src prisma | grep -nE "^\+.*(\b45\b|\b90\b|\b38\b)" || echo "clean"
```
Any hit must be justified in the notes or removed.

- [ ] **Step 4: Write `specs/notes/spec-16-notes.md`** — every acceptance-checklist item from
      `specs/spec-16-task-sets.md`, each marked PASS/FAIL **with the command output as evidence**.
      Never a bare assertion.

- [ ] **Step 5: Update `specs/README.md`** — spec 16 → ✅ Done, link the plan and the notes.

- [ ] **Step 6: Commit**

```bash
git add specs/notes/spec-16-notes.md specs/README.md
git commit -m "spec-16: verification evidence"
```

---

## Self-review against the spec

| Spec requirement | Task |
|---|---|
| Pool-slice model, 1.5× ratio, short-slice scaling, tiny-remainder merge | 2 |
| `TaskSetMember` unique on `masterItemId` (coverage guarantee) | 1, 13 |
| `assembly.ts` untouched; one optional `taskSetId` filter | 3 |
| `TASK_SET` mode, timed, snapshots, always counts toward guarantee | 4 |
| `passedAt` set once, never cleared | 5 |
| Admin-triggered build, review before publish, number preservation, ARCHIVED keeps history | 6, 7 |
| Student UI: hero, 2 tiles with 54px fill glyphs, 3-up grid, start sheet | 9, 10 |
| Latest 10 attempts, all types, See all | 10 |
| Removals: Theory / Image / Mock Exam tiles + topic dropdown | 10, 11 |
| i18n en + nb (Oppgavesett / Øving / Skiltest) | 8, 11 |
| UI states: skeleton, empty, mobile 390px, keyboard, focus return | 9, 12 |
| No hardcoded 45 / 90 / 38 | 13 |

**Known gap, deliberately deferred:** the spec describes the partitioner as an *AI* run. Tasks 2 and
6 build the **deterministic** partitioner, which satisfies every acceptance-checklist item (balance,
coverage, number preservation) and is fully testable. The AI pass is a swap-in behind the same
`build()` interface — add it once the deterministic baseline is verified green, and log it in
`DECISIONS.md` when it lands. Building it in this order means the AI is measured against something
that works, rather than being the only thing between the feature and a student.

**Caching (spec §Caching) is deliberately NOT in this plan.** `studentBoard` is two indexed reads;
adding Redis before measuring would be optimisation without evidence, and the invalidation surface
(`GradedHook` + publish) is easy to get subtly wrong. Task 13 measures it; if p95 exceeds 150ms,
add the cache then, with the number that justified it.
