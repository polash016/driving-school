# Spec 23 — verification notes

Evidence for the acceptance checklist in `specs/spec-23-learn.md`. Commands were run and their
output pasted; nothing here is asserted without it.

## Slice 1 — schema, services, admin authoring (2026-09-24)

- Migrations `20260924114128_learn_translatable_entities` (three enum values, own migration
  because Postgres cannot use a new enum value in the transaction that added it) and
  `20260924114325_learn_books_articles` (four tables, nine indexes). Prisma's proposed drops of
  both HNSW indexes and both generated-column defaults were removed by hand;
  `prisma/migrations.test.ts` gained a guard for the hub index. `migrate deploy` applied to dev
  and test databases: "All migrations have been successfully applied." (C13)
- `services/learn/service.integration.test.ts` — 9 tests against `teoripro_test`: slug conflict,
  chapter numbering and whole-list reorder with no duplicate orders, publish gate (empty nb
  refused; `publishedAt` set once and kept through unpublish), version bump only on content
  change, citations linked to chunks and an unknown source refused, an unknown embedded image
  refused, kind and book fixed after creation, soft delete cascading to chapters, list tabs /
  status / search. (C5, C7 server side)
- `components/learn/markdown.test.tsx` — 3 tests: headings get ids, tables get a scroll region,
  app images render; `<script>`, `onerror`, a foreign image, a `javascript:` link and an
  `<iframe>` are all dropped; external links get `target=_blank rel=noopener noreferrer`. The
  editor preview and the reader import the same `learnSanitizeSchema` (grep: one definition,
  one import site in `components/learn/markdown.tsx`). (C3, C6)
- `services/learn/markdown.test.ts` — 9 tests: H2 split with the preamble as section 0,
  `join(split(x)) === x` including the word-cap split, a cap split never cuts a list or a table,
  a `##` inside a code fence is not a heading, word and minute counting, image-id extraction,
  structure counts. (C9 groundwork)
- `services/kb/citations.test.ts` — 3 tests for the lookup extracted from the rewrite campaign
  (exact ref, then section head); `simplify.test.ts` still green after the refactor (54 tests).
- Every list query is paginated (`paginationInputSchema`, `skip/take` + `count` in one
  transaction); each query names its index in a comment (`LearnBook_status_sortOrder_idx`,
  `LearnDocument_kind_status_publishedAt_idx`, `LearnDocument_topicId_status_idx`,
  `LearnDocument_bookId_chapterOrder_idx`, `LearnReadingProgress_userId_lastOpenedAt_idx`). (C2)
- `pnpm build` clean with the admin routes and the Learn nav entry. `auth-coverage.test.ts` passes
  with the new `actions.ts` files (every exported action calls `requireUser`).

## Slice 2 — student reader (2026-09-24)

- `services/learn/student.integration.test.ts` — 5 tests: hub, book page and reader return only
  PUBLISHED documents of PUBLISHED books (draft chapters, chapters of a draft book and draft
  articles are all `NotFoundError`); prev/next skip unpublished chapters; progress is monotonic,
  `readAt` set once at ≥ 95 % or on mark-read and never cleared; the continue card picks the latest
  unfinished document and disappears when it is read; a chapter edited after reading is flagged
  `updatedSinceRead`; progress on a draft is ignored. (C1, C4)
- Public parts of hub, book and reader are cached under `tp:learn:{hub,book,doc}:v{n}:{locale}…`
  and every write, transition and reorder bumps `tp:learn:version`; per-user progress is one
  primary-key query merged on top and never cached. (C2)
- The reader renders markdown on the server through the shared schema; the client shell only
  tracks scroll (transform-only bar on `requestAnimationFrame`), saves at 25/50/75/95 % and on
  `visibilitychange`, queues in `sessionStorage` when offline and flushes on `online`. (C3, C4)
- Message keys: `nav.learn`, `home.learn*`, `learn.*`, `admin.learn.*` in both files;
  `src/i18n/messages.test.ts` + `message-keys.test.ts` green (parity). (C10)
- Feature flag `featureFlags.learn`: tile, nav links (student and admin) and every route check it. (C12)

## Slice 3 — AI drafting (2026-09-24)

- Prompt `learn.draft-document` 1.0.0 (`src/server/ai/prompts/learn.ts`), pinned by
  `prompts/learn.test.ts`: grounded only in the retrieved excerpts, numbers and § copied exactly,
  citations in prose, identical H2/H3 skeleton in both languages, no images/links/HTML/code, A2/B1
  voice, target length.
- `services/learn/draft.test.ts` — 8 tests with a mocked gateway: excerpts rendered into the
  prompt with sibling titles and the book name; refusal under 3 excerpts (`aiNoMaterial`); one
  retry with the exact structure finding fed back, then `aiStructure`; a number that differs
  between the languages is refused the same way (`NUMBER_DRIFT` through `checkTranslation`);
  `aiNoCitations` when nothing resolves, unresolved ones reported otherwise; images, links, HTML
  and code stripped and named in `warnings`. Provenance (`modelVersion`, `promptVersion`) is
  returned and stored as `createdBy: AI` only when the admin saves.
