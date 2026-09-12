# Spec-20 — Question translation end to end, and an honest publish gate

> On approval (WORKFLOW.md Phase A): create `specs/spec-20-question-translation.md` (objective + this
> checklist), copy this file to `specs/plans/spec-20-plan.md`, add row 20 to `specs/README.md` as
> 📝 Planned, append the five decisions below to `DECISIONS.md`, branch `spec-20-question-translation`.

## Context — why "everything but the questions" happens

The AI translation engine (spec-15) and the background worker (spec-19) already translate question
stems, options and explanations as one unit (`src/server/services/i18n/extract.ts:110-147`). The
symptom "UI is translated, questions/options/explanations are not" is produced by seven concrete
gaps between that engine and what a student is served:

| # | Gap | Where |
|---|-----|-------|
| 1 | Adding a language creates a row and nothing else. No run is planned; an admin must press "Start in background" and the worker must be up. | `src/server/services/i18n/languages.ts:355-414` |
| 2 | Jobs are claimed in `TranslatableEntity` enum order, and `UI_MESSAGE` is declared first. Any run that stalls (quota, 429, pause, a 25-unit slice) has done every UI string and no question. | `src/server/services/i18n/runs.ts:672-679`, enum at `prisma/schema.prisma:1125` |
| 3 | The translated **explanation** is never shown. Both post-grading builders read `ItemVariant.explanation` through `pickLocale` (en/nb only) and discard the overlay's `explanation`; the practice answer/reveal path loads no overlay at all. | `src/server/services/quiz/serializer.ts:126,163`; `attempt-service.ts:479-486,556-564` |
| 4 | Questions reach students only through a **derived copy** (`ITEM_VARIANT` rows) written by `deriveVariantTranslations`. The copy runs per-invocation (a crash mid-run strands masters without variants), is never made when a new question is approved (`publish.ts` does not call it), and **coverage does not count it** — so a language can read 100 %, be switched on, and serve every question in English. | `runs.ts:197-266,1011-1014`; `review.ts:280,418,524`; `languages.ts:250-341` |
| 5 | Topic names, licence-class name and KB source names are translated, counted in coverage, and never read on any student path (`loadTaxonomy`, `mergeName`, `resolveText` have no callers). Citations render the raw slug. | `resolve.ts:115-147`; `serializer.ts:179`; `assessment/history.ts:428`; `quiz/new/page.tsx:54`; `account/history/[attemptId]/page.tsx:206` |
| 6 | No content-change trigger. Approving a question or ingesting a KB source silently leaves that unit English in every added language until someone starts a sync by hand. | `question-bank/publish.ts`, `kb/ingest.ts` |
| 7 | `/xx` routes for everyone before the language is published. The switcher hides it, but a guessed or bookmarked URL shows a student a half-translated site. | `src/app/[locale]/layout.tsx:50-53`, `registry.ts:31` |

Plus policy: `requiresApproval` defaults to **true**, so machine output for a new language is
invisible until a speaker approves each unit — a school without a speaker can never publish.

**The "answer" is covered by the options.** The correct answer is one of the option texts; keys are
never translated (`mergeQuestion`, `resolve.ts:86-112`), so the graded key stays correct.

## Decisions (approved 2026-09-12 — log in DECISIONS.md)

1. **Questions resolve through the MASTER translation.** The exam engine looks up `MASTER_ITEM`
   translations by the variant's `masterItemId`, guarded on `variant.masterVersion === masterItem.version`
   and `variant.source === "TEMPLATE"`. `deriveVariantTranslations` and its four call sites are
   deleted. Coverage (which already counts masters) becomes correct by construction. Supersedes
   spec-15 D1's derived-copy mechanism; the `ITEM_VARIANT` enum value stays, reserved for spec-17
   `AI_VARIATION` variants (own text, own unit). Existing `ITEM_VARIANT` rows are left in place
   (harmless, already excluded from every queue) — no data deletion in the migration.
