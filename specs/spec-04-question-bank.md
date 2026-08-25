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

---

## Amendment — 2026-08-24 (approved; see DECISIONS.md · spec-04 · Question sets)

The question bank is also the instrument for judging AI output, so it gains the _set_ as a first-class
object: the group of questions one generation run produced from one image or one topic.

### Added scope

- **`GenerationBatch`** model (kind IMAGE/THEORY/MANUAL, status, source image or topic, requested count,
  provider + model + prompt version, creator) and `MasterItem.batchId`. A set is the unit you review,
  curate and measure.
- **Set detail screen**: the image or topic that produced it, every candidate with its validator report
  and provenance, per-question Keep / Retire, and _Revise with AI_ / _Generate more_ controls rendered
  disabled with an explanatory tooltip until spec-06 makes them live (D4).
- **Accuracy dashboard**: human acceptance rate by model, by prompt version and by topic; ranked
  rejection reasons; trend over time. Aggregated from existing `MasterItem` provenance columns —
  rejected items are RETIRED, never deleted, so the denominator survives.

### Added acceptance checklist

- [ ] Set detail lists exactly the items of that batch grouped by status; Keep/Retire changes that set
      only, and the change is audit-logged.
- [ ] Accuracy figures match an independently computed seeded fixture (per model, per prompt version).
- [ ] Set detail and the accuracy query stay <150ms p95 at 10k items, served by
      `MasterItem_batchId_status_idx` (state the plan in EXPLAIN evidence).

---

## Amendment II — 2026-08-25 (approved; see DECISIONS.md · spec-04b)

A pass mark from this platform is the school's gate before a student may book the official
teoriprøve. That makes a wrong question, or an alterable result, a safety problem rather than a
cosmetic one.

### Superseded

- ~~"Editing approved item creates v+1; old attempts still render old version"~~ — an **APPROVED
  question is now frozen**. Corrections retire it and approve a linked replacement
  (`MasterItem.replacesId`). Old attempts keep rendering their own snapshot either way.

### Added scope

- **Two-person sign-off** (`ItemApproval`): two distinct reviewers for an AI-drafted question, one
  non-author reviewer for a human-written one. Approvals are keyed to the item version, so editing
  a draft voids sign-offs collected for the older text.
- **Deterministic quality gate** before review and before approval: mandatory legal citation,
  exactly one answer among the options, ≥3 options, no duplicate/empty/ungradeable options, both
  locales complete, no unfilled placeholders, no duplicate of an existing question. Warnings
  (e.g. the correct answer being conspicuously longest) are surfaced but do not block.
- **Result attestation**: every submitted attempt is sealed with a sha256 over the record and
  verified by re-computation; the grade is re-derived from the stored answers.
- **Database-enforced immutability**: triggers refuse to change a published question's text or
  answer, to change answers on a closed attempt, to rewrite or delete a submitted result, to edit
  an approved question, or to overwrite an existing seal.
- **Student record**: `/account/history` lists every attempt; each links to the paper exactly as
  it was sat, with the student's answers against the correct ones.

### Added acceptance checklist

- [ ] An AI-drafted question needs two different reviewers; the same reviewer twice does not
      count, and an author cannot approve their own work.
- [ ] Editing an approved question is refused by the service **and** by the database; the
      retire-and-replace path produces a linked replacement with the original left untouched.
- [ ] A question missing a citation, an answer, or with an ungradeable option cannot reach review.
- [ ] A submitted result cannot be altered or deleted, and tampering that bypasses the triggers is
      detected by verification.
- [ ] A student can see every test they have taken and the exact paper, and cannot see anyone
      else's.
