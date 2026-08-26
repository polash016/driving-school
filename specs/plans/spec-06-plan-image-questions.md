# Mode 2 — AI questions from an uploaded image, made as accurate as the stack allows

## Context

You asked whether there is a solid way to generate quiz questions from an image, across three
modes: (1) human image + human question, (2) human image + AI question, (3) AI image + AI question.
Mode 1 already works — the image picker landed this session. This plan builds **mode 2**; mode 3
(right-of-way diagrams) follows as its own piece.

### What I measured, and why it decides the design

I probed your configured vision model on registry signs — the **easiest possible case**: clean,
isolated, high-resolution graphics on white, no angle, no weather, no occlusion.

| Approach | Result |
|---|---|
| Open recall — "name this sign" | **2 / 7** usable |
| Closed vocabulary — "choose one of these 287 registry names" | **6 / 7** |
| Self-reported confidence on the one miss | **0.95 — confidently wrong** |

Three conclusions, and they are the whole architecture:

1. **Free-text sign naming is unusable for grounding.** The model says "Sheep crossing" where the
   registry says "Sheep" — not wrong, but it will not join to a row, so it cannot key a citation.
2. **Closed vocabulary is a large, nearly free win.** Every identification step is a choice from
   the registry, never a description.
3. **Confidence cannot be a gate.** A 0.95 on a wrong supplementary sign is exactly the failure
   that ships a legally wrong question. Agreement across samples replaces it.

A real roadside photograph will be worse than this. So the governing rule is: **the AI may write
prose; it may not be the source of facts.**

### The blocker nobody has hit yet

`KbSource` holds **only `trafikkreglene`, §1–§21. `skiltforskriften` is absent entirely.**

