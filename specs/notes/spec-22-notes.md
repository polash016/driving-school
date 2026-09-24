# Spec 22 — verification notes

Evidence for the acceptance checklist in `specs/spec-22-short-questions.md`. Commands were run and
their output pasted; nothing here is asserted without it.

## Environment

- Local: node v24.13.1, Postgres 5544 (docker compose), `teoripro` + `teoripro_test` + a restore of
  production as `teoripro_prodcopy`.
- Production: `ai-dev@88.222.245.164`, `~/applications/driving-school`, node v24.18.0, pnpm 11.23.0,
  pm2 apps `teoripro` and `teoripro-i18n-worker`. AI routes: **Gemini Paid** (not free tier — the
  pacing estimates in the plan assumed free-tier quotas and are superseded).

## Part 1 — the contract

| # | Item | Result |
|---|---|---|
| A1 | Budget in `config/school.config.ts` | PASS — `content.brevity`, Zod-validated |
| A2 | Multi-script word counting | PASS — `brevity.test.ts`, 8 scripts pinned to measured ICU values (en 7 / nb 5 / ar 6 / bn 6 / ko 5 / th 6 / zh 8 / ja 16) |
| A3 | Two thresholds | PASS — target warns, ceiling refuses |
| A4 | **Brevity never blocks a human** | PASS — `report.passed === true` asserted for a 16-word stem |
| A5 | Refusals teach the next prompt | PASS — three codes added to `LESSON_BY_CODE` |
| A6 | Prompt versions pinned | PASS — 5 prompts, versions asserted by test |
| A7 | `VERBOSE` non-blocking + non-repairable | PASS — `blockingCodes` excludes it, `isReQaOnly` true |
| A8 | Warnings actually rendered | PASS — `quality-warnings.tsx` + test rendering real `en.json` ICU |
| A9 | Zod rails de-duplicated, human path closed | PASS — `generation/schemas.ts`, imported by `contracts/models.ts` |
| A10 | `en`/`nb` key sets identical | PASS — verified by node comparison |

Full suite at this point: **755 passed, 0 failed**; `eslint` clean; `next build` clean.

## Part 2 — the campaign

### The freeze exception (B1, B2)

The freeze is a DB trigger, not only `upsertItem`'s throw. Verified against real Postgres in one
transaction with savepoints:

```
1. content update, no GUC          → ERROR: MasterItem ... is approved and frozen   ✓
2. content + version, GUC set      → UPDATE 1, version 1 → 2                        ✓
3. correctOptionKey change, GUC set→ ERROR: ... may change text and version only     ✓
4. legalCitations change, GUC set  → ERROR: ... may change text and version only     ✓
```

So during the campaign the answer key and the citations are protected by Postgres itself.
`rewrite.guc.test.ts` asserts exactly one file may set the GUC.

### Migration safety, measured on production (B14 partial)

`prisma migrate deploy` on production, before and after:

```
BEFORE: items=1259 translations=4529 signs=287
AFTER:  items=1259 translations=4529 signs=287
hnsw indexes:  KbChunk_embedding_hnsw_idx, MasterItem_stemEmbedding_hnsw_idx   (both intact)
searchText:    still a generated column
SimplificationProposal: exists=1
```

Zero rows changed. Prisma's generated SQL had proposed dropping both HNSW indexes and the
generated-column defaults; those four statements were removed by hand, as `prisma/migrations.test.ts`
requires.

### No-gap guarantee (B9)

`nogap.integration.test.ts`, against the real serving path (`loadQuestionOverlay` + `mergeQuestion`):

- before the rewrite the translation is served;
- after the swap the served text is the FRESH translation — not the stale one, and not English;
- rollback restores the old English **and** the old translation together;
- with a deliberately stale `sourceHash` the old translation is **still served** — proving the
  serving path is blind to staleness, so the guarantee comes from the atomic swap and not from any
  downstream check.

### Rollback (B4)

`created:0, reused:1` in the publish log on rollback — the original `ItemVariant` is revived by its
`contentHash` rather than a third row being created. Version is restored too, which re-validates the
original `ItemApproval` rows.

## Findings about production, independent of this campaign

1. **6 of 148 text/image questions cite sources with zero ingested chunks** — `vegtrafikkloven`
   (§ 3, § 12, § 22) and `kjoretoyforskriften` (§ 8-1, § 13-3, § 28-1). Their citations cannot be
   verified by anything, and the campaign refuses them as `CITATION_UNRESOLVABLE`.
