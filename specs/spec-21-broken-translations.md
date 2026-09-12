# Spec 21 — Broken translations: detect, mark, repair

## Objective

No translation reaches a student in the wrong script, an admin can declare any translation broken
and have the AI redo it, and every translation already stored can be re-checked against the current
gate. The Bangla rows that shipped as romanised "Banglish" are repaired in production.

## Why this is needed

A Bangla question in production read "Tumi aage signal dile tader oboshshoi tomar jonno raastaa
chhere dite hobe" — Bengali words in Latin letters. Measured on the production database: 23 of 722
Bangla question translations and one interface string carry Latin-script text, all from one model
run on 2026-09-09, flagged only `QA_UNAVAILABLE` and then bulk-approved with consent.

The gate let it through for two reasons (`validation.ts`): the script check is keyed by a short
locale table that does not contain Bengali, so for `bn` it never ran; and where it runs it passes
if any character of the whole payload is in the target script. Neither prompt asks the model to
write in the language's own script.

## In scope

- **A per-field script check.** `SCRIPT_MISMATCH`, blocking, a quality flag: every translated
  field whose source has letters must contain the target script. Bengali and the other major
  non-Latin scripts join the table.
- **Both prompts say it.** A ninth hard rule in the translation and repair prompts, version 1.1.0.
- **Mark broken (admin only).** Any translation, approved or not, can be flagged `ADMIN_FLAGGED`
  with a note; it stops being served at once, the note reaches the repair prompt, and a repair run
  is queued.
- **Re-check translations.** An audit that runs the gate over every stored row of a language,
  reports what it would flag, and on apply flags it and queues the repair. Also a CLI.
- **Production remediation** of the Bangla rows, verified by query and by reading two of them.

## Out of scope

- Any change to the semantic QA (back-translation, embeddings) or its thresholds.
- Detecting wrong *language* within the right script (Hindi in Devanagari for a Marathi request).
- Bulk-approve semantics; the new codes are quality flags and need explicit consent as before.

## Acceptance checklist

- [ ] A romanised Bengali question is refused by the gate with `SCRIPT_MISMATCH` naming the fields;
      a numeric option and a bracketed Latin name are not flagged; Spanish is untouched.
- [ ] Both prompts state the script rule at version 1.1.0.
- [ ] An admin can mark an APPROVED translation broken with a note; it leaves the servable set at
      once, the note reaches the repair prompt, a repair is queued; an instructor cannot.
- [ ] "Re-check translations" flags every stored row the current gate refuses, writes nothing on a
      dry run, and queues a repair on apply.
- [ ] A repaired unit returns to `MACHINE` and is served; one that fails three times reaches the
      review queue.
- [ ] Both languages, 390 px, keyboard paths on the new form and button.
- [ ] Production: 0 Bangla rows without Bengali script after the repair run; two repaired questions
      read correctly in `/bn`.
- [ ] `pnpm test`, `tsc`, `eslint`, `pnpm build`, e2e clean.

## Notes

Plan: [plans/spec-21-plan.md](plans/spec-21-plan.md) · Evidence: [notes/spec-21-notes.md](notes/spec-21-notes.md)
· Decisions: `DECISIONS.md` (2026-09-12).
