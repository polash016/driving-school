# Spec-20 — Question translation end to end, and an honest publish gate · verification evidence

**Status: implemented and verified on branch `spec-20-question-translation`** (2026-09-12). Six
tasks, one migration, each committed with its tests. Final gate at the bottom.

## The diagnosis, confirmed in code before anything was changed

"UI translated, questions not" had seven causes, none of them in the translation engine itself.
Each is cited with the line that produced it in `specs/plans/spec-20-plan.md` §Context; the two
that matched the reported symptom exactly were the claim order (`UI_MESSAGE` is the first enum
value, so a run that stalled on a quota had translated every UI string and no question) and the
serializer discarding the translated explanation.

## Task 1 — questions are served from the master translation

The derived `ITEM_VARIANT` copy is gone. `loadQuestionOverlay` resolves each served variant's
translation through its master, guarded on `masterVersion` and `TEMPLATE` source, and the
explanation travels with it into practice feedback, the reveal and the stored result.

```
✓ serves the master's translation on its current TEMPLATE variant, keyed by variant id
✓ leaves a variant published from an older master version untranslated
✓ leaves an AI_VARIATION variant untranslated until it has a unit of its own
✓ serves machine output only where the language allows it
✓ never serves a flagged or rejected translation under either policy
✓ costs a built-in language nothing
✓ practice: the paper, the feedback and the reveal all read in the student's language
✓ a stored result re-reads in whichever language it is viewed in
✓ holds machine output back the moment the language requires approval
✓ left every variant's contentHash byte-identical and wrote no variant copies
```

The last line is the spec-15 regression guard: every `ItemVariant.contentHash` compared before and
after, and `count(Translation where entity = ITEM_VARIANT and locale = zq) = 0`. The bulk-approve
suite's "still reaches the variants students are actually served" now asserts the served overlay
and the _absence_ of a copy row. `grep deriveVariantTranslations src scripts` → no matches.

## Task 2 — questions first

`TranslationJob.priority` is written at plan time from `ENTITY_PRIORITY`; the claim orders by it.
Migration `20260912090000_question_translation_integrity` (hand-edited: the four HNSW / generated
column drops Prisma re-proposed were removed; `prisma/migrations.test.ts` green).

```
RED   expected [ 'UI_MESSAGE' ] to deeply equal [ 'MASTER_ITEM' ]   ← the production symptom
GREEN ✓ claims a question before any UI string, whatever order the enum declares
```

## Task 3 — a language keeps itself translated

```
✓ a new language publishes machine output by default and starts translating at once
✓ a language added with the switch off waits for an admin
✓ a content change stamps every language that keeps itself translated, and no other
✓ publishing a question is such a change
✓ the idle worker plans nothing while the first run is still queued
✓ plans a sync once the stamp is newer than the last sync run's plan, for what is missing only
✓ does not plan again for a stamp older than the run it already planned
✓ clears the stamp when nothing is pending rather than planning an empty run
✓ never plans for a language whose switch is off, however stale
✓ plans automatic syncs on an idle tick, and looks again at once when it planned one
✓ looks for syncs only when nothing is claimable
✓ a failing autoSync is logged and the loop stays alive
✓ says nothing about a small sync nobody started — routine upkeep is not news
✓ still reports a small unattended sync that flagged something
```

Compared against the latest sync run's **plan** time, not its finish time — an approval landing
while a run executes is not in that run and must not be lost. The four spec-19 suites that drive
runs by hand now create their language with `autoTranslate: false`; the collision they hit first
(`ConflictError: runActive`) was the new behaviour working.

## Task 4 — an unpublished language is staff-only

Pure decision (`src/i18n/publish-gate.ts`, 6 unit cases) applied in the locale layout; the proxy
forwards `x-pathname` so the redirect keeps the page. Driven against a **freshly built** server
(`.next/BUILD_ID` 17:26, last commit 17:22, nothing listening on 3100 afterwards):

```
✓ a language added at runtime routes for the staff who review it, with no redeploy (33.1s)
✓ an anonymous visitor to an unpublished language lands on the same page in the fallback (142ms)
✓ a student is sent away from an unpublished language too (314ms)
✓ a language that is not student-visible stays out of the switcher (130ms)
```

## Task 5 — topic names and citation labels

```
✓ labels a topic in the student's language, and in the authored one for a built-in
✓ labels a legal source, and falls back to the code for one it does not know
✓ holds a flagged label back and shows the authored name instead
✓ reads a language's overlay once and caches it until invalidated        (tp:i18n:taxonomy:<locale>)
✓ the explanation contract insists on a source label — the slug is not a name
✓ a citation whose source has no label falls back to the code, never to nothing
```

and in the added-language suite: `topicBreakdown[].topicName` and
`review[].explanation.citations[].sourceLabel` read `[zq] …` in `zq` and `Right of way` /
`Trafikkreglene` when the same result is viewed in `en`.

