# Plan — Spec 04: Question Bank, Sets & AI Accuracy (approved 2026-08-24)

> Approved by the developer in the spec-04 planning session; the eight binding decisions are logged in
> `DECISIONS.md`. Covers [spec-04](../spec-04-question-bank.md) including its
> 2026-08-24 amendment, and the decisions already fixed in [spec-04-brief.md](spec-04-brief.md).

## Context

Auth exists (spec-03), the quiz engine core exists (spec-07), the schema exists (spec-02) — but the
database holds **zero questions**, and there is no way to put one there. Spec-04 builds the surface where
questions live, are reviewed, and are judged.

It carries three jobs at once:

1. **The content workflow** — DRAFT → IN_REVIEW → APPROVED → RETIRED, a bilingual editor, a keyboard
   review queue, import/export.
2. **The instrument for judging AI** (the amendment) — question **sets**, per-question curation, and an
   accuracy dashboard, so that when spec-06 starts generating you can already see what the AI gets right.
3. **The publish step nobody has written yet** — see D1 below. Without it, approving a question does not
   make it reachable by a student, and the whole chain silently produces nothing.

## 1. Binding decisions

| # | Decision | Rationale |
|---|---|---|
| **D1** | **Approval publishes.** `transitionItem(→APPROVED)` materialises `ItemVariant` rows through the spec-07 template engine (`expandTemplate` + `computeContentHash`); items without `parameterSlots` get exactly one variant that mirrors the master content. RETIRE sets `isActive=false` on its variants. | [`PrismaVariantSource`](../../src/server/services/quiz/prisma-variant-source.ts) serves APPROVED masters **joined to active variants** — an approved item with no variant is invisible to students. Neither the spec nor the brief says who creates that first variant; this is the missing link between the bank and the engine. Attempts keep rendering their own snapshot, so retiring never rewrites history. |
| **D2** | **Rejection reasons are a taxonomy, not prose.** New `RejectionReason` enum column (`WRONG_ANSWER`, `AMBIGUOUS_DISTRACTOR`, `CITATION_MISMATCH`, `DUPLICATE`, `LANGUAGE_QUALITY`, `IMAGE_MISMATCH`, `OUT_OF_SCOPE`, `OTHER`) alongside the free-text `reviewNote` the brief already requires. | The amendment asks for "ranked rejection reasons" — free text cannot be ranked. It is also the label set spec-06 needs to turn rejections into few-shot examples ("humans reject this kind of distractor"). |
| **D3** | **Search via a generated `tsvector` + GIN**, added in raw SQL like [`kb_hybrid_search`](../../prisma/migrations/20260824054002_kb_hybrid_search/migration.sql), over the `en`+`nb` stems with the `simple` config. `prisma/migrations.test.ts` is extended to guard it. | Admin search over 10k items must not seq-scan a JSON extract. `simple` (no stemming) avoids applying Norwegian stemming rules to English text; admin search wants literal matching more than recall. Same footgun as KbChunk, so the same guard. |
| **D4** | **One `QuestionCard` component, built here, reused by spec-08.** It takes a client-shaped question (no correctness) plus an **optional** `reveal` prop carrying the correct key and explanation. Admin preview passes `reveal`; the student path structurally cannot. | The spec demands the preview render "exactly as the student sees it" — two implementations would drift within a spec. Making reveal a separate prop keeps the anti-leak invariant visible in the type, not in a comment. |
| **D5** | **INSTRUCTOR** browses, edits and reviews; **ADMIN** additionally imports/exports, bulk-retags and deletes. | Matches spec-11's "instructor sees only content review + their groups". Both gates go through `requireUser()`, so `auth-coverage.test.ts` keeps proving it. |
| **D6** | **Citations stay JSON in spec-04.** `legalCitations` is captured as free `sourceCode` + `ref` (+ optional url) validated by `legalCitationSchema`; the queryable `MasterItemCitation` links are **backfilled by spec-05** when KB chunks and facts exist. | `MasterItemCitation` points at `KbChunk`/`Fact` — tables that are empty until spec-05. Writing rows now would mean writing dangling ones. The editor's picker is a plain combobox in 04 and becomes KB-backed in 05. |
| **D7** | **No version-history table.** Editing an APPROVED item bumps `version`; the previous content snapshot goes into the `AuditLog.meta` of that edit. | Follows the brief's explicit "no version table" call. Old renderings already survive as immutable variants; the audit snapshot is what makes a rollback possible without a new table. |
| **D8** | **Seed + volume script.** `prisma/seed-items.ts` (idempotent, ~24 realistic bilingual class-B items across the seeded topics, HUMAN provenance) and `scripts/seed-volume.ts` (10k items, transactional, rolled back after measurement). | The spec is otherwise unverifiable and the app undemoable: every screen in it renders an empty table. The volume script is the same method spec-02 used for its EXPLAIN evidence. |