2. **At least one approved question fails a blind answer check as it stands** (`…ouy9on`). The theory
   generation path never ran that check, so those questions have never had their key independently
   reproduced. Flagged `PREEXISTING_DISPUTE`, logged at warn.
3. **Two SERVICE signs are identical** — `XSE015` and `XSE016`, both "Youth hostel" with the same
   meaning, from the original extraction. The distinctness gate compares against a baseline so this
   does not block the campaign.
4. **`Sign.provisional` is 286 of 287** — the sign registry review backlog predates this work.

## Bugs found by running it, and fixed

| Symptom | Cause | Fix |
|---|---|---|
| Run died on item 1 | `isActive` filtered on `KbSource`, which has no such column | filter the chunk |
| 11 of 20 citations unresolvable | KB is chunked per section (`§ 7`); citations name subsections (`§ 7 nr. 3`) | exact ref, then section head — 142/148 |
| Run aborted on item 3 | verifier answered `choice: 0`; `verdictSchema` had `.min(1)` so Zod threw for the whole call | drop `.min(1)`; the `!chosen` branch already refuses correctly |
| One item killed the whole run | no per-item isolation | try/catch per item, recorded as ERROR |
| 13 identical `NUMBER_DRIFT,CITATION_DRIFT` | prompt demanded ≤2 sentences AND every `§` kept; model dropped the reference | reference is explicitly outside the sentence budget (prompt 1.1.0) |
| Refusals undiagnosable | refusals not persisted; gate returned codes without detail | persist refusals with `checks.drift` |
| Already-short questions rewritten | no pre-filter | `ALREADY_SHORT` skip before any AI call |
| `BLIND_DISAGREED` ambiguous | could not tell a broken rewrite from an already-disputed question | baseline blind check on the original, only on disagreement |

## The limit of the automated gates — stated plainly

The gates catch mechanical faults. They do **not** catch a shortening that stays legally true while
asking something broader. Observed on real data:

> **Before:** "You are approaching a marked pedestrian crossing **where traffic is not regulated by
> police or traffic lights**, and a pedestrian is on their way out into the crossing. What must you do?"
>
> **After:** "What must you do when a pedestrian enters a crosswalk?"

Every gate passed: key unchanged, no number drift, distractors distinct, blind verifier agreed —
because § 9 nr. 2 supports yielding in the general case too. But the rewrite dropped the condition
that the crossing is unregulated, which changes what is being asked.

**Therefore a human must read the accepted diffs before `--apply`.** `pnpm qb:simplify diffs --run <id>`
prints each pair and names the content words a rewrite dropped from the stem, because a lost
qualifier is how a specific question silently becomes a general one.

## Part 3 — the production run (2026-09-24)

### What production looked like before this session

| Fact | Evidence |
|---|---|
| Source at branch tip `4a97c77`; both spec-22 migrations applied 2026-09-22 | `_prisma_migrations` |
| Running app was the **2026-09-12 build** — pulled, never rebuilt | build id mtime |
| Campaign runs on 2026-09-22: five dry runs, then one `apply-…` run | `SimplificationProposal.runId` |
| That apply: 139 proposals → 86 PROPOSED, 53 REFUSED, **47 swapped** (43 TEXT + 4 IMAGE), 39 held on a translation QA failure | `AuditLog item.simplified = 47`, 47 `ItemVariant` rows created that day |
| **0 of 287 sign meanings** rewritten, 0 of 574 approved SIGN questions re-rendered | `Sign.updatedAt` max = 2026-09-08 |
| No proposal had ever been marked `APPLIED` — nothing set that status | `status` group by |

So students saw ~6 % of the bank shortened, and the live generate path still ran the pre-budget
prompts. That is the "I can't see the changes" report, explained.

### Workflow fixes made before touching production again

- `--from-run <id>` for `text` and `signs`: the reviewed run's PROPOSED rows are what gets applied;
  rows become APPLIED; a moved item is a hold (`apply-proposals.ts`, 6 tests).