A defect found on the way: the taxonomy cache survived a language being deleted and re-added
under the same code, so the second `zq` run read the first run's topic ids. `createLanguage` now
clears the message and taxonomy caches for its code (test: seeded stale keys are gone after the
add).

## Task 6 — the board

Admin e2e, TOTP enrolment included, Pixel 7 viewport (390 px):

```
✓ adding a language starts it translating, and the card says so in both languages (1.4s)
     "Translating…" / "Publishes straight through" / "Stop translating automatically"
     "Oversetter …" / "Stopp automatisk oversetting"      scrollWidth <= clientWidth
     TranslationRun { kind: FULL, enqueuedAt: set, plannedUnits > 0 }
✓ the switches are reachable by keyboard and the submit keeps a visible focus ring (633ms)
```

One latent bug fixed while there: an unticked checkbox posted nothing and the action read
`!== "off"`, so "requires approval" was **always** true whatever the admin ticked.

## Acceptance checklist

| Item                                                                                                   | Result | Evidence                                                               |
| ------------------------------------------------------------------------------------------------------ | ------ | ---------------------------------------------------------------------- |
| Add with the switch on enqueues a FULL run; off enqueues nothing                                       | PASS   | sync.integration (2), languages-board e2e                              |
| TOPIC + MASTER_ITEM queued → questions claimed first                                                   | PASS   | runs.integration "claims a question before any UI string"              |
| Translated stem, options **and explanation** in reveal, navigate-back, result; `contentHash` identical | PASS   | attempt-service.integration spec-20 (5)                                |
| Approval after publish → stamp → idle worker plans SYNC → English only until it lands                  | PASS   | sync.integration, worker.test, translation.test fallback               |
| `complete` true exactly when every served question is servable                                         | PASS   | "coverage calls the language complete exactly when…"                   |
| `/xx` unpublished: 200 for staff, redirect for anonymous and student                                   | PASS   | dynamic-languages e2e (4)                                              |
| Result-page topic names and citation labels in the added language                                      | PASS   | attempt-service.integration, taxonomy.integration                      |
| NEEDS_REVIEW / REJECTED never served; bulk approve still refuses unconsented flags                     | PASS   | question-overlay.integration, review.integration (9)                   |
| No `correctOptionKey` pre-submission                                                                   | PASS   | full e2e below (student-quiz, task-sets, sign-test network assertions) |
| Both languages, 390 px, keyboard, focus rings on the card and add form                                 | PASS   | languages-board e2e (2)                                                |
| `pnpm test`, `tsc`, `eslint`, `pnpm build`, `migrations.test.ts` clean                                 | PASS   | final gate below                                                       |

## Deviations from the plan, all within the approved design

- The "glossary change requests a sync" hook has no call site: nothing in the codebase writes
  `Language.glossary` today. Wire `requestTranslationSync(db, { locale })` into the editor when it
  is built.
- The taxonomy tests are an integration suite (`taxonomy.integration.test.ts`), because the cache
  and the servable-status gate are the behaviour; a unit test with a fake client would test the fake.
- The coverage ⇔ serving proof lives in the added-language suite next to the paper it serves.
- A new admin e2e (`e2e/languages-board.spec.ts`) drives the board; the plan had no browser test.

## Known gaps, stated plainly

- Head-of-line blocking in the worker is unchanged (spec-19 known gap).
- Sign names are still counted by coverage and read by no student screen until spec-10.
- Accept-language can route an anonymous visitor to an unpublished prefix for one request before
  the layout bounces them.

## Final gate

```
pnpm test                       68 files · 649 tests passed (21.2 s) — integration suites RAN against teoripro_test
pnpm exec tsc --noEmit          clean
pnpm exec eslint                clean (whole project)
pnpm build                      ✓ Compiled successfully · every route in the table above renders on demand (ƒ)
prisma/migrations.test.ts       green (the four re-proposed drops were stripped from the new migration)
pnpm e2e                        36 passed · 1 skipped · 0 failed (6.6 s against the freshly built server)
```

The skipped e2e is pre-existing and unrelated: `e2e/sign-test.spec.ts:85:  test.skip(signQuestions === 0, "no approved sign questions in this database");; e2e/sign-test.spec.ts:158:  test.skip(; e2e/sign-test.spec.ts:180:  test.skip(!sign, "sign registry is empty");`.

Two e2e specs were broken **before this branch** and are fixed here, both by locator only:
`e2e/languages.spec.ts` matched the bulk-approve button ("Approve 0 unflagged…", amendment B) with a
non-exact `Approve`, and matched the consent-box label with the row's flag sentence. Neither
touches what the tests prove.

Two full e2e runs preceded the clean one: the first found the two locator breaks above and a
TOTP-replay refusal on a second admin login inside the 90-second window (spec-03 working as
designed) — the board spec now logs in once. 35 of 37 passed on that first run, including the
three anti-leak network assertions.