2. **New languages default to `requiresApproval: false`.** Clean machine output serves once QA
   passes; flagged units are still held and auto-repaired. Existing rows unchanged.
3. **Live drift keeps the language live.** A unit added after publish reads English in that
   language (existing all-or-nothing per-question fallback) until the automatic sync lands; the
   board says "Published · N syncing". No auto-hide.
4. **Adding a language starts translating.** `Language.autoTranslate` (default true, add-form
   checkbox): on add, a FULL run is enqueued; on later content changes a SYNC is planned by the
   worker when idle. The cost-free "Check what is left" preview is unchanged.
5. **Unpublished languages are staff-only.** `/xx` for a language with `studentVisible: false`
   renders for INSTRUCTOR/ADMIN (review needs it); students and anonymous visitors are redirected
   to the same path under `Language.fallbackCode`.

Also, not needing approval: questions are translated **first** (job priority), and the explanation,
topic names and citation source labels are wired into the student paths.

## Schema — one reversible migration `20260912090000_question_translation_integrity`

```prisma
model Language {
  /// Keep this language translated without an admin's click: FULL run on add, SYNC on content change.
  autoTranslate   Boolean   @default(true)
  /// Stamped by any write to translatable source content. The worker plans a SYNC when this is
  /// newer than the latest SYNC/FULL run's createdAt; cleared when nothing is pending.
  syncRequestedAt DateTime?
}
model TranslationJob {
  /// Claim order inside a run: questions first (ENTITY_PRIORITY in units.ts). Set at plan time.
  priority Int @default(0)
  @@index([runId, state, priority, entity])   // replaces [runId, state, entity]: the claim query
}
```

Hand-edit the generated SQL per DECISIONS 2026-08-26 / 2026-09-03: strip the HNSW-index drops, the
generated-column `DROP DEFAULT`s and the `TaskSet_published_number_key` drop Prisma re-proposes;
`prisma/migrations.test.ts` enforces it. Down: drop the three columns, recreate the old index.
No new index on `Language` — the table holds a handful of rows; the worker's idle scan reads it whole.

## File map

**New**
- `src/server/services/i18n/sync.ts` — `requestTranslationSync(db, {locale?})`,
  `planSyncIfPending(db, locale)`, `planAutoSyncs(db)`.
- `src/server/services/i18n/taxonomy.ts` — cached `localizedTopicNames`, `localizedSourceLabels`,
  `invalidateTaxonomy(locale)` (wraps existing `loadTaxonomy`).
- `src/server/services/i18n/sync.integration.test.ts`, `taxonomy.test.ts`,
  `src/server/services/quiz/question-overlay.integration.test.ts`.
- `prisma/migrations/20260912090000_question_translation_integrity/migration.sql`.

**Modified**
- `src/server/services/i18n/resolve.ts` — `loadQuestionOverlay`, `mergeExplanation`.
- `src/server/services/quiz/attempt-service.ts` — `servedRows`, `answer`, `revealAnswered`,
  `buildStoredResult` select master fields and pass the overlay through.
- `src/server/services/quiz/serializer.ts` — explanation from overlay; citations carry `sourceLabel`.
- `src/server/contracts/quiz.ts` — `explanationClientSchema.citations[].sourceLabel`.
- `src/server/services/i18n/runs.ts` — delete `deriveVariantTranslations` + call; `planRun` sets
  `priority`; claim orders by it.
- `src/server/services/i18n/units.ts` — `ENTITY_PRIORITY`.
- `src/server/services/i18n/review.ts`, `scripts/import-translations.ts` — remove derive calls.
- `src/server/services/i18n/repair.ts`, `extract.ts`, `worker.ts` — comments on `ITEM_VARIANT`
  become "reserved for spec-17"; exclusions stay.
- `src/server/services/i18n/languages.ts` — `autoTranslate` in create/update schemas,
  `requiresApproval` default false, FULL run on create, glossary bump requests a sync.
