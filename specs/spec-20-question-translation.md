# Spec 20 — Question translation end to end, and an honest publish gate

## Objective

An admin adds a language and walks away; every question — stem, options, the correct option's
text, and the explanation — is translated first, served to students from the translation, kept in
sync as the bank changes, and the language is offered to students only when nothing at all still
reads English. A language that is not finished is never reachable by a student, not even by URL.

## Why this is needed

Spec-15 built the engine and spec-19 made it unattended, and both work: question units are
extracted (`extract.ts:110-147`), translated as one semantic object, QA'd and stored. What a student
is served, however, still reads English in every added language, for seven concrete reasons found
by tracing the code rather than the dashboards:

1. Adding a language creates a row and nothing else (`languages.ts:355-414`).
2. Jobs are claimed in `TranslatableEntity` enum order, and `UI_MESSAGE` is declared first
   (`runs.ts:672-679`) — every stalled or bounded run has done all UI strings and no question.
3. The translated explanation is never shown: both post-grading builders read
   `ItemVariant.explanation` through `pickLocale` (`serializer.ts:126,163`), and the practice
   answer/reveal path loads no overlay at all (`attempt-service.ts:479-486,556-564`).
4. Questions reach students only through a derived `ITEM_VARIANT` copy that is skipped when a run
   crashes, never made when a question is approved, and not counted by coverage — so a language
   can show 100 %, be switched on, and serve every question in English.
5. Topic, licence-class and KB-source names are translated and never read on a student path.
6. Nothing requests a sync when a question is approved or a KB source ingested.
7. `/xx` routes for everyone before the language is published (`layout.tsx:50-53`).

## In scope

- **Serve from the master translation.** The engine resolves `MASTER_ITEM` translations through the
  variant's master id, guarded on master version and `TEMPLATE` source; the derived copy is deleted.
- **Explanation, topic names and citation labels** are overlaid on every student path.
- **Questions first.** Jobs carry a priority; a run translates questions before UI strings.
- **Auto-start and self-maintaining sync.** `Language.autoTranslate` (default on): a FULL run on
  add, a SYNC planned by the idle worker after any translatable content changes.
- **New languages default to `requiresApproval: false`.** Existing rows unchanged.
- **Unpublished languages are staff-only.** Students and anonymous visitors are redirected to the
  fallback locale; INSTRUCTOR/ADMIN keep the preview the review screen needs.
- **Live drift keeps the language live.** A unit added after publish reads English in that language
  until the automatic sync lands; the board says "Published · N syncing".

## Out of scope

- Sign names on a student screen (spec-10's catalogue consumes them; they stay in coverage).
- QA calibration (`ANSWER_PERMUTED` on correct translations) and the worker's head-of-line
  blocking (spec-19 known gap).
- Templated questions (`parameterSlots`) and spec-17 `AI_VARIATION` variants — the `ITEM_VARIANT`
  entity is reserved for them.

## Acceptance checklist

- [ ] Adding a language with "Keep translated automatically" enqueues a FULL run with no further
      click; with it off, nothing is enqueued.
- [ ] With TOPIC and MASTER_ITEM jobs queued, the first batch claimed is questions.
- [ ] A student in an added language sees translated stem, options **and explanation** in practice
      reveal, on navigate-back, and on the result page; `ItemVariant.contentHash` is byte-identical
      before and after.
- [ ] A question approved after a language is published is stamped, a SYNC is planned by the idle
      worker, and that unit reads English in the language only until the run completes.
- [ ] `languageCoverage.complete` is true only when every unit the engine would serve is servable —
      proven by serving a paper in the language and finding no English text.
- [ ] `/xx` for an unpublished language: 200 for an admin, a redirect to the fallback locale for an
      anonymous visitor and for a student. A published language: 200 for everyone.
- [ ] Result-page topic names and citation labels render in the added language.
- [ ] `NEEDS_REVIEW` and `REJECTED` are still never served; bulk approve still refuses unconsented
      flags.
- [ ] No `correctOptionKey` in any pre-submission payload (the three e2e network assertions stay
      green).
- [ ] Both languages, 390 px, keyboard paths and focus rings on the changed admin card and add form.
- [ ] `pnpm test`, `pnpm exec tsc --noEmit`, `pnpm exec eslint`, `pnpm build` and
      `prisma/migrations.test.ts` all clean.

## Notes

Plan: [plans/spec-20-plan.md](plans/spec-20-plan.md) · Evidence: [notes/spec-20-notes.md](notes/spec-20-notes.md)
· Decisions: `DECISIONS.md` (2026-09-12).
