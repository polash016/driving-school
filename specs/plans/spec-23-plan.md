# Spec 23 — Learn: approved implementation plan

**Approved:** 2026-09-24 (plan mode). Source of truth for the build; deviations need a DECISIONS entry.


Verified facts that shape the design: Next 16.3.2 / React 19.2, **no tRPC, no BullMQ** (the i18n
worker is a DB-lease loop over `TranslationRun`), all mutations are server actions → services →
Prisma; `typedRoutes: true`; the two existing AI-in-admin flows (`generateQuestionsAction`,
`generateFromImageAction`) run synchronously inside a server action with a pending button.

### B1. Schema (`prisma/schema.prisma`, new "Learn (spec-23)" section)

Enums: `LearnStatus { DRAFT, PUBLISHED, ARCHIVED }`, `LearnDocKind { ARTICLE, CHAPTER }`;
`TranslatableEntity` += `LEARN_BOOK`, `LEARN_DOCUMENT`, `LEARN_SECTION` (appended).

- **LearnBook**: `id, slug @unique, title Json{en,nb}, description Json?, coverImageId?,
  licenseClassId?, status, sortOrder, publishedAt?, createdById?, updatedById?, timestamps,
  deletedAt?`. Index `[status, sortOrder]` → hub "published books in display order".
- **LearnDocument** (article or chapter): `id, slug @unique, kind, bookId?, chapterOrder?
  (CHAPTER only), topicId, licenseClassId?, title Json, summary Json?, body Json{en,nb markdown},
  heroImageId?, status, publishedAt?, version Int (bumped on any content write), wordCount Json
  {en,nb}, citations Json [{sourceCode, ref}], createdBy Provenance, modelVersion?,
  promptVersion?, createdById?, updatedById?, timestamps, deletedAt?`.
  Indexes: `[bookId, chapterOrder]` → book page + prev/next; `[kind, status, publishedAt desc]` →
  hub article list + admin status filter; `[topicId, status]` → topic filter and the future
  wrong-answer "Read more". `chapterOrder` deliberately NOT unique (reorder rewrites the whole list
  in one transaction; integration test asserts no duplicates).
- **LearnCitation**: `documentId, kbChunkId, sourceCode, ref` (mirrors `MasterItemCitation`);
  indexes `[documentId]`, `[kbChunkId]`.
- **LearnReadingProgress**: `@@id([userId, documentId])`, `positionPct 0–100, readAt?, readVersion?,
  lastOpenedAt`; index `[userId, lastOpenedAt desc]` → "Continue reading" card.
- Back-relations on Topic, LicenseClass, ImageAsset (two named relations), KbChunk, User.
- Migrations: two files (enum `ADD VALUE`s first, tables second — Postgres forbids using a new enum
  value in the same transaction). Hand-strip the HNSW/generated-column drops Prisma proposes
  (`prisma/migrations.test.ts` enforces). Reversal documented in each header.

### B2. Contracts — `src/server/contracts/learn.ts` (Zod v4, `.strict()`, i18n-key messages)

Admin inputs: `upsertBookInputSchema`, `reorderChaptersInputSchema {bookId, documentIds[]}`,
`upsertDocumentInputSchema` (kind CHAPTER ⇒ bookId required via superRefine; body
`{en,nb}` each ≤ 60 000 chars; citations ≤ 20 via `legalCitationSchema` from `contracts/models.ts`),
`transitionLearnInputSchema {entity, id, to}`, `deleteLearnInputSchema`,
`listLearnAdminInputSchema = paginationInputSchema.extend({status?, kind?, topicId?, search?})`,
`draftDocumentInputSchema {topicId, kind, bookId?, sourceCodes?[≤4], sectionRef?, brief?, targetWords 250–1500}`.
Student inputs: `hubQuerySchema {topicId?, page, pageSize}`, `readingProgressInputSchema
{documentId, positionPct, markRead}`.
Outputs (parsed before return): `adminLearnPageSchema = paginatedSchema(adminLearnRowSchema)`,
`adminBookSchema`, `adminDocumentSchema`, `hubSchema {books[], articles: paginated, topics[],
continue?}`, `bookPageSchema`, `readerDocumentSchema` (translated markdown, citations, prev/next,
progress — **never a DRAFT body**, asserted by test), `continueReadingSchema`, `draftResultSchema`.

