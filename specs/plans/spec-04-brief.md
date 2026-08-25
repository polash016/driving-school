# Brief — Spec 04: Question Bank CRUD & Review (Opus expands to a full plan)

**Import, don't reinvent:** `contracts/question-bank.ts` (list filters, upsert with exactly-one-correct superRefine, transitions, bulk actions), `contracts/models.ts` shapes, `authorize("INSTRUCTOR")`, error taxonomy.

**Key decisions already made**

- Lifecycle legality lives in ONE service function `transitionItem()` with an explicit allowed-transitions map (DRAFT→IN_REVIEW→APPROVED→RETIRED; NEEDS_REVIEW→IN_REVIEW; APPROVED→NEEDS_REVIEW is system-only via spec-05). Invalid transition → `ConflictError`. Rejection requires `reason` (stored in `reviewNote`).
- Versioning: editing an APPROVED item bumps `version` and RETIRES existing variants? NO — variants stay active until regenerated; they record `masterVersion`, attempts keep rendering their variant snapshot (already immutable). New variants generate from the new version.
- Server-paginated table via `paginationInputSchema`; `MasterItem_status_createdAt_idx` + `topicId_status_type_idx` serve the filters — state which in the plan.
- Review queue split view with keyboard shortcuts (A approve / E edit / R reject) — desktop-first (admin panel), still fully keyboard-accessible.
- Preview must render EXACTLY as the student sees it: reuse the spec-08 question components inside a 390px frame, both locales, light+dark.

**Pitfalls:** import/export must round-trip bilingual content + citations losslessly; bulk approve must re-run the exactly-one-correct validation per item; keep p95 <150ms at 10k items (measure with the spec-02 volume script pattern).

**Done =** acceptance checklist of spec-04 all PASS with evidence in `specs/notes/spec-04-notes.md`.
