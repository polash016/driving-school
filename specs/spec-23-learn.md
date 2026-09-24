# Spec 23 — Learn: traffic-law books, chapters and articles

**Status:** 📝 Planned · depends on 01, 02, 03, 05, 06, 15, 18, 20
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

- [ ] C1 Students only ever receive PUBLISHED documents of PUBLISHED books (integration + e2e 404).
- [ ] C2 Every Learn list query is paginated and served by a named index; hub, book and reader are
      cached in Redis under `tp:learn:*`, invalidated by the `tp:learn:version` bump.
- [ ] C3 The reader is rendered server-side through one sanitise schema; hostile markdown test;
      p95 < 150 ms warm.
- [ ] C4 Progress: `readAt` set once, never cleared; continue-reading card correct; offline-queued.
- [ ] C5 Admin create / edit / reorder / publish / unpublish / archive with audit rows; reorder is
      keyboard-only.
- [ ] C6 Editor preview and student reader share one sanitise schema (single import site).
- [ ] C7 Editor image upload goes through `uploadImage` with attestation; bytes only via
      `/api/images/[id]`.
- [ ] C8 AI draft: grounded in ≥ 3 knowledge-base excerpts, equal en/nb section structure, every
      stored citation resolves to a chunk, provenance recorded; one live run logged.
- [ ] C9 Published documents extract as `LEARN_*` units ≤ 450 words; QA refuses lost headings,
      images or §; a stale section makes the whole document fall back, with the chip.
- [ ] C10 en/nb message key parity; no user-facing string outside the message files.
- [ ] C11 390 px: no horizontal scroll on hub, book, reader; desktop centred; axe clean on the four
      new routes in both themes.
- [ ] C12 Flag off hides the tile, the nav link, the routes (404) and the admin nav entry.
- [ ] C13 Migrations reversible; no HNSW or generated-column drops (`migrations.test.ts`).

## Out of scope

- Wrong-answer "Read more" links into articles (spec-10; the `[topicId, status]` index and slugs
  are ready for it).
- Pointer drag-and-drop for chapter ordering (up/down buttons ship; drag can layer on later).
- A desktop sidebar reader wider than the student column (would need a DECISIONS deviation).
- Full-text search across documents.
