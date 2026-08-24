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
