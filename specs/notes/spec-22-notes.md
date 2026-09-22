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