- [theory.ts:119](src/server/services/generation/theory.ts#L119) refuses to generate without enough
  retrieved rule text — "No excerpts, no generation". An image question about signs has almost
  nothing correct to cite, so mode 2 would fail or cite loosely on day one.
- It also affects what shipped this session: the 574 sign questions cite `skiltforskriften § 5` and
  similar. Those sections are substantively right, and the quality gate only checks a citation is
  *present and well-formed* — it never verifies the source exists. So they are correct but not
  resolvable to any KB text. Ingesting the regulation fixes that too.

**Grounding is the accuracy ceiling. The model is not the limiting factor — the knowledge base is.**

### Decision taken

You chose that the admin **may skip** the context-sheet confirmation and generate directly. I said
I thought confirmation should be mandatory; that is your call and this plan builds it skippable.
What I will not do is let the skip path be silently weaker, so on that route:

- sample-agreement and crop-discrimination still run (they cost you nothing — no clicks),
- the blind answer-check is always on,
- and the batch is stamped `factsVerified: false`, which the review queue shows plainly, because a
  reviewer on that path is checking **facts as well as wording** and deserves to know it.

---

## The accuracy stack, ranked by what it actually buys

1. **Blind answer-check** (new). A second pass answers the drafted question seeing only the context
   sheet and the cited rule — never the key, never the explanation. Disagreement rejects. This
   catches a wrong answer key, which is the worst failure mode and the one no other check finds.
2. **Confirmed context sheet** (skippable, per your decision). One screen per image turns perception
   into ground truth that every question from that image inherits.
3. **Closed vocabulary + crop-and-discriminate.** First pass picks from the registry; then each
   detection's bbox is cropped and re-checked against 5 sign images **from the same class**, with
   "none of these" allowed. The one miss in my probe was a within-class confusion, which is exactly
   what this catches and what a name list does not.
4. **Agreement over confidence.** Detection runs 3×, candidate order shuffled to break positional
   bias; a sign survives only if it appears in ≥2 runs. Anything else → `NEEDS_HUMAN_ID`.
5. **Cite-or-die.** Questions are drafted only from KB text retrieved by the *confirmed* sign codes
   and scene facts — never from the model's memory of Norwegian law.

Everything below 1–5 already exists and is reused, not rebuilt: the deterministic quality gate,
embedding dedupe in-batch and against the pool, the rejection ledger fed back as few-shot lessons,
`GenerationBatch`, and the two-person review.

---

## Work

### Phase A — Knowledge base (unblocks everything)

`pnpm kb:ingest skiltforskriften <lovdata-url> --name "Skiltforskriften" --kind REGULATION`, using
the existing [kb-ingest.ts](scripts/kb-ingest.ts). Norwegian regulations are not copyrighted
(åndsverkloven § 14), which that script already documents. Verify §-level chunking covers the sign
classes the registry cites, and re-check `trafikkreglene` for gaps.

`search()` gains an optional `sourceCodes` filter in
[contracts/kb.ts](src/server/contracts/kb.ts) so sign questions can be steered at the sign
regulation rather than competing with general traffic rules.

### Phase B — Vision → context sheet

`src/server/services/pipeline/vision.ts`, filling the `contextSheetSchema` that already exists in
[image-pipeline.ts](src/server/contracts/image-pipeline.ts) with **zero call sites** today.

- **Closed vocabulary**: the prompt carries `code · name` for every active registry sign; the model
  must return codes, and any code not in the registry is dropped, not repaired.
- **3× agreement** with shuffled candidate order; survivors need ≥2 of 3. `confidence` is recorded
  for the admin's information and used for **nothing**.
- **Crop-and-discriminate**: `sharp.extract()` on each surviving bbox, then a second call showing
  the crop beside 5 same-class sign images plus an explicit "none of these" option.
- Non-sign facts (road markings, actors, lighting, weather, road type, situation summary) come from
  the same call — they carry no legal weight on their own and are the admin's to correct.
- Unresolved or disagreeing detections set `ImageStatus.NEEDS_HUMAN_ID`; the sheet is stored on
  `ImageAsset.aiContextSheet`.
- New versioned prompts in `src/server/ai/prompts/vision.ts`. `visionContextSheetPrompt` already
  exists and is unused — it is rewritten for the closed-vocabulary contract.

**No BullMQ.** Spec-06's plan assumed a queue; this stack has none (spec-15's translation runner
made the same call). Extraction runs in the server action with a progress row on `ImageAsset.status`,
which is what the existing `ImageAsset_status_createdAt_idx` was built to serve.

### Phase C — Context sheet review (skippable)

`/admin/images/[id]` gains the sheet: detection chips positioned over the picture from their bboxes,
each removable and each replaceable from a registry picker; free-text scene facts editable.

- **Confirm** sets `contextVerifiedAt` and stores the corrected sheet.
- **Generate without confirming** is offered beside it and is not discouraged in copy — it is a
  supported path, stamped `factsVerified: false`.

### Phase D — Question generation

`src/server/services/generation/image.ts`, a close sibling of
[theory.ts](src/server/services/generation/theory.ts) — same shape, different grounding:

| Reused as-is | New |
|---|---|
| `GenerationBatch` lifecycle, `recordRejection`, `buildRejectionLessons` | grounding is the context sheet, not a topic name |
| `embedStems`, `cosine`, `classifyAgainstPool`, `storeStemEmbedding` | KB retrieval keyed on confirmed sign codes + situation summary |
| `checkItemQuality` — the model gets no easier standard | items are `type: "IMAGE"` with `sourceImageId` set |
| difficulty spread, `avoidStems` | `GenerationBatch.factsVerified` snapshot |

Migration `add_batch_facts_verified`: `GenerationBatch.factsVerified Boolean @default(false)`.
**No new index** — the set board is served by the existing `GenerationBatch_status_createdAt_idx`
and this is a flag read on a row already being fetched.

### Phase E — Blind answer-check and the validator chain

`src/server/services/pipeline/validators.ts`:

