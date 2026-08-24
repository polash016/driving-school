# Spec 04 — Question Bank CRUD & Review Workflow

## Objective
Admin/instructor manage the item lifecycle: DRAFT → IN_REVIEW → APPROVED → RETIRED.

## In scope
- Admin question-bank browser: server-paginated table, filters (topic, status, type, difficulty, language completeness), search, bulk actions (approve, retire, re-tag).
- Item editor: bilingual side-by-side editing (EN/NB), options editor enforcing exactly-one-correct, legal citation picker (from KB refs), difficulty, topic, preview exactly as student sees it (both languages, light/dark).
- Review queue UI: split view, keyboard shortcuts (A approve, E edit, R reject with reason), rejection reasons stored.
- Versioning: editing an APPROVED item creates a new version; attempts keep pointing at the version they served.
- Import/export JSON + CSV.

## Acceptance checklist
- [ ] Lifecycle transitions enforced server-side (invalid transitions rejected + tested).
- [ ] Editing approved item creates v+1; old attempts still render old version.
- [ ] Table stays <150ms p95 at 10k seeded items (measure with seeded data).
- [ ] Keyboard-only review of 10 items possible without touching mouse.