### B3. Services — `src/server/services/learn/` (factory `createLearnService(db)`)

| File | Responsibility |
|---|---|
| `markdown.ts` (pure) | `splitSections(md, {maxWords: 450})` at `## ` + paragraph boundaries (never inside list/table), `joinSections`, `countWords` (reuse `@/lib/brevity`), `readMinutes` (wpm from `schoolConfig.learn`), `extractImageIds` (only `/api/images/<id>`), `markdownStructure` counts for QA |
| `books.ts` / `documents.ts` | admin CRUD, `reorderChapters`, `transition*` with the publish gate (both title + body sides non-empty, chapter's book PUBLISHED, `publishedAt` set once), slug `ConflictError`, image/topic/source existence checks, `version` bump, `LearnCitation` rewrite, soft delete (book delete cascades to chapters) |
| `citations.ts` | `resolveCitations` using the exact-then-section-head chunk lookup **extracted from `question-bank/simplify.ts` into `services/kb/citations.ts`** (simplify.ts imports it; its tests stay) |
| `student.ts` / `progress.ts` | `hub`, `bookPage`, `reader`, `continueReading`; `recordProgress` (upsert on PK, `positionPct` monotonic, `readAt` set once at markRead or ≥95 %, never cleared), `touchOpened` via `after()` |
| `overlay.ts` | `extractLearnUnits`, `loadLearnOverlay` with **sourceHash comparison** (stale section ⇒ whole document falls back to en with an "not yet in your language" chip — same rule as questions) |
| `cache.ts` | Redis keys in `redis.ts` registry: `tp:learn:version` (bumped by every write/transition/reorder and by `invalidateTaxonomy`, which gains one `incr`), `tp:learn:hub:v{v}:{locale}`, `tp:learn:book:v{v}:{locale}:{slug}`, `tp:learn:doc:v{v}:{locale}:{slug}`, TTL 1 h. Progress is never cached |
| `draft.ts` | AI drafting (B5) |

Every query uses explicit `select` with the serving index named in a comment; one progress query
per page (`documentId in [...]`), never per chapter. Audit constants: `learn.book_upserted`,
`learn.book_transitioned`, `learn.chapters_reordered`, `learn.document_upserted`,
`learn.document_transitioned`, `learn.document_ai_drafted`, `learn.deleted`.
Server actions: `(admin)/admin/learn/actions.ts` (`requireUser("INSTRUCTOR")`; delete = ADMIN),
`(student)/learn/read/[slug]/actions.ts` (`requireUser()`); `revalidatePath` for `/admin/learn`,
`/learn`, `/learn/books/[slug]`, `/learn/read/[slug]`, `/` on transitions.

### B4. i18n

- Payloads in `i18n/units.ts`: `LearnBookPayload {title, description?}`, `LearnDocumentPayload
  {title, summary?}`, `LearnSectionPayload {text}` (the `text` key `translationResponseSchema`
  already accepts). `ENTITY_PRIORITY`: LEARN_BOOK 4, LEARN_DOCUMENT 4, LEARN_SECTION 5.
- **Unit = one H2-bounded section ≤ 450 words**, `entityId = "<docId>:s<n>"`, only for PUBLISHED
  documents (drafts cost nothing). Rationale: a whole Bengali chapter is ~9k output tokens and one QA
  flag would park the whole chapter; sections re-translate one paragraph's worth on edit and
  translation memory absorbs moved sections. Known cost: inserting a mid-document H2 renumbers
  trailing sections (memory answers most instantly; `pruneOrphans` drops the tail ids).
- `validation.ts`: `LEARN_SECTION` branch comparing `markdownStructure` — `MD_HEADINGS`,
  `MD_IMAGES`, `MD_LINKS`, `MD_TABLE`, `MD_CODE`, `MD_HTML` blocking, `MD_LIST` warning; existing
  `NUMBER_DRIFT`/`CITATION_DRIFT` keep § references honest.
- `translateUnitsPrompt` / `translateRepairPrompt` → 1.3.0 with one Markdown-preservation rule; pins
  updated in `prompts/translation.test.ts`.
- `extractAll` branches, `requestTranslationSync` after publish / edits of published docs.
- **Readiness decision (R1):** `languageCoverage` / `untranslatedUnits` ignore `LEARN_*` (new
  `READINESS_ENTITIES`), while sync runs still translate them in the background — otherwise a
  12-chapter book flips every language to "incomplete". The per-document chip is the honest signal.
  → `DECISIONS.md`.
- Review UI (`translation-review.tsx`): pre-wrap + Markdown preview toggle for `LEARN_SECTION`.
- Messages (en + nb, parity-tested): `nav.learn`; `home.learn*`, `home.continueReading*`; `learn.*`
  (hub/book/reader strings, offline note, progress aria, sources); `admin.learn.*` (list, book form,
  document editor, image dialog, AI dialog, actions, errors). Full key list in the design pass;
  transcribed into the spec-23 plan file.

### B5. AI drafting — synchronous server action with pending UI

- Prompt `src/server/ai/prompts/learn.ts` `learn.draft-document` 1.0.0 (pinned by test). Inputs:
  topic (en+nb), kind/book, sibling titles (avoid overlap), brief, targetWords, KB excerpts rendered
  as in `generation/theory.ts:110`, house style from `schoolConfig.learn` (A2/B1, second person).
  Rules: ground only in excerpts, never invent numbers, cite in prose "(trafikkreglene § 7-2)",
  4–8 H2 sections + "Key points", no images/links/HTML/code, **identical H2/H3 structure in en and nb**.
- Output schema `{title{en,nb}, summary{en,nb}, body{en,nb}, citations[{sourceCode, ref,
  supports}], issue?}`.
- Retrieval reuse: `sectionRef` ⇒ `lookupChunksForCitations`; else hybrid `kb/search.ts`
  (limit 12, filtered by `sourceCodes`); < 3 hits ⇒ `AiPipelineError("admin.learn.errors.aiNoMaterial")`.
- Post-checks: structure parity (one retry with feedback), en↔nb drift via `checkTranslation`
  (as `simplify.ts:205` does), every citation resolves to a `KbChunk` (unresolved returned as
  warnings; zero resolved ⇒ error), word count 0.5–1.6× target (warning).
- Nothing persisted until the admin saves (row then carries `createdBy: AI`, model/prompt
  versions). `aiJson` `timeoutMs 90_000`, rate-limit key `learn-draft` per user (12/h).
- Why synchronous: direct precedent, no queue exists, result is an editable proposal (a dropped
  connection loses tokens, not content). Fallback to a job row + poll is UI-only later.

### B6. Routes & components

Config: `featureFlags.learn` + `learn: {readingWpm: 200, sectionMaxWords: 450, draftDefaultWords: 700}`
in `config/school.config.ts`. Flag off ⇒ tile, nav, `/learn/*` (404), admin nav all gone.

Student (`src/app/[locale]/(student)/learn/…`, `mx-auto w-full max-w-md px-4`, glass cards):
- `learn/page.tsx` + `loading.tsx` + `error.tsx`: hub — Continue-reading card, horizontal
  snap-scroll book covers with `{read}/{total}` ring, topic chip filter (`aria-pressed`), article
  list (hero thumb, 2-line summary, topic chip, "x min"), `?page=` pagination.
- `learn/books/[slug]/page.tsx` + `loading.tsx`: cover hero, progress bar, "Continue" (next
  unread), ordered chapter list with read ticks; 404 unless PUBLISHED.
- `learn/read/[slug]/page.tsx` + `loading.tsx` + `actions.ts`: reader RSC, markdown rendered
  server-side, `after(() => touchOpened())`, `generateMetadata`.
- `src/components/learn/`: `markdown.tsx` (react-markdown + remark-gfm + rehype-sanitize with
  `src/lib/markdown/sanitize-schema.ts`: `img` src only `^/api/images/[A-Za-z0-9]+$`, links
  http(s)/relative with `rel="noopener noreferrer"`, tables wrapped in `overflow-x-auto`, H2 ids for
  TOC; `.learn-prose` typography in `globals.css`, 17px/1.65 at 390px, no typography plugin),
  `book-card`, `article-card`, `topic-filter`, `chapter-list`, `continue-reading-card` (rendered
  under `StartTiles` on the home page), `reader-shell` (client: sticky strip with back link,
  "Chapter n of m", chapter Sheet with `aria-current`, 2px transform-only progress bar via rAF,
  progress saved at 25/50/75/95 % + `visibilitychange`, offline ⇒ queued in `sessionStorage` and
  flushed on `online` with a visible note, optimistic Mark-read, prev/next footer).
- Home tile: `start-tiles.tsx` becomes `grid-cols-3` when enabled (disabled variant when nothing is
  published, like the sign tile); `account-menu.tsx` gains a Learn link.
- Desktop reader stays the centred `max-w-md` column with the sticky strip + Sheet (mandate);
  no sidebar.

Admin (`src/app/[locale]/(admin)/admin/learn/…`, desktop-first):
- `learn/page.tsx` + `loading.tsx`: tabs Books / Articles / Chapters, status filter, search, table,
  row actions, pagination (extract `components/admin/pagination.tsx` from `question-table.tsx`).
- `learn/books/new|[id]/page.tsx`: `book-form.tsx` (cover picker as in `item-editor.tsx`, native
  select for licence class, slug auto-suggest) + `chapter-order-list.tsx` (Move up/Move down 44px
  buttons, `aria-live` announcements, single "Save order" — no drag library).
- `learn/articles/new|[id]/page.tsx` (`?bookId=&kind=CHAPTER` for chapters): `document-editor.tsx`
  — metadata card, en/nb `role=tablist`, toolbar (heading/bold/italic/list/link/image) over a new
  `components/ui/textarea.tsx`, live preview through the same `Markdown` component (two-column on
  `md`, toggle on mobile), word/min counter, citations rows (KbSource select + ref, unresolved
  flagged), unsaved-changes guard, `fieldErrors` inline; `image-insert-dialog.tsx` (Library tab from
  `listPickableImages`, Upload tab via `uploadImage` with attestation + duplicate warning, alt
  required, inserts `![alt](/api/images/<id>)`); `ai-draft-dialog.tsx` (topic, sources, § ref,
  brief, length; pending `role=status`/`aria-busy` "usually 20–40 s"; result summary; "Use draft"
  with confirm when fields are non-empty).
- `learn/actions.ts`: `upsertBookAction`, `reorderChaptersAction`, `transitionBookAction`,
  `upsertDocumentAction`, `transitionDocumentAction`, `deleteLearnAction` (ADMIN),
  `draftDocumentAction`, `uploadLearnImageAction`.
- Admin nav link in `(admin)/layout.tsx` (INSTRUCTOR level).

UI-state matrix (mandate 3) — every screen has skeleton `loading.tsx`, an empty state with copy
(+ CTA in admin), `error.tsx`/toast error paths, offline handling for progress, 390px layout with
no horizontal scroll, keyboard paths (chips, tabs with arrow keys, Sheet focus restore, move
buttons), both languages.

New dependencies: `react-markdown`, `remark-gfm`, `rehype-sanitize` (rehype-sanitize after
remark-gfm so tables survive). Verify react-markdown major supports React 19.2 in RSC.

### B7. Test plan → spec-23 acceptance checklist

Unit: `learn/markdown.test.ts` (split/join identity, cap never splits a list/table, counts,
image ids), `validation.test.ts` MD_* flags, `draft.test.ts` (parity retry, drift refusal,
citation resolution, mocked `aiJson`), `prompts/learn.test.ts` (pin), `contracts/learn.test.ts`,
`overlay.test.ts` (stale hash ⇒ fallback), auth-coverage passes.
Integration (`TEST_DATABASE_URL`): CRUD + slug conflict; publish gate; chapter of DRAFT book
invisible in hub/book/reader; reorder has no duplicate orders; progress monotonic + readAt never
cleared; continue-reading picks most recent unread; extract emits only PUBLISHED docs with
`<id>:s<n>` ids, prune drops renumbered; sync stamped on publish; cache version bump; reader never
returns a DRAFT body; `LearnCitation` rewritten on save.
E2E (390×844): `e2e/learn.spec.ts` (tile → hub → book → chapter → mark read → next → back shows
1/2 → home continue card; keyboard-only variant; `/no` strings; unpublished 404),
`e2e/learn-admin.spec.ts` (create book, chapter with a library image, preview, reorder, publish,
audit rows), `e2e/a11y.spec.ts` + 4 routes, both themes.

Checklist (goes into `specs/spec-23-learn.md`):
- [ ] C1 Students only ever receive PUBLISHED documents of PUBLISHED books.
- [ ] C2 Every Learn list query paginated + served by a named index; hub/book/reader cached in Redis, invalidated by `tp:learn:version`.
- [ ] C3 Reader rendered server-side through the sanitize schema; hostile-markdown test; p95 < 150 ms warm.
- [ ] C4 Progress: readAt set once, never cleared; continue card correct; offline-queued.
- [ ] C5 Admin create/edit/reorder/publish/unpublish/archive with audit rows; reorder keyboard-only.
- [ ] C6 Editor preview and reader share one sanitize schema (single import site).
- [ ] C7 Editor image upload goes through `uploadImage` with attestation; bytes only via `/api/images/[id]`.
- [ ] C8 AI draft grounded in ≥3 excerpts, equal en/nb structure, every stored citation resolves, provenance recorded; one live run logged.
- [ ] C9 Published documents extract as `LEARN_*` units ≤450 words; QA refuses lost headings/images/§; stale section ⇒ whole-document fallback with chip.
- [ ] C10 en/nb key parity; no string outside messages.
- [ ] C11 390px no horizontal scroll; desktop centred; axe clean on the four new routes in both themes.
- [ ] C12 Flag off hides tile, nav, routes, admin nav.
- [ ] C13 Migrations reversible; no HNSW/generated-column drops.

### B8. Build order (each slice shippable, own commit series on branch `spec-23-learn`)

1. **Schema + services + admin CRUD**: migrations, contracts, `services/learn/*` (minus draft/overlay),
   `kb/citations.ts` extraction, Redis keys, audit constants, config flag, admin routes + editor +
   image dialog, `textarea.tsx`, deps, admin nav, `admin.learn.*`/`nav.learn` messages, tests.
2. **Student reader**: `student.ts`, `progress.ts`, routes, `components/learn/*`, home tile +
   continue card, account-menu link, `learn.*`/`home.*` messages, e2e + a11y.
3. **AI drafting**: prompt + test, `draft.ts`, action, dialog, rate limit, messages.
4. **Translation wiring**: units/extract/validation/prompt bump/overlay/`invalidateTaxonomy`/sync,
   readiness gate decision, review-UI preview, tests, `DECISIONS.md`.

Decisions taken in this plan (to log in `DECISIONS.md` on approval): instructors may publish
(delete is ADMIN); a human-authored document needs no citation to publish (warning only, AI drafts
must cite); desktop reader keeps the `max-w-md` column; chapter reorder is up/down buttons only;
`LEARN_*` units excluded from language readiness; wrong-answer "Read more" linking stays in spec-10.

Risks: translation token cost per book (minutes at spec-19a throughput, but 5–10× a question's
tokens); 90 s server action needs nginx `proxy_read_timeout` ≥ 120 s on `/admin/*` (same exposure
as existing generation actions — verify on the VPS); `/api/images/[id]` is `Cache-Control: private`
so covers refetch every 5 min (acceptable, note for spec-13).

---

