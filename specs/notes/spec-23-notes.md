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
