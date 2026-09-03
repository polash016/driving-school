# Spec 17 — AI Variant Generator (alternate phrasings of an approved question)

> Approved 2026-09-03 alongside **spec-16**. Depends on 04 (question bank + publish), 05 (AI
> gateway + provider registry), 07 (quiz engine). Sequenced **after** spec-16 — task sets are
> leak-proof without it, and gain from it with no rework.

## Objective

Give one approved question several **active `ItemVariant` rows** that ask the same legal point in
different words, so two students meeting the same concept do not meet the same sentence.

## Why this exists

`ItemVariant` and `VariantSource.AI_VARIATION` have existed in the schema since spec-02, and
nothing has ever written one. `publish.ts` creates exactly one `TEMPLATE` variant per master item.
So today, "different version of the same question" can only come from *which* questions are drawn
(spec-16's pool slice) or from shuffled option order — never from different wording.

Spec-16 is deliberately built so that this spec is an upgrade, not a prerequisite: when variants
start existing, assembly picks among them automatically and every task set gets harder to memorise
without a line of engine code changing.

## The risk this spec must manage

**A reworded distractor can accidentally become correct.** This is the failure mode that matters:
it produces a question that marks a right answer wrong, in an exam a student is paying to pass.
Every design decision below is downstream of that risk.

Consequences:
- A variant is **never** auto-activated. `isActive = false` until a human approves it.
- The correct answer's *meaning* is fixed. The generator may reword it; it may not change which
  proposition is true.
- Every variant passes the existing validation gate (`src/server/services/pipeline/validators.ts`)
  plus a new **answer-equivalence check**, before a human ever sees it.

## In scope

### Service

`src/server/services/generation/variation.ts`

```
generateVariants(masterItemId, { count, locale }) →
  1. load APPROVED master item + its legal citations + its correct option
  2. AI call via src/server/ai/client.ts  (task: GENERATION, model from AiRoute — never inline)
  3. per candidate:
       a. schema parse (Zod, strict)
       b. answer-equivalence check: an independent AI call is asked which option is
          correct, given ONLY the variant text. Disagreement with the master's answer
          → rejected, logged as a GenerationRejection with reason WRONG_ANSWER.
       c. existing quality gate: distractor plausibility, ambiguity, language quality
       d. stem-embedding similarity against the master: too close (paraphrase-in-name-only)
          or too far (different question) → rejected
  4. write surviving candidates as ItemVariant rows:
       source = AI_VARIATION, isActive = FALSE, masterVersion = master.version
```

`contentHash` uniqueness already dedupes an identical re-generation. Rejections are written to
`GenerationRejection` so the next run is shown what it got wrong — the loop spec-05 established.

### Version coupling

A variant snapshots `masterVersion`. Editing an approved master item already supersedes its
variants (DECISIONS 2026-08-25) — AI variants inherit that rule with no new machinery. A variant
never outlives the text it was rendered from.

### Admin

- `/admin/questions/[id]` gains a **Variants** panel: existing variants, their source, active
  state, and a **Generate alternates** action.
- A review queue at `/admin/questions/variants` lists inactive AI variants oldest-first, showing
  the variant beside its master so a reviewer compares wording and answer directly.
- Activation is a deliberate per-variant action, audited in `AuditLog`.
- Batch generation over a topic or a task-set slice, reusing the `GenerationBatch` board.

### Engine

**No change.** `PrismaVariantSource` already serves active variants of approved masters, and
assembly already treats variants of one master as the same concept (at most one per paper). More
active variants simply widen the pool it picks from.

### i18n

Variants are generated per locale from the master's bilingual content. A variant is only activated
when every configured language has a reviewed rendering — a student switching language mid-exam
(spec-08) must not fall off a variant that exists in one language only. Spec-15's translation
pipeline handles languages added later.

## Out of scope

- Parameter-slot expansion (`MasterItem.parameterSlots`) — deterministic, already specified in 07.
- Rewriting the master item itself. This spec only adds alternate renderings.
- Image-valued options.

## Acceptance checklist

- [ ] A generated variant whose correct answer differs from its master is rejected before reaching
      review. Evidence: unit test with a deliberately answer-shifted fixture.
- [ ] No variant is ever written with `isActive = true`. Evidence: grep + unit test.
- [ ] Activating a variant requires a human action and writes an `AuditLog` row. Evidence:
      integration test.
- [ ] Editing the master deactivates its AI variants. Evidence: integration test.
- [ ] A variant is only activatable when all configured locales have a reviewed rendering.
      Evidence: unit test.
- [ ] With ≥2 active variants on a master, two attempts drawing that master receive different
      variant ids across a sample. Evidence: integration test over the assembly seed.
- [ ] Model and prompt version are recorded on every variant; no model name appears inline in the
      diff. Evidence: grep.
- [ ] Rejections are written with a structured `RejectionReason` and surface in the next run's
      few-shot context. Evidence: integration test.
