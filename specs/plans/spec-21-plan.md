# Spec-21 — Broken translations: detect, mark, repair (and fix the Bangla ones in production)

> On approval (WORKFLOW.md Phase A): create `specs/spec-21-broken-translations.md`, copy this file to
> `specs/plans/spec-21-plan.md`, add row 21 to `specs/README.md` as 📝 Planned, append the decisions
> to `DECISIONS.md`, branch `spec-21-broken-translations`. Then implement, deploy, and repair
> production.

## Context

A Bangla question in production reads "Tumi aage signal dile tader oboshshoi tomar jonno raastaa
chhere dite hobe" — Bengali words in Latin letters ("Banglish"), not Bengali script. Measured on the
production database: **23 of 722** Bangla question translations carry Latin-script text (18 stems,
19 explanations, 23 with at least one option) plus 1 interface string, all from one
`gemini-3.5-flash-lite` run on 2026-09-09, all flagged only `QA_UNAVAILABLE` (the embedding cap) and
then bulk-approved with consent. Spanish and Arabic have none.

Why the gate let it through (`src/server/services/i18n/validation.ts`):

- The script check is keyed by locale in `SCRIPT_RANGES` (`:70-83`) and **Bengali is not in the
  table**, so for `bn` it never runs. Hindi, Arabic, Russian etc. are; Bengali, Tamil, Punjabi,
  Gujarati, Telugu, Kannada, Malayalam, Sinhala, Nepali/Marathi, Burmese, Khmer, Amharic, Georgian,
  Armenian are not.
- Even where it runs, it passes if **any** character of the whole payload is in the target script
  (`:239-242`) — one Bengali word saves an otherwise romanised question.
- Neither prompt (`src/server/ai/prompts/translation.ts`, `translation.units@1.0.0` rules 1–8 and
  `translation.repair@1.0.0`) tells the model to write in the language's own script.

What already exists and is reused: `checkTranslation` (the deterministic gate), the REPAIR run
(`repair.ts`: re-translates every `NEEDS_REVIEW` unit with the finding stated, re-runs the gate with
`locale`, `storeRepairs` guarded on `NEEDS_REVIEW`+`sourceHash`+`repairAttempts<3`), the card's
"Repair N flagged in background", bulk approve's per-code consent, and the review queue.

## Decisions to log

1. **`SCRIPT_MISMATCH` is a new blocking quality flag, checked per field.** For a locale with a
   known script, every translated text field whose source carries ≥ 4 letters must contain at least
   one character of that script. Latin is still allowed *inside* a field (numbers, units, `§`,
   the bracketed original of an institution name per rule 6). `UNTRANSLATED` keeps only the
   echo case. Not in `NOT_A_QUALITY_FLAG`, so repair re-translates it and bulk approve needs
   explicit consent.