## 2. Schema delta (one migration)

```prisma
enum BatchKind       { IMAGE  THEORY  MANUAL }
enum BatchStatus     { PENDING  RUNNING  READY  FAILED }
enum RejectionReason { WRONG_ANSWER  AMBIGUOUS_DISTRACTOR  CITATION_MISMATCH  DUPLICATE
                       LANGUAGE_QUALITY  IMAGE_MISMATCH  OUT_OF_SCOPE  OTHER }

/// A generated question SET — the unit reviewed, curated and measured (spec-04 amendment).
model GenerationBatch {
  id             String      @id @default(cuid())
  kind           BatchKind
  status         BatchStatus @default(PENDING)
  sourceImageId  String?     // IMAGE batches (spec-06 populates)
  topicId        String?     // THEORY batches
  licenseClassId String?
  requestedCount Int         @default(5)
  providerId     String?     // spec-05 AiProvider — plain column until that table exists
  modelVersion   String?
  promptVersion  String?
  notes          String?
  createdById    String?
  createdAt      DateTime    @default(now())
  updatedAt      DateTime    @updatedAt

  items       MasterItem[]
  sourceImage ImageAsset?   @relation(fields: [sourceImageId], references: [id])
  topic       Topic?        @relation(fields: [topicId], references: [id])
  createdBy   User?         @relation("BatchCreator", fields: [createdById], references: [id])

  @@index([status, createdAt(sort: Desc)])  // set board, newest first
  @@index([sourceImageId])                  // "sets made from this image" (spec-06)
}
```

`MasterItem` additions: `batchId String?` (+ relation), `reviewReason RejectionReason?`, and
`searchText Unsupported("tsvector")?` (raw SQL generated column). New indexes:

| Index | Query it serves |
|---|---|
| `MasterItem(batchId, status)` | set detail: every question of one set, grouped by state |
| `MasterItem(createdBy, status, reviewedAt)` | accuracy dashboard: AI items in a terminal state over a date range |
| `MasterItem(searchText)` GIN | admin search box |
| `GenerationBatch(status, createdAt DESC)` | set board |

**Migration hygiene** (DECISIONS 2026-08-24): the generated SQL will again propose dropping `KbChunk`'s
HNSW index — strip it, and extend `prisma/migrations.test.ts` to guard `MasterItem_searchText_idx` the
same way.

## 3. Contracts (`src/server/contracts/question-bank.ts` — extend)

Already present and used as-is: `listItemsInput`, `upsertItemInput` (with the exactly-one-correct
`superRefine`), `transitionItemInput`, `bulkActionInput`, `itemListRow`.

New, all `.strict()`, input **and** output:
`rejectionReasonSchema` · `listBatchesInput` / `batchSummary` (kind, source, counts by status, acceptance
rate, provenance) / `batchDetail` (items + validator report + provenance) · `attachItemsToBatchInput` /
`detachItemInput` · `accuracyStatsInput` (date range, groupBy `model | prompt | topic`) /
`accuracyStats` (rows of {key, reviewed, approved, rate, medianHoursToReview} + ranked reasons) ·
`itemExportSchema` / `importResultSchema` (per-row outcome, mirroring the spec-03 CSV import shape) ·
`publishResultSchema` (variantsCreated, skipped).

## 4. Services — `src/server/services/question-bank/`

| File | Owns |
|---|---|
| `items.ts` | list (filters + search + pagination), get, upsert; version bump + audit snapshot (D7) on APPROVED edit |
| `transitions.ts` | THE `transitionItem()` with the allowed-transitions map; rejection requires reason + taxonomy; calls publish/unpublish |
| `publish.ts` | D1 — materialise variants on approve (template expansion, `computeContentHash`, dedupe on the unique hash), deactivate on retire |
| `batches.ts` | set list, set detail, attach/detach, retire-from-set |
| `stats.ts` | acceptance rate by model / prompt / topic, ranked reasons, median time-to-review |
| `io.ts` | JSON + CSV import/export, lossless bilingual + citations |

