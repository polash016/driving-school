# Spec 23 — Learn: traffic-law books, chapters and articles

**Status:** 🔍 Verifying (Fable, 2026-09-24) · depends on 01, 02, 03, 05, 06, 15, 18, 20
**Approved:** 2026-09-24 (plan mode, with the developer's answers on content model and editor)

## Why

Students practise with questions but have nowhere in the app to read the rule a question tests.
Spec-10 sketched "curriculum articles per topic, editable by instructor, linked from wrong
answers", and the school now wants a proper study section: the theory material as **books with
ordered chapters**, plus **standalone articles**, written and published from the dashboard, read
on a phone in a clean, modern reader, in every language the school serves.

## Scope

- **Content model.** `LearnBook` (title, description, cover, licence class, ordered chapters) and
  `LearnDocument` (kind ARTICLE or CHAPTER; markdown body in `{en, nb}`; topic; optional hero
  image; citations to the knowledge base). `DRAFT → PUBLISHED → ARCHIVED`, `publishedAt` once.
  Students only ever receive PUBLISHED documents whose book (if any) is PUBLISHED.
- **Authoring.** `/admin/learn`: list with tabs and status filter; book form with keyboard-
  accessible chapter ordering; document editor with en/nb tabs, a markdown toolbar, live preview
  through the same sanitised renderer the student reader uses, image insertion through the
  existing upload service with rights attestation, citation rows, and an **AI draft** dialog
  that writes a grounded chapter from the ingested law text (both languages, same structure,
  citations that resolve to knowledge-base chunks). Nothing is stored until the admin saves.
- **Reading.** `/learn` hub (continue-reading card, books, articles by topic), `/learn/books/[slug]`
  (chapter list with progress), `/learn/read/[slug]` (server-rendered markdown, reading progress
  bar, prev/next, mark as read, sources). Progress per user feeds a home-page card. A Learn tile
  on the home page and a nav link; all behind `featureFlags.learn`.
- **Languages.** en/nb authored; bn/es/ar/fr through the existing translation overlay, one unit per
  H2-bounded section (≤ 450 words), all-or-nothing per document with a "not yet in your language"
  chip. Markdown-structure QA (headings, images, links, tables, § references) on every section.
  `LEARN_*` units are translated by sync runs but do not count toward language readiness.

## Acceptance checklist

- [x] C1 Students only ever receive PUBLISHED documents of PUBLISHED books — `student.integration.test.ts` (draft chapter, chapter of a draft book, draft article all NotFound) + `e2e/learn.spec.ts` (draft chapter shows the not-found boundary).
- [x] C2 Every Learn list query is paginated and served by a named index (comments in `books.ts`, `student.ts`); hub, book and reader cached under `tp:learn:*`, invalidated by the `tp:learn:version` bump (`cache.ts`; e2e found and fixed a stale-cache case).
- [x] C3 Reader rendered server-side through one sanitise schema; hostile-markdown test in `markdown.test.tsx`; warm reads are one Redis GET + one primary-key progress read (timing on production in the notes).
- [x] C4 Progress: `readAt` set once, never cleared; continue card correct (`student.integration.test.ts`); offline queue in `reader-shell.tsx` (sessionStorage, flushed on `online`).
- [x] C5 Admin create / edit / reorder / publish / unpublish / archive with audit rows; reorder is Move up / Move down buttons — `e2e/learn-admin.spec.ts` asserts the flow and the five audit actions.
- [x] C6 Editor preview and student reader share one sanitise schema: `learnSanitizeSchema` is defined once and imported only by `components/learn/markdown.tsx`, which both use.
- [x] C7 Editor image upload goes through `uploadImage` with the rights checkbox required; the sanitiser allows `img` only from `/api/images/<id>` (`markdown.test.tsx`); a body naming an unknown image is refused (`service.integration.test.ts`).
- [x] C8 AI draft: grounded in ≥ 3 excerpts, equal en/nb skeleton, resolvable citations, provenance recorded — `draft.test.ts` (8) + `prompts/learn.test.ts`; live run logged in the notes.
- [x] C9 Published documents extract as `LEARN_*` units ≤ 450 words (`overlay.integration.test.ts`); QA refuses lost headings, images, links, tables, code, html and § (`translation.test.ts`); a stale section makes the whole document fall back with `inLocale: false`, shown as the chip.
- [x] C10 en/nb parity — `messages.test.ts` + `message-keys.test.ts` green; every string in the new components goes through `useTranslations`/`getTranslations`.
- [x] C11 390 px: no horizontal scroll (asserted in `e2e/learn.spec.ts`); pages use the centred `max-w-md` column; axe clean on hub, book, reader (both themes) and admin list + editor.
- [x] C12 `featureFlags.learn` gates the tile (`start-tiles.tsx`), both nav links, every `/learn` and `/admin/learn` route (`notFound()`), and the home page's Learn queries.
- [x] C13 Two migrations with documented reversal; the HNSW and generated-column drops Prisma proposed were removed by hand; `migrations.test.ts` (9) green.

## Out of scope

- Wrong-answer "Read more" links into articles (spec-10; the `[topicId, status]` index and slugs
  are ready for it).
- Pointer drag-and-drop for chapter ordering (up/down buttons ship; drag can layer on later).
- A desktop sidebar reader wider than the student column (would need a DECISIONS deviation).
- Full-text search across documents.