- `src/server/services/i18n/worker.ts` — `deps.autoSync` on an idle tick.
- `src/server/services/i18n/notify.ts` — small unattended syncs do not mail.
- `src/server/services/question-bank/publish.ts`, `src/server/services/kb/ingest.ts` — call
  `requestTranslationSync`.
- `src/server/services/assessment/history.ts` (`categoryPerformance`),
  `src/app/[locale]/(student)/quiz/new/page.tsx` — topic labels through `taxonomy.ts`.
- `src/app/[locale]/(account)/account/history/[attemptId]/page.tsx` — render `sourceLabel`.
- `src/proxy.ts` — set `x-pathname`; `src/app/[locale]/layout.tsx` — the staff-only gate.
- `src/components/admin/languages/language-board.tsx` — add-form checkbox, worker-offline hint,
  derived status pill; `src/app/[locale]/(admin)/admin/languages/actions.ts` — read the checkbox.
- `src/server/redis.ts` — `i18nTaxonomy` gets used; `config/school.config.ts` —
  `ai.translationNotifyMinUnits`.
- `src/i18n/messages/{en,nb}.json`; `scripts/i18n-worker.ts` wires `autoSync`.
- Tests touched: `serializer.test.ts`, `attempt-service.integration.test.ts`,
  `runs.integration.test.ts`, `languages.integration.test.ts`, `review.integration.test.ts`
  (derive assertions → master-resolution assertions), `worker.test.ts`, `notify.integration.test.ts`,
  `e2e/dynamic-languages.spec.ts`, `e2e/languages.spec.ts`, `src/i18n/messages.test.ts`.

## Design by task (implementation order; TDD per WORKFLOW Phase B)

### Task 1 — Serve questions from the master translation (gaps 3, 4)

`resolve.ts`:
```ts
export interface QuestionOverlayRow {
  variantId: string; masterItemId: string; masterVersion: number;
  source: VariantSource; currentMasterVersion: number;
}
/** One batched MASTER_ITEM read for a paper, keyed back by variantId. Index: Translation_locale_entity_entityId_key. */
export async function loadQuestionOverlay(db, locale, rows: QuestionOverlayRow[]): Promise<Overlay>
// TEMPLATE variants mirror their master byte for byte (publish.ts:94-95); AI_VARIATION (spec-17)
// carries its own text and is skipped here until it has its own unit. A masterVersion mismatch
// is skipped: a translation of a different question than the one sat is the failure this exists to avoid.
export function mergeExplanation(source: string, overlay: UnitPayload | undefined): string
```
`attempt-service.ts`: `servedRows` and `buildStoredResult` add
`variant.{masterItemId, masterVersion, source}` and `masterItem.version` to their `select`
(same joined row, no extra query) and call `loadQuestionOverlay`. `answer` and `revealAnswered`
select the same four fields and load the overlay for that one row (one indexed lookup, PK on
`Translation` unique key), passing `translation` into `buildPracticeResult`.
`serializer.ts`: `buildPracticeResult({..., translation?})` and `buildAttemptResult` use
`mergeExplanation(pickLocale(explanation, locale), translation)`. `.strict()` contracts unchanged
for this task. The anti-leak invariant is untouched: `servedRows` still never selects
`correctOptionKey`; `clientQuestionSchema` still has no correctness field.