Reuse: `requireUser()` ([require-user.ts](../../src/server/auth/require-user.ts)), `auditLog()`
([audit.ts](../../src/server/audit.ts)), `parseCsvRecords` ([csv.ts](../../src/lib/csv.ts) — add a
`toCsv` writer beside it), `expandTemplate`/`computeContentHash` (spec-07), `paginationInputSchema`,
`toActionError` ([action-result.ts](../../src/server/http/action-result.ts)).

## 5. Routes & UI — `(admin)/admin/…` (desktop-first, must not break at 390px)

`questions/` table (filters: topic, status, type, difficulty, language-completeness, search; bulk
approve/retire/retag) · `questions/[id]/` bilingual side-by-side editor with exactly-one-correct
enforcement, citation rows, difficulty/topic, and the live student preview (390px frame, both locales,
light+dark) · `review/` split-view queue with **A** approve / **E** edit / **R** reject (reason dialog)
and J/K navigation · `sets/` board + `sets/[id]/` set detail (source image or topic, per-question
validator report and provenance, Keep/Retire, and *Revise with AI* / *Generate more* rendered disabled
with an explanatory tooltip until spec-06) · `questions/accuracy/` dashboard.

Components: `src/components/quiz/question-card.tsx` (D4, shared with spec-08) and
`src/components/admin/questions/*` for the table, editor, queue, set detail and stats.

**States**: skeleton rows on table load (never a spinner) · empty states for no items / no sets / not
enough reviewed items for stats · inline field errors plus a `role="alert"` summary · optimistic
Keep/Retire with rollback on failure · offline → toast with retry, edits preserved · full keyboard path
with visible focus and an aria-live announcement after each review action.

i18n: `admin.questions.*`, `admin.review.*`, `admin.sets.*`, `admin.accuracy.*`, plus a label per
`RejectionReason` — both locales, guarded by the existing parity and runtime-key tests.

Caching: `keys.qbStats(rangeKey)` → accuracy aggregate, TTL 5 min, invalidated by every transition and
publish. The item table itself stays uncached (write-heavy, always fresh).

## 6. Test plan → acceptance checklist

| Checklist item | Proof |
|---|---|
| Lifecycle transitions enforced server-side | Table-driven unit test over the **full matrix** of (from × to) — every illegal edge throws `ConflictError`; rejection without a reason is rejected |
| Editing approved item creates v+1; old attempts render the old version | Integration: approve → publish variant → serve it in an attempt → edit master → assert `version` 2, the attempt's stored variant unchanged, new variant on next publish |
| Table <150ms p95 at 10k items | `scripts/seed-volume.ts` + EXPLAIN ANALYZE for the list, set-detail, accuracy and search queries; p95 measured over 50 runs and pasted into the notes |
| Keyboard-only review of 10 items | Playwright: A/E/R + J/K through 10 items with zero mouse events, both locales; axe clean |
| Set detail lists exactly its batch, Keep/Retire scoped + audited | Integration on two sets sharing a topic: acting on one leaves the other byte-identical; audit rows asserted |
| Accuracy matches an independent computation | Seeded fixture with known outcomes; the test computes the expected rate in plain TS and compares |
| Set detail + accuracy <150ms p95 at 10k | Same volume run, `MasterItem_batchId_status_idx` named in the plan output |

Plus: publish-on-approve creates exactly one variant for a slot-less item and N for a templated one, and
is idempotent on re-approve (unique `contentHash`) · import/export round-trips bilingual content and
citations losslessly (property test over generated items) · CSV writer/parser round-trip.

## 7. Risks & open questions

1. **Publish (D1) is the highest-risk piece** — it is the seam between the bank and the engine, and it is
   the first time anything writes `ItemVariant`. Mitigation: it is a separate service with its own tests,
   and the integration test proves a published item is actually servable by `PrismaVariantSource`.
2. **Item preview drift.** If spec-08 later re-implements the question UI, the "exactly as the student
   sees it" guarantee dies quietly. D4 makes it one component; spec-08's plan must state that it consumes
   it rather than replacing it.
3. **Citations are unverified until spec-05.** An admin can type a `ref` that no law contains. Accepted
   deliberately (D6); spec-05's backfill will surface the mismatches.
4. **`GenerationBatch.providerId` is a plain column** until spec-05 creates `AiProvider`; the FK is added
   there rather than inventing the table early.
5. Seeded sample items (D8) are illustrative, not legally reviewed content — they carry
   `createdBy: HUMAN`, `status: DRAFT` and a clear note, so they can never be mistaken for approved
   exam material.
