# Spec 06 — Image Quiz AI Pipeline (Vision → Questions → Review)

## Objective

Admin uploads traffic images; AI extracts context and drafts questions; humans approve.

## Pipeline (BullMQ jobs, all via src/server/ai)

1. Upload (batch ≤50, drag-drop, progress): store original → strip EXIF/GPS → auto-blur faces & plates → perceptual hash dedupe check.
2. Vision analysis job: multimodal call producing structured context sheet JSON {signs:[{signCode, confidence}], roadMarkings, actors, conditions, situationSummary, applicableRules[] with KB citations}. Sign codes cross-checked against sign registry; low-confidence or unknown → flag NEEDS_HUMAN_ID, never guess silently.
3. Admin corrects context sheet (editable detection chips over image); corrections stored as few-shot examples for future prompts.
4. Generation job: N candidate MasterItems (default 5) grounded in context sheet + KB retrieval; each must include ≥1 KB citation; runs validator chain (schema, citation-support judge pass, distractor ambiguity, similarity vs existing pool, length/style) — failures auto-rejected with reason.
5. Survivors land in the Spec-04 review queue tagged with sourceImageId.

## Requirements

- Every artifact logs modelVersion + promptVersion. Prompts live in versioned files `src/server/ai/prompts/`, not inline.
- Job status UI per image (queued → analyzing → generating → in review) with retry.
- Cost guard: per-day generation budget from config; queue pauses at limit.

## Acceptance checklist

- [ ] E2E: upload test image → context sheet with correct sign codes → ≥3 validated candidates in review queue.
- [ ] Uploading same image twice → dedupe warning. GPS EXIF verifiably stripped.
- [ ] Kill the worker mid-job → job retries safely, no orphan states.

---

## Amendment — 2026-08-24 (approved; see DECISIONS.md · spec-06 · Storage, AI images, AI revision)

### Added scope

**1. Storage driver port (D3).** `src/server/storage/{index.ts,local.ts,s3.ts}` exposing
`put/get/stream/delete/exists`; driver chosen by config — `local` (a configured VPS directory outside the
repo) by default, `s3` (any S3-compatible endpoint: AWS, Hetzner, Backblaze, MinIO) opt-in. Keys
namespaced `images/{yyyy}/{mm}/{id}.{ext}`. Bytes are **never** served from a public URL: a route
`/api/images/[id]` behind `requireUser()` streams them, so spec-12 can add signed short-TTL URLs and
per-student watermarks without touching the pipeline.

**2. No-upload path — composite images (D1).** Admin picks a topic and situation; the AI generates only a
**sign-free background scene**; the pipeline composites official skiltforskriften SVGs from the spec-05
sign registry onto it at chosen positions (`sharp`). Diffusion models render Norwegian signs
inaccurately, and a wrong sign makes the question legally wrong — compositing means the sign codes are
_known_, so the context sheet is ground truth rather than a guess. The composed image requires human
approval before any question generated from it can leave DRAFT.

**3. AI revision loop.** `AiRevision` (itemId, instruction, before/after JSON, model + prompt version,
accepted). In the spec-04 set view: type an instruction ("distractor B is ambiguous") → the AI returns a
revised item → **diff view** → Accept creates v+1, Reject is logged and changes nothing. Accepted
revisions are stored as few-shot examples for later generation runs.

**4. Generate more into an existing set** — N further candidates from the same image or topic, deduped
against the existing pool by embedding similarity before they reach review.

### Added acceptance checklist

- [ ] The same e2e pipeline passes twice with only config changed: `driver=local` and `driver=s3`
      (MinIO locally).
- [ ] Exam images are not publicly reachable: requesting the raw storage path returns 404/403, and
      `/api/images/[id]` without a session returns 401.
- [ ] A composite image carries exactly the sign codes requested — asserted by construction and
      re-verified by a vision read-back; mismatch fails the job.
- [ ] Revise loop: instruction → diff → accept produces v+1 while attempts already served keep rendering
      their original variant; reject leaves the item byte-identical and writes an audit row.
