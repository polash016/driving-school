# spec-22 — Short, easy questions: a shortness contract + a one-time rewrite campaign

## Context

Students sit TeoriPro on a phone at a 390px design target. The bank today was written with no
length budget at all: `theoryGenerationPrompt` ([index.ts:46-127](src/server/ai/prompts/index.ts#L46-L127))
has ten hard rules and not one mentions length — rule 5 only says the correct option must not be
"noticeably longer" than the others, a *relative* constraint a model satisfies by making every
option long. The only absolute limits are Zod caps the model is never told about (option 300 chars,
stem 400, explanation 1000, in [theory.ts:37-72](src/server/services/generation/theory.ts#L37-L72)
and a duplicated copy in [image.ts:63-89](src/server/services/generation/image.ts#L63-L89)), plus a
`STEM_LONG` *warning* at 400 chars. Nothing anywhere asks for plain words.

The result is questions a learner reads twice and options that wrap to seven lines on a phone. That
hurts most exactly where the product is meant to help: a student whose Norwegian is weak, reading a
translated exam.

This spec does two things:

1. **A shortness contract** — every AI path that writes text a student reads is given the budget,
   and the gate enforces it. Applies from now on, in every language.
2. **A one-time rewrite campaign** — the ~722 approved questions already in the bank are rewritten
   shorter and easier, and the three live languages (es, ar, bn) are re-translated from the new
   source by the existing sync.

Target, chosen by the developer: **stem ≤ 15 words, each option ≤ 8 words, explanation ≤ 2 short
sentences**, at an A2/B1 reading level — everyday words, one idea per sentence, active voice,
second person.

### The problem, measured

From the committed payloads, not estimated.

**The 130 text/image questions** (`prisma/data/translations/es-questions-{1,2,3}.json`, the Spanish
rendering of the whole text bank):

| | median | p90 | max | over budget |
|---|---|---|---|---|
| stem | 19 w | 28 w | 38 w | **90 of 130 (69%)** |
| option | 10 w | 16 w | 34 w | **242 of 402 (60%)** |
| explanation | 40 w | 60 w | 109 w | 15 of 130 over 2 sentences |

**The 287 sign meanings** (`prisma/data/signs.json`) — not reference copy: these *are* the option
text of the 574 sign questions.

| | median | p90 | max | over budget |
|---|---|---|---|---|
| `meaning.en` | 21 w | 29 w | 40 w | **283 of 287 (99%)** |

A typical one: *"This sign indicates the distance to a railway level crossing. Each stripe
represents approximately one-third of the distance to the crossing."* Nearly every meaning opens
with the stock preamble "This sign indicates that…" — pure waste, repeated four times per question.
**287 rows fixed → 574 questions fixed** makes this the highest-value target in the campaign.

There is no truncation to hide any of it: [question-card.tsx:89](src/components/quiz/question-card.tsx#L89)
renders each option as a `min-h-[3.25rem]` button at `text-base/relaxed` with no `line-clamp`, so
the button just grows. At 390px the text column is roughly 280px — about 32 characters a line.

---

## Part 1 — The shortness contract

### 1.1 The budget is config, not a magic number

New `content.brevity` block in [config/school.config.ts](config/school.config.ts), Zod-validated
beside the existing `ai` section:

```ts
content: { brevity: {
  stemWords: 15,
  optionWords: 8,
  explanationWords: 24,       // "two short sentences", counted reliably
  explanationSentences: 2,    // advisory, en/nb only
  signMeaningWords: 12,       // a sign meaning IS an option; 8 words cannot hold a conditional sign
} }
```

Not the DB: CLAUDE.md mandate 4 reserves DB config for *license-class parameters* (question count,
time limit, pass mark) — parameters of the exam itself. A brevity budget is editorial house style
and must stay in lockstep with prompt text that lives in git; a DB value could drift from the prompt
silently, with the gate refusing what the prompt asked for and no commit to blame. The precedent for
this class of value is already there: `ai.translationBatchSize`, `ai.rateLimitRetries`.

Sign meanings get their **own, larger budget**. 8 words cannot express a prohibition sign carrying a
weight, time or vehicle-class condition.

### 1.2 Counting words in a multi-script world — `src/lib/brevity.ts` (new)

"≤ 15 words" is meaningless for Thai or Chinese, which have no spaces. The answer is not a
hand-rolled char budget — it is `Intl.Segmenter`, which I verified on this machine's runtime
(node v24.13.1, full ICU):

```
en  7  You must stop before the pedestrian crossing.
nb  5  Du må stoppe før gangfeltet.
ar  6  يجب أن تتوقف قبل ممر المشاة.
bn  6  পথচারী পারাপারের আগে আপনাকে থামতে হবে।
ko  5  보행자 횡단보도 앞에서 정차해야 합니다.
th  6  คุณต้องหยุดรถก่อนทางม้าลาย        ← no spaces, dictionary segmentation
zh  8  你必须在人行横道前停车
ja 16  歩行者横断歩道の前では必ず停止しなければなりません   ← morpheme-level, ~2× inflated
```

Every script lands in the right range except Japanese, which ICU segments at morpheme level. So:
**count words with `Intl.Segmenter`, then apply a per-script factor** — a small table in which only
`ja` (≈2.0) carries real weight, with `zh`/`ko`/`th` near 1.0 and everything else exactly 1.0.

This is better than a character budget in both directions: it handles Thai correctly *and* it stops
Norwegian and German compounding (`vikepliktsskiltet`) from being punished for being correct and
short. Guard the call with `typeof Intl.Segmenter === "function"` and fall back to a Unicode-aware
regex so a small-ICU build degrades instead of throwing.

**Explanation is enforced in words, not sentences.** Sentence splitting is unverifiable in Thai (no
terminator), inflated in Japanese, and gameable everywhere by comma-splicing. The prompts still
*say* "two short sentences" because models understand that; the gate measures words. A sentence
count survives only as an advisory warning restricted to `en`/`nb` — the two languages a reviewer
here actually reads.

### 1.3 Two thresholds, not one

| Threshold | Value | Where it bites |
|---|---|---|
| **target** | 15 / 8 / 24 | The approval gate — a *warning* |
| **ceiling** | target × 1.4 (21 / 11 / 34) | The generation loop — a *per-candidate refusal* |

The band between them is where a rule that genuinely needs an extra clause lives. A single
threshold would either block correct questions or teach the model nothing.

| Caller | Threshold | Severity | Why |
|---|---|---|---|
| `generation/theory.ts`, `generation/image.ts`, the campaign | ceiling | **blocks that one candidate** | Refusal costs one candidate in ten, and `recordRejection` already feeds the reason into the next prompt through `buildRejectionLessons`. The only surface where blocking is both free and self-correcting. Place it **before** the blind-verification call in `image.ts` so an over-long candidate never costs a vision round-trip. |
| The admin approval gate | target | **warning only** | [transitions.ts:144-150](src/server/services/question-bank/transitions.ts#L144-L150) turns any error into a `ValidationError` **with no override path in the UI**. An error here would make the 574 seeded sign questions and every already-approved long item permanently unapprovable. |

**The escape hatch, stated plainly:** brevity is never an error on a path a human controls. A
question needing 18 words clears the ceiling and produces a visible, approvable warning. The
reviewer approving anyway *is* the override — no new flag, column or permission.

Also add the new codes to `LESSON_BY_CODE`
([rejections.ts:68-80](src/server/services/question-bank/rejections.ts#L68-L80)) so a refusal
teaches the next run: *"the question was longer than the 15-word limit"*.

### 1.4 The hole in this design, and the fix

**`checkItemQuality(...).warnings` is discarded at every single call site.** I grepped every
`.warnings` reference in `src/` and `scripts/`: all of them belong to task-set composition, quiz
assembly or `exam-audit.ts`. Not one is the quality report. `theory.ts`, `image.ts`,
`transitions.ts` and `seed-sign-questions.ts` all read `.passed`/`.errors` and throw the warnings
away.

So a warning-only brevity check has **zero observable effect on the human path** as things stand.
Shipping §1.3 without fixing this would mean claiming an enforcement that does not exist.

**Fix, in scope for this spec:** surface `QualityReport.warnings` in the review UI
(`src/components/admin/questions/`), and give `QualityIssue` a `values?: Record<string, string|number>`
field so the message can render "The question is 19 words long — the limit is 15." Without this,
Part 1 is a generation-side feature only, and the plan should say so rather than imply otherwise.

### 1.5 Zod: leave the caps loose, but de-duplicate them

**Do not tighten toward the budget.** `aiJson` parses the schema *after* the whole route loop with
no retry ([client.ts:291-300](src/server/ai/client.ts#L291-L300)) — one 9-word option in a batch of
ten throws `AiPipelineError` and destroys nine good questions plus the tokens that made them. A Zod
cap is a whole-batch instrument; brevity is a per-candidate judgement, and the per-candidate
refusal in §1.3 is the right instrument.

Do three things anyway:
- Extract the identical schemas from `generation/theory.ts:37-72` and `generation/image.ts:63-89`
  into `src/server/services/generation/schemas.ts`, rails unchanged (300/400/1000).
- Close the divergence: [contracts/models.ts:71-80](src/server/contracts/models.ts#L71-L80) — the
  human path — has **no max at all** on stem or option text. Give it the same rails, imported from
  the same module so the two cannot drift again.
- Comment in `schemas.ts` that these are runaway-output rails, not editorial policy, and that the
  parse at `client.ts:292` is post-route and non-retrying — so nobody tightens them later.

`translationResponseSchema` stays limitless for the same batch-mortality reason.

New i18n keys under `admin.quality.*` in **both** `en.json` and `nb.json` (`stemLong` retuned from
chars to words, plus `optionLong`, `explanationLong`, `explanationSentences`).

### 1.6 Prompt changes (every one bumps `version` — house rule, [index.ts:1-13](src/server/ai/prompts/index.ts#L1-L13))

**`theoryGenerationPrompt` 1.2.0 → 1.3.0** — new rule 11:

> `11. Write SHORT and write PLAIN. The stem is at most 15 words. Each option is at most 8 words. The explanation is at most two short sentences. Use everyday words a learner driver knows: one idea per sentence, active voice, second person. Cut every word that carries no meaning — "This sign indicates that you must stop" is "You must stop". Never pad an option to match the length of another; trim the others instead.`

**`imageQuestionPrompt` 1.0.0 → 1.1.0** — a new bullet in "Every question must:":

> `- be SHORT and PLAIN: a stem of at most 15 words, options of at most 8 words each, an explanation of at most two short sentences. Everyday words, one idea per sentence, active voice, second person.`

**`signMeaningPrompt` 1.0.0 → 1.1.0** — this is the highest-leverage edit in the file. Replace the
`meaningEn` line:

> `  meaningEn — ONE sentence, at most 12 words, saying what this sign requires the driver to do.`
> `  meaningNb — the same meaning in Norwegian Bokmål, also ONE sentence of at most 12 words.`

plus two new rules:

> `- This sentence is shown to students AS AN ANSWER OPTION beside three others, so it must be readable at a glance: everyday words, active voice, second person, no sub-clause, no semicolon.`
> `- Start with what the driver does, not with the sign: "Give way to traffic from the right", "You must not overtake here", "Maximum speed is 50 km/h". Never "This sign means…" and never the sign's own name.`

**`translateUnitsPrompt` 1.1.0 → 1.2.0** — rule 8 rewritten and a new rule 10. The prompt gains a
`lengthBudget` variable rendered from the same config, so prompt and gate can never state different
numbers (for German: *"about 20 words in a question, 11 in an option, 32 in an explanation"*):

> `10. NEVER LONGER THAN IT HAS TO BE. The source was written to a strict budget: 15 words for a question, 8 for an option, 2 sentences for an explanation. {lengthBudget} If {targetLanguage} genuinely needs more words to say the same thing, take them — but never add an idea, an example, a courtesy or an explanation the source does not have. Being one word over is fine; cutting meaning to hit a number is not.`

**`translateRepairPrompt` 1.1.0 → 1.2.0** — the same budget sentence folded into rule 7.

`backTranslatePrompt` is deliberately **unchanged**: it must stay literal, and shortening a
back-translation would hide exactly the drift it exists to reveal.

Bumping these re-translates nothing by itself — translation memory is keyed `locale + sourceHash`
(DECISIONS.md, 2026-09-12). The new rules therefore bite on units translated *from now on*: new
languages, new questions, and every unit Part 2 rewrites.

Call sites needing the new variable: [translate.ts:205-212](src/server/services/i18n/translate.ts#L205-L212)
and [repair.ts:381-388](src/server/services/i18n/repair.ts#L381-L388).

### 1.7 The translation side is non-blocking *and* non-repairable

[i18n/validation.ts](src/server/services/i18n/validation.ts) gains `VERBOSE` as a **non-blocking**
flag, a sibling of the existing non-blocking `LENGTH_OUTLIER` (`:377-389`), raised per field when a
translation exceeds its target × script factor × 1.3 (translation slack) × 1.4 (ceiling). Reuse the
file's existing private `fieldPairs` helper, which already yields per-field names (`stem`,
`option a`, `explanation`) for the detail string.

Two reasons, not one:

- **Non-blocking**, because a blocking flag lands the unit in `NEEDS_REVIEW`, which
  `partitionBlockers` ([languages.ts:114-152](src/server/services/i18n/languages.ts#L114-L152))
  counts as `FLAGGED` — so shortness-as-blocker would stop German, Tamil and Arabic publishing for
  being themselves.
- **Added to `NOT_A_QUALITY_FLAG`** ([validation.ts:31-34](src/server/services/i18n/validation.ts#L31-L34)),
  so auto-repair never spends a model call on it and bulk approve offers it pre-ticked. A model told
  to "make it shorter" trims meaning — on a legal exam that is the worse failure. The file's own
  comment already frames this set as "is this a statement about correctness?", and verbosity is not.

`VERBOSE` must also be added to the `FLAG_KEYS` arrays in
`src/components/admin/languages/translation-review.tsx` and `sample-results.tsx`, or the chip
renders the raw code.

---

## Part 2 — The one-time rewrite campaign

### 2.1 Why in-place, and the one bug it would otherwise trigger

`upsertItem` ([items.ts:227-233](src/server/services/question-bank/items.ts#L227-L233)) throws
`approvedIsFrozen` for an approved item, and `replaceItem` (`:313-362`) retires the original
*immediately* — running that 722 times would drain the approved pool and break task sets and live
exams. The developer chose an in-place, audited path instead, which needs its own service function:
neither `upsertItem` nor `replaceItem`.

In-place is safe for past results because `unpublishItem`
([publish.ts:175-183](src/server/services/question-bank/publish.ts#L175-L183)) only sets
`isActive: false`, and `ExamAttemptQuestion` references the variant row directly — a sat paper still
renders the exact text the student saw. `ItemVariant.content` is immutable by DB trigger and
`contentHash` is unique, so new content always makes a *new* row.

**But:** `loadOverlay` ([resolve.ts:44-79](src/server/services/i18n/resolve.ts#L44-L79)) selects a
translation by `locale + entity + entityId + status` and **never compares `sourceHash`**.
`loadQuestionOverlay` (`:106-127`) guards with `masterVersion === currentMasterVersion`, whose own
comment says it exists so we never show "a translation of a different question than the one they
sat". That guard does not hold here: the apply step bumps the master version *and* republishes, so
the new variant passes the filter while the `Translation` row still holds the old, long text.
`mergeQuestion` merges by option key, and the rewrite keeps keys byte-exact — so every key matches
and stale text is served silently over the new question.

Today this is unreachable, because approved items are frozen. This campaign creates the first way
to trigger it.

**Decision (SUPERSEDED — see below):** park translations to `NEEDS_REVIEW`.

> **2026-09-21 — the developer chose the no-gap option instead.** Parking means a Bangla or
> Spanish student reads English until re-translation, and with bn/es each holding ~2 040 approved
> translations in production that window is days. The campaign therefore stages the shortened text
> AND every locale's translation of it in a new `SimplificationProposal` table, and swaps master
> content, variant and all four translations in ONE transaction. No student ever sees English, and
> no student ever sees a stale pairing. All four languages (bn, es, ar, fr) are re-translated.

~~The original decision:~~ the apply step set every `Translation` row for a rewritten item to
`NEEDS_REVIEW`. `servableStatuses` ([resolve.ts:29-35](src/server/services/i18n/resolve.ts#L29-L35))
excludes `NEEDS_REVIEW` under both policies, so the question falls back to English the instant it is
rewritten and stays English until the sync re-translates. This reuses the trade-off spec-21 already
made ("a flagged question reads English meanwhile, which beats Banglish") instead of inventing a
second mechanism, and it preserves review history, unlike deleting the row.

Already-published languages are unaffected: the coverage gate in
[languages.ts:456-484](src/server/services/i18n/languages.ts#L456-L484) only fires on the
false→true transition of `studentVisible`.

### 2.2 New files

| File | What |
|---|---|
| `src/server/ai/prompts/simplify.ts` | `simplifyQuestionPrompt` (`rewrite.simplify-question`, 1.0.0) and `simplifySignMeaningPrompt` (`rewrite.simplify-sign-meaning`, 1.0.0) |
| `src/server/services/question-bank/simplify.ts` | The service: propose → verify → apply → roll back |
| `scripts/simplify-questions.ts` | `pnpm qb:simplify [--apply] [--max N] [--type TEXT\|IMAGE] [--rollback <runId>]` |
| `scripts/simplify-signs.ts` | `pnpm signs:simplify [--apply] [--max N]` |
| `src/server/services/generation/schema.ts` | The de-duplicated candidate schema (§1.3) |
| `src/lib/text-budget.ts` | The measure (§1.2) |

CLI shape follows the house pattern of [audit-translations.ts](scripts/audit-translations.ts) and
[dedupe-questions.ts](scripts/dedupe-questions.ts): **dry run by default**, `--apply` to commit,
resumable, prints a table.

### 2.3 `simplifyQuestionPrompt` — the literal text

> `You are shortening one question from the Norwegian driving theory test (class B). It is already correct and already approved. Your ONLY job is to say the same thing in fewer, plainer words.`
>
> `HARD RULES — breaking any of these puts a wrong answer in front of a learner driver:`
> `1. Do not change which option is correct. The option with key "{correctOptionKey}" must remain the only defensible answer, and every other option must stay clearly wrong for the same reason it is wrong now.`
> `2. Copy every option key byte for byte, in the same order. Never add, drop, merge or reorder options.`
> `3. Never change a number, a unit or a legal reference. 50 km/h stays 50 km/h. 0,2 stays 0,2. § 7 stays § 7.`
> `4. Keep the question testing exactly the same point. Do not make it easier, harder, broader or narrower, and do not turn a specific rule into a general one.`
> `5. Both languages still test the same thing: en and nb keep the same option order and the same correct key.`
>
> `THE BUDGET: stem at most 15 words · each option at most 8 words · explanation at most two short sentences.`
>
> `HOW to shorten:`
> `- Cut words that carry no meaning: "This sign indicates that you must…" is "You must…".`
> `- Drop scene-setting the question does not turn on. If the speed limit is irrelevant to the rule, it is padding.`
> `- Everyday words. Second person, active voice, one idea per sentence.`
> `- Shorten EVERY option, not only the long ones — an option left long while the others shrink becomes the giveaway.`
>
> `IF YOU CANNOT SHORTEN AN ITEM WITHOUT CHANGING WHAT IT TESTS, SAY SO: return it with "issue" set to a short explanation and leave its text unchanged. A question left long is fine. A question quietly changed is not.`

### 2.4 The verification chain — every step must pass, or the item is left alone

The default on any failure is **skip and record**. The existing question is correct; it is merely
long. Never trade correctness for brevity.

1. **Zod parse** against the shared candidate schema.
2. **Structural identity** (deterministic, free, catches the catastrophic failure): same option
   keys, same count, same order, `correctOptionKey` unchanged, `legalCitations` unchanged,
   `difficulty` unchanged, both locales present with matching key order.
3. **Number and § preservation** — reuse the spec-21 machinery in
   [i18n/validation.ts](src/server/services/i18n/validation.ts), including its native-digit
   normalisation, so "50 km/h" and "§ 13 nr. 3" survive the rewrite. Extract the shared checker
   rather than copying it.
4. **`checkItemQuality`** with `brevity: "error"` — the rewrite must actually meet the budget, and
   must still pass every existing rule (no banned options, no duplicate options, keys aligned).
5. **Actually shorter** — every field must be shorter than before. If not, skip: no churn, no
   version bump, no re-translation cost.
6. **`verifyAnswerBlind`** ([validators.ts:60-110](src/server/services/pipeline/validators.ts#L60-L110))
   at temperature 0, options reshuffled, key withheld. `legalText` comes from the `KbChunk` rows
   matching the item's stored `legalCitations`; `situationSummary` is empty for a text question and
   `sceneSupported` defaults to `true`, so an absent scene cannot spuriously refuse. **This is the
   check that earns the campaign** — the theory generation path never ran it
   ([theory.ts:238-269](src/server/services/generation/theory.ts#L238-L269) is gate + dedupe only),
   so a side effect is that all 130 text questions get their answer key independently re-verified
   for the first time.
7. **`checkDistractorDistinctness`** (embedding, 0.93). The sharpest risk in the whole plan:
   shortening four options can collapse two of them into near-synonyms, turning a gradeable
   question into a disputed one.
8. **`checkStemDoesNotLeakAnswer`** (embedding, 0.90).
9. **Duplicate safety** — the new `stemFingerprint` must not collide with another approved item, and
   the new stem embedding must stay under `REPEAT_THRESHOLD` (0.94) against the pool excluding
   itself. Shortening makes two previously distinct questions much more likely to converge.

### 2.5 The apply step

Per item, one transaction where the Prisma client allows it:

1. `masterItem.update({ content, version: version + 1 })`
2. `unpublishItem(db, id)` — old variants go inactive; attempts keep their snapshot
3. `publishItem(db, id)` — creates the new variant and calls `requestTranslationSync`
4. `storeStemEmbedding(db, id, newEmbedding)` ([similarity.ts:111](src/server/services/question-bank/similarity.ts#L111)) — the old embedding is stale the moment the stem changes
5. `translation.updateMany({ entity: "MASTER_ITEM", entityId: id })` → `status: NEEDS_REVIEW`, push `SOURCE_REWRITTEN` onto `qaFlags`, `repairAttempts: 0` — the §2.1 fix
6. `invalidateAccuracyStats()`
7. `auditLog` with a new `AUDIT.itemSimplified = "item.simplified"` constant in
   [src/server/audit.ts](src/server/audit.ts), whose `meta` carries `previousContent`,
   `previousVersion`, `promptVersion`, `modelVersion` and the campaign run id

**Rollback** is real, not aspirational: `--rollback <runId>` reads `previousContent` back out of the
audit rows and re-applies it through the same path. The old `ItemVariant` still exists with its
`contentHash`, so republishing the old content **revives that row** rather than creating a third one
([publish.ts:118-133](src/server/services/question-bank/publish.ts#L118-L133)) — the student-facing
history stays a straight line.

### 2.6 The two-reviewer question — stated plainly

`ItemApproval` is keyed by `(masterItemId, itemVersion)`, so bumping the version **voids the
recorded two-reviewer sign-off**. The item stays `APPROVED` (the campaign never calls
`transitionItem`), so serving is unaffected — but the audit trail would then say "approved at v3"
for an item serving v4. That is a genuine integrity gap and must not be papered over by writing
fake `ItemApproval` rows.

**Recommendation:** leave the approvals voided and record in `DECISIONS.md` that the campaign is an
ADMIN-authorised editorial edit whose accountability is (a) the audit log with `previousContent`,
(b) the blind answer check in §2.4 step 6, and (c) **a mandatory human spot-check of a 30-item
sample from the dry run before any `--apply`**, with the reviewer named in
`specs/notes/spec-22-notes.md`. This is honest about what did and did not get re-reviewed.

### 2.7 Signs — order matters

1. **Rewrite all 287 `Sign.meaning` rows first** (`pnpm signs:simplify --apply`), to the 12-word
   sign budget of §1.1 — not the 8-word option budget, because a prohibition sign carrying a weight,
   time or vehicle-class condition cannot be said in eight words. `Sign.name` is left alone: those
   are official names, not our prose.
2. **Then measure distinctness per class.** Distractors are other signs' meanings from the *same
   class* ([seed-sign-questions.ts:110-130](scripts/seed-sign-questions.ts#L110-L130)). If
   shortening collapses several meanings in a class to "Give way.", the distractor pool shrinks and
   questions become ungradeable. Gate: every class must retain at least 4 distinct meanings, and no
   two meanings in a class may be identical. Fail → fix those rows by hand before step 3.
3. **Then refresh all 574 sign questions** — not before, because every meaning is a potential
   distractor in every other question in its class.

The refresh needs a new `--refresh` mode on `seed-sign-questions.ts`: today it is idempotent by
**skipping** a sign that already has its two questions, so a plain re-run changes nothing. `--refresh`
recomputes each pair's content and applies it through the **same in-place path as §2.5**, keeping
`MasterItem` ids stable so task sets are untouched. It must reuse the **original `--seed`** so the
same distractor *signs* are chosen and only the text shortens; if the original seed was not
recorded, reshuffling is acceptable but must be a stated choice, not an accident.

The blind answer check is **skipped** for the sign rebuild. "The correct answer is this sign's own
meaning" is definitional, not derivable from regulation text, so the verifier would return
`unanswerable` for all 574. The safety property is the one the script already rests on: the registry
is what a human signs off, and the registry rewrite was checked in step 1. `checkItemQuality` still
runs and still catches duplicate options.

### 2.8 Sequencing, blast radius, and what a student sees

| Phase | What | Blast radius |
|---|---|---|
| 1 | Part 1 — the contract | None. No data changes. Ship and verify alone. |
| 2 | Full dry run locally; export the diff table; human spot-checks 30 items | None |
| 3 | Signs: 287 meanings → distinctness gate → refresh 574 questions | Largest. Do it locally, verify, then prod. |
| 4 | Text/image: 130 questions, batches of 25, verify between batches | Small, easy to stop |
| 5 | Translation resync for es, ar, bn | Paced; see below |

**What a student sees while it runs.** English and Norwegian students see the new short question
immediately. A Spanish, Arabic or Bangla student sees that question **in English** from the moment
it is rewritten until its re-translation is approved — because of the `NEEDS_REVIEW` decision in
§2.1. Their language stays published throughout (spec-20 D3). This is a visible, temporary
degradation for non-built-in locales and the developer should expect it, batch by batch.

**Stopping mid-way is always safe:** each item is applied independently and each is individually
reversible from its audit row.

**Production.** Per the project's own operating notes: back up the prod DB before any swap; run
`prisma generate` explicitly on deploy; `storage/` is not in git; the i18n worker is a separate pm2
app whose config lives outside the repo.

### 2.9 The translation resync — measure, do not guess

Roughly 722 questions + 287 signs ≈ 1 009 units × 3 languages ≈ 3 000 unit-translations. Do not
plan against that estimate: `pnpm i18n:translate <code>` **without** `--apply` prints the real
planned-unit count and cost estimate. Run it per language and use those numbers.

Pacing is set by two known limits: the Gemini per-minute quota (a fast run trips it, burning units
to `SKIPPED` and flagging `QA_UNAVAILABLE`) and the 1 000/day embedding cap, which is what actually
blocks a language from publishing. Embeddings scale with the **QA-sampled** subset, not every unit
(`Language.qaSampleRate`), so the cap is likelier to bind on a language with a high sample rate.
Plan for several days, run one language at a time, and watch the run panel rather than assuming.

---

## Verification (WORKFLOW.md Phase C — each item PASS/FAIL with evidence into `specs/notes/spec-22-notes.md`)

**Part 1**
1. `pnpm test src/lib/brevity.test.ts` — the eight measured sentences above pin the script-factor
   table to measurement, not opinion; plus the `Intl.Segmenter`-absent fallback branch.
2. `pnpm test src/server/services/question-bank/validation.test.ts` — a 16-word stem raises
   `STEM_LONG` **and leaves `report.passed === true`** (the load-bearing assertion: brevity never
   blocks approval); a 22-word stem is in `brevityBlockers()`; a Norwegian 13-word compound stem
   raises nothing (proves the word-not-char choice); a `SIGN` item's option budget is 12, not 8.
3. `pnpm test src/server/ai/prompts/` — every bumped prompt renders its literal numbers **and its
   new version string is pinned by an assertion**. That pin is what keeps "bump the version on any
   wording change" enforceable now that a config value reaches prompt text: editing
   `content.brevity` breaks the test and forces a deliberate bump.
4. A mocked three-candidate batch where one stem is 25 words → that candidate alone is refused with
   `STEM_TOO_LONG`, a `GenerationRejection` row is written, and the other two still persist as
   DRAFT. This is the proof that the whole-batch failure mode of §1.5 was avoided.
5. `pnpm ai:generate <topic> 5` on a scratch DB → accepted candidates inside budget; **record the
   refusal rate** (see risks).
6. `pnpm test src/server/services/i18n/` — `VERBOSE` is raised for a 2.5× translation, is **not** in
   `blockingCodes()`, and `isReQaOnly(["VERBOSE"]) === true`; a German translation at 1.5× raises
   nothing.
7. The warnings are actually visible: a screenshot of the review screen showing a brevity warning on
   a real over-long item. Without this, §1.4 is unfixed and Part 1 is generation-side only.
8. Grep proof that no user-facing string was added outside i18n, and that `en.json`/`nb.json` carry
   the same `admin.quality.*` and `admin.languages.flags.*` key sets.

**Part 2**
9. `pnpm qb:simplify` (dry run) — table of before/after word counts; report the percentage now inside budget against the baselines in the Context table.
10. Structural-identity unit tests: a proposal that renames a key, reorders options, drops an option, changes a citation, or changes a number is **rejected**.
11. `simplify.integration.test.ts` — after apply: `MasterItem.id` unchanged, `version` +1, old `ItemVariant.isActive === false`, a new active variant exists, `Translation.status === NEEDS_REVIEW` for every locale, the audit row carries `previousContent`.
12. Rollback test: `--rollback <runId>` restores the original content and **revives the original variant row** rather than creating a third.
13. Task-set integrity after the sign refresh: `pnpm qb:audit` assembles full papers; approved count unchanged (574 + 130); no task set lost a question.
14. Sign distinctness gate: a query proving every `SignClass` retains ≥ 4 distinct meanings and no two meanings in a class are identical.
15. Blind-check outcome recorded: how many of the 130 rewrites were refused and why. **Any item where the blind check disagreed with the stored key is a pre-existing defect in the bank and must be reported separately, not silently skipped.**
16. Mid-campaign student behaviour: an e2e proving a rewritten question renders in English for a non-built-in locale whose translation is `NEEDS_REVIEW`, while the rest of the paper stays translated.
17. `pnpm test && pnpm e2e && pnpm lint` green before prod.
18. Post-resync: `pnpm i18n:audit <code>` clean for es, ar, bn; each language's coverage back to complete.

---

## Process (WORKFLOW.md)

This is **spec-22**. Before any code: write `specs/spec-22-short-questions.md`, save this plan as
`specs/plans/spec-22-plan.md`, add a row to the `specs/README.md` status board, and append a
`DECISIONS.md` entry the moment the developer approves — covering the four policy choices that
deviate from the obvious reading of the goal:

1. Approved items are rewritten **in place**, not through `replaceItem` — and the recorded
   two-reviewer sign-off is voided rather than forged (§2.6).
2. Brevity is **never blocking on a path a human controls** (§1.3).
3. `VERBOSE` is non-blocking **and** non-repairable (§1.7).
4. The Zod caps are deliberately left loose (§1.5).

Part 1 and Part 2 are separately shippable and should be separate commits. Part 1 changes no data.

## Open risks

- **Distractor collapse (§2.4 step 7)** is the one that could put a disputed question in front of a
  student. The embedding check is the guard; watch its refusal rate in the dry run.
- **The review UI does not render quality warnings today (§1.4).** Until that is fixed, the human
  half of the contract is inert. Do not report Part 1 as done on the strength of the generation
  block alone.
- **The Japanese factor of ~2.0 is calibrated on two sentences.** A defensible starting point, not a
  measurement. Keep the factor table in one file with the test that pins it, so it can be re-tuned
  against real output rather than re-argued.
- **The ceiling may reject more than expected on first contact.** Measure the refusal rate on the
  first real run; the rejection ledger makes it visible per batch. If it exceeds ~25%, raise
  `CEILING_RATIO` — not the prompt target. The prompt should keep asking for 15.
- **`QualityIssue` gaining a `values` field** flows into `ValidationError({ errors })` at
  [transitions.ts:147](src/server/services/question-bank/transitions.ts#L147) and into audit
  metadata. Confirm nothing serialises a `QualityIssue` where a schema would reject the new field.
- **Sign meanings losing legal precision.** "You must stop and give way to all traffic on the
  crossing road" → "Stop. Give way to crossing traffic." is fine; some prohibition signs carry
  conditions (weight, time, vehicle class) that 8 words cannot hold. Expect a tail of signs that
  must stay longer, and let them — the budget is enforced as a skip, not a truncation.
- **The registry is still provisional** (DECISIONS.md, 2026-08-25): all 287 signs carry AI-drafted
  meanings and placeholder codes pending the official Statens vegvesen pack. Shortening them now
  means doing this work twice if the official pack lands later. Worth deciding whether to shorten
  signs now or wait — though at 99% over budget and 574 questions affected, shortening now is
  probably still right.
- **Spec-17 (AI variants) is unbuilt** and reserves the `ITEM_VARIANT` translation entity. Nothing
  here conflicts, but the campaign should land before variants multiply the row count.
