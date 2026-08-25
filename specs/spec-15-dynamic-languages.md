# Spec 15 — Dynamic Languages & AI Translation

## Objective

A school adds a language from the admin panel — Arabic, Spanish, Polish, whatever its students
speak — and the platform translates everything it already holds, keeps it in sync as content
changes, and serves students in that language. No redeploy, no code change, no second codebase.

## Why this is not a config change

The platform is bilingual _by construction_: `en` and `nb` are a Prisma enum, two separate Zod
enums, a Postgres GENERATED column whose SQL literally names `'en'` and `'nb'`, and a `{ en, nb }`
JSON shape on every content column with both keys required. Language has to become runtime data.

## In scope

- **Language registry** (`Language`): code, native name, URL prefix, text direction, fallback,
  per-language "requires human approval" switch, student visibility gate.
- **Runtime locale routing**: adding a row makes `/es/...` routable, with the right `lang` and
  `dir`, without a restart. `en`/`nb` behaviour — including the `nb` → `/no` alias — is unchanged.
- **Translation store**: an overlay table, never an edit to existing content. The exam engine's
  `contentHash`, seen-windows, immutability triggers and calibrated similarity thresholds are
  untouched.
- **AI translation pipeline**: a question translated as one semantic unit from both the Norwegian
  (legal source) and the English (fluent pivot), with a glossary, translation memory, and sync that
  only touches what is new or stale.
- **Accuracy QA**: structural checks, semantic-drift detection by multilingual embedding, and an
  answer-integrity check that the correct option is still the correct option.
- **Review UI**: a speaker of the language approves translations side by side with the source; any
  question can be viewed in every language at once.
- **RTL**: Arabic renders right-to-left across the student panel, with an Arabic-capable font.

## Out of scope

- Translating the knowledge base. It is the Norwegian legal text the AI cites; a translation layer
  between a question and the law it rests on is exactly what a disputed mark does not need.
- Translating admin chrome (beyond the per-question language tabs a reviewer needs).
- Templated questions (`parameterSlots`) — unused today; they fall back to English and are named
  in the coverage report.
- A job queue. Translation runs as a resumable chunked service, not BullMQ.

## Acceptance checklist

### Phase 1 — the engine, proven with Spanish

- [ ] An admin adds Spanish in the UI; `/es` routes, renders, and carries `lang="es"` — with no
      restart and no deploy.
- [ ] Sync translates every question, topic name, licence-class name, KB source name and UI
      message key; coverage reaches 100%; only then does the student-visible toggle unlock.
- [ ] A student sits and submits a full test in Spanish, and `/account/history` renders that paper
      in Spanish. The attempt records the language it was sat in.
- [ ] **`contentHash` is byte-identical for every existing variant before and after translation** —
      seen-windows and the immutability triggers are provably untouched.
- [ ] With `requiresApproval` on, machine translations do not reach students; approving one makes
      it appear. With it off, translations serve as soon as the AI finishes.
- [ ] QA catches each of: a dropped ICU placeholder, a renamed option key, and a translation that
      moves the correct answer.
- [ ] Sync is resumable: killed mid-run and re-run, it re-translates nothing already done.
- [ ] With Redis flushed and the language table unreachable, the app still routes `/en` and `/no`.
- [ ] A reviewer can see any question in every language side by side.
- [ ] axe: no serious/critical violations on `/es`.

### Phase 2 — Arabic and right-to-left

- [ ] `/ar` renders right-to-left: the exam runner, results, home and history mirror correctly at
      390px with no horizontal scroll.
- [ ] Arabic text renders in a font with Arabic coverage, in both themes.
- [ ] axe: no serious/critical violations on `/ar`.
- [ ] A full Arabic exam can be sat keyboard-only.

## Notes

Plan: [plans/spec-15-plan.md](plans/spec-15-plan.md) · Evidence: [notes/spec-15-notes.md](notes/spec-15-notes.md)