2. **An admin can mark any translation broken** (`ADMIN_FLAGGED` + note), including an APPROVED
   one. It goes to `NEEDS_REVIEW` with a fresh repair budget; the note travels to the model as a
   problem detail. ADMIN only (the developer's requirement); instructors keep review/approve.
3. **"Re-check translations" audits stored rows against the current gate** and can enqueue the
   repair in the same click. A language that was published stays published while it repairs
   (spec-20 D3); a flagged question reads English meanwhile — English beats Banglish.
4. **Both prompts gain a script rule** (`1.1.0`): write every field in the language's own script;
   never romanise. Memory keys do not include the prompt version, so nothing is re-translated by
   the bump alone.

## Files

**New**
- `src/server/services/i18n/audit.ts` — `auditTranslations(db, actor, locale, { apply, repair })`.
- `src/server/services/i18n/audit.integration.test.ts`.
- `src/components/admin/languages/flag-translation-form.tsx` — client form (mark broken).
- `scripts/audit-translations.ts` — `pnpm i18n:audit <code> [--apply] [--repair]`.

**Modified**
- `src/server/services/i18n/validation.ts` — `SCRIPT_RANGES` + names, per-field check,
  `SCRIPT_MISMATCH`; `ADMIN_FLAGGED` documented among the codes.
- `src/server/ai/prompts/translation.ts` — rule 9 in both prompts, `targetScript` var, `1.1.0`.
- `src/server/services/i18n/review.ts` — `flagTranslation`; `translationsAcrossLanguages` returns
  `id` already (nothing to add).
- `src/server/services/i18n/repair.ts` — `repairProblems` unchanged (reads `qaReport.issues`);
  comment on `ADMIN_FLAGGED`.
- `src/server/audit.ts` — `translationFlagged`, `translationAudited`.
- `src/app/[locale]/(admin)/admin/languages/actions.ts` — `auditTranslationsAction` (ADMIN),
  `flagTranslationAction` (ADMIN, revalidates `/admin/questions/[id]` and the language page).
- `src/components/admin/languages/language-board.tsx` — "Re-check translations" button + result
  alert; `question-languages.tsx` — `canFlag` prop, footer row with the form per language;
  `src/app/[locale]/(admin)/admin/questions/[id]/page.tsx` — passes `canFlag={user.role==="ADMIN"}`.
- `translation-review.tsx`, `sample-results.tsx` — `FLAG_KEYS` gain the two codes.
- `src/i18n/messages/{en,nb}.json` — flags, audit and mark-broken strings.
- `package.json` — `i18n:audit`.
- Tests: `translation.test.ts`, `repair.test.ts`, `review.integration.test.ts`,
  `src/server/ai/prompts/*.test.ts` if present, `e2e/languages-board.spec.ts` (one added step).

## Design by task

### Task 1 — Per-field script check (RED: Banglish stem passes today)

`validation.ts`:
```ts
const SCRIPT_RANGES: Record<string, { name: string; test: RegExp }> = {
  bn: { name: "Bengali", test: /[ঀ-৿]/ },  ar/fa/ur Arabic, ru/uk Cyrillic, el Greek,
  he Hebrew, hi/mr/ne Devanagari, pa Gurmukhi, gu Gujarati, ta Tamil, te Telugu, kn Kannada,
  ml Malayalam, si Sinhala, th Thai, my Myanmar, km Khmer, am Ethiopic, ka Georgian, hy Armenian,
  zh Han, ja Kana+Han, ko Hangul
};
export function targetScript(locale): { name; test } | undefined   // also feeds the prompt
```
Check 6 splits: `untouched` → `UNTRANSLATED`; new check `6b` walks the payload **per field** —
`stem`, each `options[i].text` (as `option <key>`), `explanation`, `name`, `description`,
`meaning`, `text` — and for every field whose source counterpart has ≥ 4 letters outside
placeholders and whose translation has no character in the script, records the field name. Any
→ `{ code: "SCRIPT_MISMATCH", blocking: true, detail: "stem, option b, explanation" }`.
`isNonLatinScript` keeps working off the table.

Tests (`translation.test.ts`): Banglish `bn` payload → `SCRIPT_MISMATCH` naming the fields; a
mostly-Bengali payload with one romanised option → flagged with `option c` only; a numeric option
("50 km/h") and a bracketed institution name are never flagged; `es` never flagged; the existing
`ar` case now yields `SCRIPT_MISMATCH` (not `UNTRANSLATED`).

### Task 2 — Prompts say it (RED: prompt text lacks the rule)

`translation.ts` prompts: rule 9 — "Write every field in {targetScript} script. Never romanise or
transliterate the translation into Latin letters; Latin appears only in numbers, units, legal
references and the bracketed original of a name." `targetScript` var from `targetScript(locale)`
("Bengali"); for Latin-script languages the line reads "Write in the language's own orthography."
Version `1.1.0` on both. `translateBatch`/`repairBatch` pass the var. A prompt unit test asserts
the rule and the version.

### Task 3 — Mark broken (RED: `flagTranslation` missing)

`review.ts`:
```ts
export const flagTranslationInputSchema = z.object({ id, note: z.string().min(3).max(500), repair: z.boolean().default(true) }).strict();
export async function flagTranslation(db, actor, rawInput)
```
ADMIN only (service throws `ForbiddenError` otherwise — the action also `requireUser("ADMIN")`).
Writes: `status: NEEDS_REVIEW`, `qaFlags: uniq([...quality flags kept, "ADMIN_FLAGGED"])`
(infra flags dropped), `qaReport: { ...existing, issues: [...existing issues, { code: "ADMIN_FLAGGED", blocking: true, detail: note }], source: "admin" }`,
`reviewNote: note`, `reviewedById/At`, `repairAttempts: 0`. Invalidates messages + taxonomy for
the locale. Audit `translationFlagged`. When `repair` and no live run: `startBackgroundRun(kind: "REPAIR")`
(swallow `ConflictError` → reported as "queued behind the running run"). Returns
`{ id, locale, repairQueued }`.

UI: `question-languages.tsx` gets `canFlag: boolean`; when true, a last table row renders
`<FlagTranslationForm translationId locale />` per language column — note input (required),
"Repair with AI now" checkbox (default on), submit "Mark broken". Success alert names the language
and whether a repair was queued. Keyboard-reachable, 44 px, both catalogues. The review page's flag
sentence for `ADMIN_FLAGGED` reads "Marked broken by an admin" and the row shows the note (it
already renders `reviewNote`? — verify; if not, render it beside the flags).

Tests: `review.integration.test.ts` — an APPROVED row marked broken becomes `NEEDS_REVIEW` with
`ADMIN_FLAGGED` + note in `qaReport.issues` + `repairAttempts 0`; an INSTRUCTOR is refused; it is a
`repairCandidates` member; `repair.test.ts` — `repairProblems` surfaces the note as detail.

### Task 4 — Audit: re-check everything stored (RED: `auditTranslations` missing)

`audit.ts`: `extractAll` → map by `entity:entityId`; rows of the locale with
`status in (APPROVED, MACHINE, NEEDS_REVIEW)` and `entity != ITEM_VARIANT` and a **fresh**
`sourceHash` (stale rows belong to SYNC) → `checkTranslation` with the unit's `en`,
`correctOptionKey` → blocking issues → `{ id, entity, entityId, codes, detail }`. Dry run returns
`{ checked, flagged, byCode, examples[≤10] }` and writes nothing. `apply`: `updateMany`-per-row
to `NEEDS_REVIEW`, `qaFlags = allCodes(check)` ∪ kept semantic quality flags, `qaReport =
{ ...existing, source: "audit", issues: check.issues }`, `repairAttempts: 0`, review provenance
cleared; caches invalidated; audit `translationAudited { checked, flagged, byCode }`.
`repair`: enqueue a REPAIR run when flagged > 0 and none live. Cost: one extraction (~700 KB) and
one locale scan; no AI call.

Card: "Re-check translations" (ADMIN; disabled while a run is live) → `auditTranslationsAction`
→ alert "{flagged} of {checked} held after re-check · SCRIPT_MISMATCH 23 · … · repair queued".
CLI mirrors it: `pnpm i18n:audit bn` (dry), `--apply`, `--repair`.

Tests: `audit.integration.test.ts` — seeded APPROVED Banglish `bn` rows are flagged with
`SCRIPT_MISMATCH` and a clean Bengali row is not; dry run writes nothing; apply flips status and
resets the budget; stale rows are skipped; `repair: true` enqueues one REPAIR run.

### Task 5 — Messages, flag lists, board

`FLAG_KEYS` in both components; `admin.languages.flags.SCRIPT_MISMATCH` = "Not written in the
language's own script", `.ADMIN_FLAGGED` = "Marked broken by an admin"; `audit.button/pending/
result/queued`, `markBroken.*`, `errors.adminOnly`; Norwegian for each. `messages.test.ts` parity.

### Task 6 — Verify, deploy, repair production

1. Gate: `pnpm test`, `tsc`, `eslint`, `pnpm build`, e2e (board spec gains: open a question page as
   the admin, mark one language broken, see it in the review queue with the note).
2. Deploy as this afternoon: bundle → VPS (`git fetch` + ff, install, generate, no migration,
   build, `pm2 restart` both). Back up the database first (no schema change, but rows will move).
3. Production remediation, in order:
   - `pnpm i18n:audit bn` → expect ≈ 24 rows, `SCRIPT_MISMATCH`; `pnpm i18n:audit es`, `ar` → 0.
   - `pnpm i18n:audit bn --apply --repair` → rows `NEEDS_REVIEW`, one REPAIR run enqueued; the
     worker (online) repairs 24 units at temperature 0 with "SCRIPT_MISMATCH: stem, option b, …"
     stated; each result passes the new gate or stays held.
   - Verify with the same SQL scan (0 rows without Bengali script), then open two repaired
     questions in `/bn` as a student.
   - Anything still held after 3 attempts appears in the Bangla review queue for a human.

## Acceptance checklist (spec-21)

- [ ] A romanised Bengali question is refused by the gate with `SCRIPT_MISMATCH` naming the
      fields; a numeric option and a bracketed Latin name are not flagged; Spanish is untouched.
- [ ] Both prompts state the script rule at version 1.1.0.
- [ ] An admin can mark an APPROVED translation broken with a note; it leaves the servable set at
      once, the note reaches the repair prompt, a repair is queued; an instructor cannot.
- [ ] "Re-check translations" flags every stored row the current gate refuses, writes nothing on a
      dry run, and queues a repair on apply.
- [ ] A repaired unit returns to `MACHINE` and is served; one that fails three times reaches the
      review queue.
- [ ] Both languages, 390 px, keyboard on the new form and button.
- [ ] Production: 0 Bangla rows without Bengali script after the repair run; two repaired
      questions read correctly in `/bn`.
- [ ] `pnpm test`, `tsc`, `eslint`, `pnpm build`, e2e clean.

## Risks

- A repair can come back romanised again; the gate now holds it and the budget stops at three —
  then it is a human's, in the review queue.
- Each script-flagged unit forces a semantic QA call (`translate.ts:251`), so the repair run
  spends ~24 embedding calls — well under the daily cap.
- Rule 6 (Latin original in brackets) means a field can legitimately contain Latin; the check
  requires presence of the target script, not absence of Latin, on purpose.