Delete `deriveVariantTranslations` (`runs.ts:197-266`), the call at `runs.ts:1011-1014` and
`translatedMasterIds` bookkeeping, the three calls in `review.ts` (`:280`, `:418`, `:524`) and
`scripts/import-translations.ts:146`. `review.integration.test.ts:254-322` ("approved master derives
its variant") becomes "approved master is served on its variant" through `loadQuestionOverlay`.

Tests: `serializer.test.ts` gains overlay cases (stem/options/explanation translated; missing
explanation falls back; practice result translated). `question-overlay.integration.test.ts`:
servable-status gate under both policies, `masterVersion` mismatch → English, `AI_VARIATION` →
English, NEEDS_REVIEW never served. `attempt-service.integration.test.ts`: a student in locale `zq`
starts practice, answers, submits, views result — stem, options and explanation are the translation
at every step; `ItemVariant.contentHash` byte-identical before/after (the spec-15 regression).

### Task 2 — Questions first (gap 2)

`units.ts`: `ENTITY_PRIORITY: Record<TranslatableEntity, number>` — MASTER_ITEM 0; TOPIC,
LICENSE_CLASS, KB_SOURCE 1; UI_MESSAGE 2; SIGN 3 (no student path reads sign names yet);
ITEM_VARIANT, EXAM_BLUEPRINT, FACT 9. `planRun` writes `priority` on each job; the claim query
(`runs.ts:674-679`) orders `[{priority:"asc"},{entity:"asc"},{id:"asc"}]` — served by the new
`TranslationJob[runId, state, priority, entity]` index. `planRepairRun`/`planSampleRun` write the
same priority. Test (`runs.integration.test.ts`): a run with TOPIC and MASTER_ITEM jobs claims a
MASTER_ITEM batch first.

### Task 3 — Auto-start and self-maintaining sync (gaps 1, 6)

`sync.ts`:
- `requestTranslationSync(db, {locale?})` — `language.updateMany({ where: { isBuiltIn:false,
  autoTranslate:true, ...(locale ? {code: locale} : {}) }, data: { syncRequestedAt: now } })`.
  Called from `publishItem` (after variants are written — catches transitions, `replaceItem`,
  seed/dedupe scripts), `kb/ingest.ts` after the source upsert, and `updateLanguage` when the
  glossary changes (that locale only). Retire needs nothing: retired items leave `extractAll` and
  `pruneOrphans` sweeps them at the next plan.
- `planSyncIfPending(db, locale)` — `extractAll` → `pendingUnits`; nothing pending → clear
  `syncRequestedAt`, return null; else `planRun({kind:"SYNC", enqueue:true, startedById:null})`.
- `planAutoSyncs(db)` — for each language with `autoTranslate && syncRequestedAt != null`, no live
  enqueued FULL/SYNC/SINGLE_ENTITY/REPAIR run (`startBackgroundRun`'s guard, `run-control.ts:35-43`),
  and `syncRequestedAt >` the latest SYNC/FULL run's `createdAt` (index
  `TranslationRun[locale, status, createdAt]`) — compared against plan time, not finish time, so
  an approval that lands while a run is executing is not lost.
- `createLanguage` (`languages.ts`): input gains `autoTranslate` (default true);
  `requiresApproval` default flips to false in the Zod schema and the form; after the row +
  `invalidateRegistry()`, if `autoTranslate` → `startBackgroundRun(db, actor, {locale, kind:"FULL"})`
  (audit `translationRunEnqueued` already written there). A create must not fail because planning
  failed: wrap the run start, log, and return `{ language, run: RunPlan | null }`.
- `worker.ts`: `WorkerDeps.autoSync: () => Promise<string[]>`; in `workerTick`, when
  `findClaimableRun` returns null → `await deps.autoSync()`; planned anything → return `"worked"`
  (loop re-ticks at once). Injected, so `worker.test.ts` covers "idle tick plans a sync" and
  "a failing autoSync is logged, not fatal". `scripts/i18n-worker.ts` wires `planAutoSyncs`.
- `notify.ts`: a COMPLETED run with `startedById === null`, `flaggedUnits === 0` and
  `plannedUnits < schoolConfig.ai.translationNotifyMinUnits` (default 20) sends no mail — routine
  upkeep is not news. Failures, exhaustion and larger runs mail as today.

Tests (`sync.integration.test.ts`): publish stamps every auto language and not built-ins;
`planSyncIfPending` clears the stamp when nothing is pending and plans exactly the new unit
otherwise; a stamp during a live run is planned after it; `createLanguage` with `autoTranslate`
produces one enqueued FULL run, without it none; `languages.integration.test.ts` default policy
is `requiresApproval: false`.

### Task 4 — Staff-only preview of unpublished languages (gap 7)

`proxy.ts`: after `createMiddleware(...)(request)`, set `x-pathname: request.nextUrl.pathname` on
the response (the layout has no other way to know its path). `[locale]/layout.tsx`: after
`registry.has(locale)`, `const language = registry.get(locale)`; when
`!language.isBuiltIn && !language.studentVisible` → `getSessionUser()` (already called by
`AccountMenu`, cheap JWT read); if no user or `role === "STUDENT"` →
`redirect({ href: <x-pathname minus prefix>, locale: language.fallbackCode })` from
`@/i18n/navigation`. Accept-language negotiation can still send an anonymous visitor to `/xx`
first; the layout bounces them, so no proxy change to `routingFor` is needed.

Tests: `e2e/dynamic-languages.spec.ts` "routes with no redeploy" logs in as an admin (fixture
pattern from `e2e/languages.spec.ts`) and keeps its 200/`lang`/`dir` assertions; a new case asserts
an anonymous visit to `/{CODE}/login` lands on `/en/login`, and a student session is redirected too.

### Task 5 — Topic names and citation labels on student paths (gap 5)

`taxonomy.ts`: `localizedTopicNames(db, locale, topics: {id, slug, name}[])` and
`localizedSourceLabels(db, locale, codes)` → built on `loadTaxonomy`, cached per locale at
`tp:i18n:taxonomy:<locale>` (key already reserved in `redis.ts:53`), TTL 3600 s; built-in locales
short-circuit to `pickBilingualText`. `invalidateTaxonomy(locale)` is called wherever
`invalidateMessages` is (`runs.ts` run end, `review.ts` approve/bulk/edit, `updateLanguage` policy
flip). Call sites: `buildStoredResult` topic names, `categoryPerformance` (`history.ts:428`),
`quiz/new/page.tsx:54`. Citations: `explanationClientSchema.citations[]` gains `sourceLabel`
(strict schema updated); `buildStoredResult`/`answer`/`revealAnswered` resolve labels from
`KbSource.name` by code (one `findMany` on the PK, codes are ≤ 3 per paper) through
`localizedSourceLabels`; the history page renders `sourceLabel ref` instead of the slug. Sign
names stay unread by students (documented; spec-10's catalogue will consume them).

Tests: `taxonomy.test.ts` (fallback chain, cache hit/miss, built-in short-circuit);
`attempt-service.integration.test.ts` result `topicBreakdown[].topicName` and
`review[].explanation.citations[].sourceLabel` are translated in `zq`; `serializer.test.ts`
strict-schema case for `sourceLabel`.

### Task 6 — Admin board and messages

`language-board.tsx`: add form gains "Keep translated automatically" (checked) and, when
`!workerOnline`, an info `FormAlert` "The background worker is offline — the run will wait in the
queue"; `requiresApproval` checkbox now unchecked by default with its existing label. Each card
gets one derived status line (pure helper in `run-view.ts`, unit-tested): Translating… (live run) ·
Needs attention (blockers, no run) · Ready to publish (complete, hidden) · Published ·
Published, {count} syncing (visible, blockers > 0). Card action row also shows the toggle for
`autoTranslate` (Keep translated automatically / Stop). Both locales, keyboard reachable, 44 px
targets, 390 px layout — same components as today (`SubmitButton`, `FormAlert`, `Card`).

i18n keys (both `en.json` and `nb.json`, `admin.languages.*`): `autoTranslate`,
`autoTranslateHint`, `autoTranslateOn`, `autoTranslateOff`, `workerOfflineOnAdd`,
`state.translating`, `state.needsAttention`, `state.readyToPublish`, `state.published`,
`state.publishedSyncing` ({count}); `admin.languages.errors.autoStartFailed`. Parity enforced by
`messages.test.ts`.

## Caching summary

| Read | Mechanism | Invalidation |
|------|-----------|--------------|
| Question overlay per paper / per answer | Direct Postgres, one batched query on `Translation_locale_entity_entityId_key` (built-ins skip it) | none needed — rows are the source |
| Topic / source labels | Redis `tp:i18n:taxonomy:<locale>`, 1 h | `invalidateTaxonomy` on approve, edit, run end, policy flip |
| Registry / messages | unchanged (`tp:i18n:registry`, `tp:i18n:msg:<locale>`) | unchanged |

## Acceptance checklist for spec-20 (verified into `specs/notes/spec-20-notes.md`)

- [ ] Adding a language with "Keep translated automatically" enqueues a FULL run with no further
      click; with it off, nothing is enqueued. (integration + screenshot)
- [ ] With TOPIC and MASTER_ITEM jobs queued, the first batch claimed is questions. (integration)
- [ ] A student in an added language sees translated stem, options **and explanation** in practice
      reveal, on navigate-back, and on the result page; `contentHash` of every variant is
      byte-identical before and after. (integration + e2e)
- [ ] A question approved after a language is published is stamped, a SYNC is planned by the
      idle worker, and the unit reads English in that language only until the run completes.
      (integration)
- [ ] `languageCoverage.complete` is true only when every unit the engine would serve is servable
      — proven by serving a paper in the language and asserting no English text. (integration)
- [ ] `/xx` for an unpublished language: 200 for an admin, redirect to the fallback locale for an
      anonymous visitor and for a student. Published language: 200 for everyone. (e2e)
- [ ] Result page topic names and citation labels render in the added language. (integration)
- [ ] `NEEDS_REVIEW` and `REJECTED` are still never served; bulk approve still refuses
      unconsented flags. (existing tests still green, run explicitly)
- [ ] No `correctOptionKey` in any pre-submission payload (`e2e/student-quiz.spec.ts:160`,
      `task-sets.spec.ts:201`, `sign-test.spec.ts:142` stay green).
- [ ] Both languages, 390 px, keyboard, focus rings on the changed admin card and add form.
- [ ] `pnpm test`, `pnpm exec tsc --noEmit`, `pnpm exec eslint`, `pnpm build`,
      `prisma/migrations.test.ts` all clean.

## Rollout for the languages that already exist (Spanish, Arabic, and whatever production holds)

1. Merge, deploy per `specs/notes/spec-19-notes.md` §Deployment (`prisma migrate deploy`,
   `prisma generate`, build, `pm2 startOrReload`), confirm "Background worker online".
2. On each existing language card: **Start in background** (SYNC — only what is missing/stale, so
   nothing already translated is paid for twice). The worker chains REPAIR runs itself.
3. When it finishes: review the checklist. Bulk-approve rows whose only flags are
   `QA_UNAVAILABLE`/`LENGTH_OUTLIER` (amendment B); read the `ANSWER_PERMUTED` handful.
   Decide per language whether to keep "requires approval" on.
4. **Show to students** unlocks by itself when the list empties. Then `Keep translated
   automatically` holds it there.
5. Quota reality (memory: `gemini-embedding-daily-cap`, `gemini-free-tier-429`): a ~1300-unit
   language on a free Gemini key spends ~1000 embedding calls/day, so QA on a full bank spans
   two days or more. Options, in order: a paid key; lower `qaSampleRate` on the language card
   (school policy, not code); wait. `translationParallelSlots` stays 1 on a free key (`33e8519`).

## Risks and open items

- **Head-of-line blocking** (spec-19 known gap) is untouched: with several languages queued the
  worker works them one at a time.
- **Accept-language** may still route an anonymous visitor to an unpublished prefix for one
  request before the layout redirects; the cookie is then set to the fallback by the next request.
- **`sourceLabel` on citations** touches a `.strict()` client contract; every builder and test
  fixture that constructs citations must add it (compile errors will find them).
- **Sign names** are still counted toward coverage but read by no student screen — cost without
  visible benefit until spec-10. Left in scope of coverage on purpose (spec-15 checklist).
- `ANSWER_PERMUTED` firing on correct translations is a QA calibration question, out of scope.