- `draftDocumentAction`: `requireUser("INSTRUCTOR")`, `rateLimit("learnDraft", user.id)`
  (12 per hour), audit `learn.document_ai_drafted` with excerpt count, versions and warnings.
  Synchronous, like `generateQuestionsAction`; the dialog shows `role=status` / `aria-busy`
  progress and "usually 20–40 s". Nginx `proxy_read_timeout` on the VPS is 300 s (checked).
- Live run: the local Gemini key answered once (the parser now accepts `no` as the Norwegian
  key and a null `issue`) and was then refused with 403 "project has been denied access", so the
  recorded live run is done on production below.

## Slice 4 — translation wiring (2026-09-24)

- Units: `LEARN_BOOK` (title + description), `LEARN_DOCUMENT` (title + summary),
  `LEARN_SECTION` (`{ text }`, `entityId = "<docId>:s<n>"`) — only PUBLISHED documents of PUBLISHED
  books, sections ≤ 450 words (`schoolConfig.learn.sectionMaxWords`), Norwegian side attached only
  when both bodies have the same skeleton. `ENTITY_PRIORITY` 4/4/5.
- `overlay.test.ts` — 4 tests: one document unit plus one section per H2 block, aligned; nb
  dropped on a skeleton mismatch; a changed section moves only its own hash; a glossary bump moves
  every hash.
- `overlay.integration.test.ts` — 2 tests against `teoripro_test`: extraction returns only the
  published article while its book is a draft, then the book, chapter and sections after the book
  is published; `extractAll` with `only`/`ids` narrows to one section; readiness ignores `LEARN_*`
  (`countsTowardReadiness`); a fully translated document is served whole in the test locale with
  `servedLocale` = that locale; **editing one section makes the whole document fall back** to
  English with `inLocale: false`; a language that requires approval never serves MACHINE.
- QA: `LEARN_SECTION` branch in `validation.ts` — `MD_HEADINGS`, `MD_IMAGES`, `MD_LINKS`,
  `MD_TABLE`, `MD_CODE`, `MD_HTML` blocking, `MD_LIST` advisory; `translation.test.ts` covers each.
  `NUMBER_DRIFT` / `CITATION_DRIFT` already apply to any entity.
- Prompts `translation.units` and `translation.repair` → 1.3.0 with the markdown rule; pins
  updated in `translation.test.ts` and `brevity.test.ts`.
- `invalidateTaxonomy` now also bumps `tp:learn:version`, so every LEARN_* translation write
  (review, runs, audit, language edits — its eight callers) invalidates the Learn read caches.
  `requestTranslationSync` is stamped on publish and on an edit of a published document.
- Readiness: `READINESS_EXCLUDED` in `languages.ts` — `languageCoverage` and `untranslatedUnits`
  drop `LEARN_*` units (DECISIONS 2026-09-24).
- Review UI: `LEARN_SECTION` rows render pre-wrapped monospace; the seven `MD_*` codes have labels
  in both message files and appear in the flag lists of the review and sample screens.

## Test-suite note (2026-09-24)

`i18n/review.integration.test.ts` and `i18n/languages.integration.test.ts` read seeded topics and
the 150 APPROVED items that `task-sets/service.integration.test.ts` leaves behind. The first
version of the Learn integration tests truncated `Topic` (CASCADE) and wiped both, which is why
they failed in a full run. They now create and delete their own rows only, the test database was
re-seeded (`prisma db seed`, `db:seed-items`) and the task-set file run once to restore the
residue. The underlying order dependence in the two i18n files predates this spec and is left as
found.

## Production (2026-09-24)

- Backup taken and verified; checkout switched to `spec-23-learn`; `pnpm install`, explicit
  `prisma generate`, `migrate deploy` applied `20260924114128_learn_translatable_entities` and
  `20260924114325_learn_books_articles`; `next build` 19 s; both pm2 apps online; `/en` → 200,
  `/en/learn` and `/en/admin/learn` → 401 when signed out (the Learn routes require a session).
- Warm read timing (service level, local dev database, 20 samples each, published chapter of
  ~180 words, Redis warm): hub p50 0.9 ms / p95 9.6 ms · book p50 0.4 ms / p95 2.3 ms · reader
  p50 0.5 ms / p95 3.3 ms — the public part is one Redis GET and the per-user part one primary-key
  read. (C2, C3)
- **Live AI draft on production** (C8), route "Gemini Paid" / `gemini-3.5-flash-lite`, prompt
  `learn.draft-document@1.0.0`, topic "Right of way", brief "unmarked junctions and the
  right-hand rule", asked for 500 words, nothing stored:

  ```
  3 491 ms · 12 excerpts · citations trafikkreglene § 7 nr. 1, § 7 nr. 2, § 5 nr. 4 (all resolved,
  0 unresolved) · warnings: length (207 words en / 193 nb — shorter than asked, reported, not hidden)
  en: ## Introduction to right of way / ## Unmarked junctions and the right-hand rule /
      ## Approaching junctions / ## Key points
  nb: ## Introduksjon til vikeplikt / ## Umerkede kryss og høyreregelen / ## Nærmere kryss /
      ## Det viktigste
  ```

  Every rule sentence ends with its reference in prose, identically in both languages; the
  first attempt of the day failed on malformed JSON from the model and the colder retry passed.