- A sign question already rendered from the current registry is skipped on a retry, and the retry
  indexes the old text the applied proposals remember (the first retry held all 9 with
  `UNRESOLVED_OPTION` because the index only knew today's registry).
- The shadow translation is repaired (spec-19 repair prompt, ≤ 2 attempts) before an item is
  held, and a thrown provider error is retried once (`shadow-translate.test.ts`, 7 tests).
  Measured on the retry: 23 of 70 flagged translations rescued.
- Full suite after these: **782 passed, 80 files**.

### Deploy

Backup taken and verified; `git pull --ff-only`; install; explicit `prisma generate`;
`migrate deploy` → "No pending migrations"; `next build` 62 s; both pm2 apps restarted and
online; `/en` → 200; worker heartbeat present. From this build on, `theory` 1.3.0 / `image`
1.1.0 / `signMeaning` 1.1.0 and `brevityBlockers` are what the live generate path runs.

### Signs (run `signs-dry-20260924`)

Dry run: **221 accepted · 30 kept · 36 refused** (34 `MEANING_TOO_LONG_*` even after rewriting,
2 `NAME_CHANGED`, 7 `NO_GAIN`) · 3 transient provider errors. The set-level gate reported one
collision the rewrite would introduce — XVV015/XVV016, both "Numbered county road", would have
become word-for-word identical — so XVV016 was refused by hand (`HUMAN_COLLISION`) and keeps
its text. `class distinctness: OK` on apply.

Apply: 220 meanings written; **285 of 287** meaning questions re-rendered and swapped with fresh
bn/es/fr(/ar) translations. Two remain held after four passes: one whose Spanish translation
the model returns as malformed JSON every time, one whose Bangla fails `ANSWER_PERMUTED`.

### Text / image (run `text-dry-20260924`)

Dry run: **55 accepted · 38 kept · 55 refused** (35 `ALREADY_SHORT`, 14 `DUPLICATE_OF_EXISTING`,
12 `NUMBER_DRIFT`, 8 `DISTRACTOR_COLLISION`, 6 `BLIND_DISAGREED`, 5 `EXPLANATION_TOO_LONG`, 3
`CITATION_UNRESOLVABLE`, 3 `STEM_GREW_NB`, 2 `PREEXISTING_DISPUTE`, …).

All 55 diffs read. Three refused by hand:

| item | why |
|---|---|
| `…xrnb6zd5` | English explanation now reads "drive **sakte** or stop" — a Norwegian word in the English |
| `…bhuwj2iz` | English stem and option now say "**gangfelt**" where the source said "pedestrian crossing" |
| `…vb73lh4z` | dropped "at a stop **without a traffic island**" — the condition that makes § 9 nr. 3 apply; the question broadened |

Of the 15 `SCOPE` suspects the diff tool flagged, the other 12 keep the same answer and the same
case (e.g. "narrow road" dropped where the blockage rule does not depend on width).

Apply from the reviewed run, three passes: **37 of 52 applied**, 15 held — 13 on Bangla
`SEMANTIC_DRIFT` (short stems score under the 0.86 round-trip threshold `qa.ts` itself calls
"a starting point… to be re-measured"), 2 on `NUMBER_DRIFT` in the § 15 "paragraph N" citations.
Held items keep their old text in every language — no gap, no fallback.

### Verification (SQL on production, after the runs)

```
pool:  TEXT 136 / IMAGE 12 / SIGN 574 approved = 722     task sets: 10 PUBLISHED, 704 members
rewritten today: SIGN 285, TEXT 32, IMAGE 5   (+47 on 09-22)   audit rows: 285 + 37
translations of items rewritten today: bn 322 MACHINE, es 322, fr 318, ar 55 — none NEEDS_REVIEW
i18n:audit  bn 1335 checked 0 refused · es 1335/0 · ar 337/0 · fr 372/0
served sample (…ej4xgzmb): en "How must you drive when approaching or entering an intersection?"
  bn MACHINE / es MACHINE / fr MACHINE rows present with the new stem
residue: text/image stems > 15 words 45/148 · sign meanings > 12 words 47/287 (36 refused as
  still too long) · meaning-question options > 12 words 199/1148 (was 1137/1148)
```

### Found on the way, outside this campaign

The served sample's Bangla stem carried one Arabic letter inside a Bengali word ("ঢوকার"). A
regex over the table finds **22 bn rows** with Arabic-script letters, most predating today; the
per-field script gate passes a field as long as it contains Bengali at all. Fixed in this branch:
a letter of a foreign non-Latin script inside a word of the target script is now
`MIXED_SCRIPT_WORD` (blocking), and `i18n:audit --apply --repair` was run for bn to hold and
repair those rows.
