# Spec 22 — Short, easy questions: a shortness contract + a one-time rewrite campaign

**Status:** ✅ Done (Fable, production run 2026-09-24) · depends on 04, 05, 15, 19, 20, 21
**Approved:** 2026-09-20 (plan mode) · amended 2026-09-21 (no-gap swap)

## Why

The bank was written with no length budget. `theoryGenerationPrompt` had ten hard rules and none
mentioned length; rule 5 only said the correct option must not be "noticeably longer" than the
others — a *relative* constraint a model satisfies by making every option long. The only absolute
limits were Zod caps the model was never told about, and nothing anywhere asked for plain words.

Measured in production (2026-09-21):

| type | items | stem median | over 15 w | option median | options over 8 w |
|---|---|---|---|---|---|
| TEXT | 136 | 18 | 83/136 (61%) | 9 | 232/420 (55%) |
| IMAGE | 12 | 32 | 12/12 (100%) | 12 | 39/47 (83%) |
| SIGN · meaning | 287 | 5 | 0 | **22** | **1137/1148 (99%)** |
| SIGN · recognition | 287 | 5 | 0 | 3 | 24/1148 (2%) |

`Sign.meaning`: 287 rows, median 21 words, 283 over 8 words. Those rows ARE the option text of the
287 meaning questions, so 287 registry edits fix 1137 over-budget options. Recognition questions
offer sign NAMES and are already inside budget — they are out of scope by default.

At the 390px design target a 34-word option is seven lines, and `question-card.tsx` has no
`line-clamp`: the button simply grows.

## Scope

**Part 1 — the contract.** Every AI path that writes text a student reads is given the budget, and
the gate enforces it. Target: stem ≤ 15 words, option ≤ 8 (sign meaning ≤ 12), explanation ≤ 2
sentences, at A2/B1.

**Part 2 — the campaign.** The 148 approved text/image questions and the 287 sign meanings are
rewritten in place, and all four non-built-in languages (bn, es, ar, fr) are re-translated.

## Acceptance checklist

### Part 1
- [x] A1 Budget lives in `config/school.config.ts`, not as a magic number.
- [x] A2 Word counting works in every script served (`Intl.Segmenter`, per-script factors pinned by test).
- [x] A3 Two thresholds: generation refuses at the ceiling; the approval gate only warns.
- [x] A4 Brevity is NEVER an error on a path a human controls — `report.passed` stays true.
- [x] A5 Refusal codes feed `LESSON_BY_CODE` so the next prompt learns.
- [x] A6 All five prompts bumped, with version pins asserted by test.
- [x] A7 Translation-side flag `VERBOSE` is non-blocking AND in `NOT_A_QUALITY_FLAG`.
- [x] A8 Quality warnings are actually rendered to a reviewer (they were discarded at every call site).
- [x] A9 Zod caps de-duplicated; the uncapped human path closed.
- [x] A10 `en.json` and `nb.json` key sets identical.

### Part 2
- [x] B1 The freeze exception is keyed, transaction-local, and refuses key/citation changes even when open.
- [x] B2 Only one file may open it (grep test).
- [x] B3 A sat paper still renders its own text after a rewrite.
- [x] B4 Rollback restores content AND version, reviving the original variant rather than making a third.
- [x] B5 Optimistic concurrency refuses a proposal built against a version that has moved.
- [x] B6 The verification chain refuses: key change, reorder, dropped option, number drift, dropped §, no-gain.
- [x] B7 Distinctness gate compares against a BASELINE (production already has XSE015/XSE016 identical).
- [x] B8 Sign re-render preserves `correctOptionKey` by construction; refuses on any unresolved option.
- [x] B9 **No-gap proven end to end**: never stale, never English. Third test proves the serving path
      is blind to `sourceHash`, so the guarantee comes from the atomic swap, not a downstream check.
- [x] B10 Dry run against production data, reviewed (2026-09-24: signs table read in full, 55 text diffs read pair by pair, 3 refused by hand).
- [x] B11 Text/image applied to production, verified in /en and /bn — **84 of 148** (47 on 09-22 + 37 on 09-24); 58 refused by the gates, 3 by the reviewer, 15 held by translation QA. Residue accepted, DECISIONS 2026-09-24.
- [x] B12 Sign meanings applied, meaning questions re-rendered — **220 of 287 meanings, 285 of 287 questions**; 36 meanings refused as still over budget, 30 kept by the model, 1 held back for a collision. Residue accepted, DECISIONS 2026-09-24.
- [x] B13 Every rewritten item carries fresh bn/es/fr (and ar where servable) rows written in the swap; `pnpm i18n:audit` clean for bn, es, ar, fr.
- [x] B14 Approved pool still 722 (TEXT 136 / IMAGE 12 / SIGN 574); 10 task sets PUBLISHED, 704 members unchanged.

## Out of scope by default
- Recognition sign questions (options already median 3 words). `--include-recognition` opts in.
- The pre-existing registry duplicate XSE015/XSE016 — reported, not fixed here.
- The systemic staleness hole in `loadOverlay` (see DECISIONS 2026-09-21). Deferred to its own spec.