- **`verifyAnswerBlind`** — the centrepiece. Given the context sheet, the cited KB chunk, the stem
  and the options *with keys stripped and order re-shuffled*, a fresh call answers the question and
  quotes the sentence supporting it. Mismatch with the claimed key → reject `WRONG_ANSWER`.
  Runs on a second provider when one is configured; today only Gemini is, so it runs as an
  independent call on the same model — worth stating plainly, since a same-model check is a weaker
  check, and adding a second provider in `/admin/ai` strengthens it at no code cost.
- **`checkDistractorDistinctness`** — embeds the options and rejects near-identical pairs, which is
  what makes a question ungradeable rather than merely poor.
- `validatorReportSchema` gains `answerVerified: boolean` and `answerVerifierModel: string`.
  Contract-only; the field already flows to `ItemVariant.validatorReport`.

Every rejection goes to the existing `GenerationRejection` ledger, so it returns as a few-shot
lesson in the next run — the loop is already built.

### Phase F — The review queue must show the image

`ReviewItem` in [review-queue.tsx](src/components/admin/questions/review-queue.tsx) has **no image
field**, so a reviewer approving an image question cannot see the picture. That makes review of
exactly these questions meaningless, and it blocks the two-person sign-off from being worth
anything. Add `imageUrl` + the context sheet summary, and show `factsVerified: false` as a banner
telling the reviewer they are also checking the facts.

### Phase G — Admin wiring

`/admin/images/[id]` gains "Generate questions" (count, license class); the run creates a
`GenerationBatch` and lands survivors in the existing review queue, reachable from
[set-detail.tsx](src/components/admin/questions/set-detail.tsx), which already renders batches.
i18n for both locales throughout; no new user-facing string outside next-intl.

### Tests

- **Unit** — closed-vocabulary parsing drops unknown codes; 3× agreement keeps ≥2-of-3 and rejects
  1-of-3; crop geometry from normalised bbox; `verifyAnswerBlind` rejects a deliberately mis-keyed
  question and passes a correct one (both against a stubbed gateway, no live calls); distractor
  distinctness catches paraphrases.
- **Integration** — a seeded image + fixture context sheet generates candidates, and a mis-keyed
  candidate is rejected and appears in `GenerationRejection`.
- **e2e** — upload → extract → skip confirmation → generate → the item appears in review **with its
  image** and a `factsVerified: false` banner → two reviewers approve → a student is served it.
- **a11y** — axe on the context-sheet editor; detection chips reachable by keyboard.

---

## Mode 3, for later (not this build)

Right-of-way junction diagrams: a `Scene` (junction shape, per-leg vehicle and intent, priority
signs from the registry) → a **pure rule resolver** deriving who goes first from trafikkreglene § 7
and the priority signs → deterministic SVG rendered with `sharp` into a normal `ImageAsset`. The
answer is *computed*, so it cannot be hallucinated; the AI only phrases the question. Needs no image
model, which is just as well — there is no image-generation path today: `aiJson`/`aiEmbed` are the
only gateway functions, your `IMAGE` route points at a text model, and the Google adapter parses
only `text` parts, so image output would be silently dropped.

---

## Verification

```bash
pnpm kb:ingest skiltforskriften <url> --name "Skiltforskriften" --kind REGULATION
pnpm exec prisma migrate dev && pnpm test && pnpm e2e
```

Then in the running app:

1. `/admin/images` → upload a Norwegian traffic photo → detections appear as chips on the picture.
2. Correct one chip, confirm the sheet, generate 5 → candidates cite `skiltforskriften` sections
   that exist in the KB.
3. Repeat on a second image **skipping** confirmation → items carry the `factsVerified: false`
   banner in review.
4. Hand-edit one candidate's `correctOptionKey` to a wrong option and re-run the validator →
   rejected as `WRONG_ANSWER`, with a row in `GenerationRejection`.
5. Approve with two reviewers → the question reaches a student, image and all.

**Accuracy is measured, not asserted.** After the first real batch, `/admin/questions/accuracy`
already reports human acceptance rate by model and prompt version with ranked rejection reasons —
that dashboard is the honest read on whether mode 2 is good enough, and it exists today.
