# Plan — Spec 06: Image Quiz AI Pipeline (detailed, authored by Fable for Opus)

## Decisions (binding)

- Queues: BullMQ `ai-vision` and `ai-generation` (architecture §6). Worker entry `src/server/queues/worker.ts` (separate process: `pnpm worker` script, own container in spec-14). Job ids deterministic: `vision:<imageId>:<promptVersion>`, `gen:<imageId>:<promptVersion>` — re-runs are idempotent upserts.
- Storage: local `storage/` dir behind a `FileStore` interface (put/get/signedUrl) so spec-14 can swap S3-compatible; `ImageAsset.storagePath` relative, `url` is the serving route (`/api/images/[id]` — signed short-TTL in spec-12, plain auth-gated now).
- Upload pre-processing (in the upload server action, NOT the worker): `sharp` — strip EXIF/GPS (re-encode), max dimension 2048, perceptual hash (`sharp`-based dHash implementation, hex string) → dedupe warning if an ImageAsset with same hash exists (list them in the response).
- Face/plate blur: `@vladmandic/human` or OpenCV bindings are heavy — v1 decision: blur job uses the SAME vision model call (context sheet asks for face/plate bboxes) + sharp region blur; `blurApplied` set true only after admin confirms the sheet. Low-confidence → NEEDS_HUMAN_ID and image is NOT used for generation until confirmed.
- Vision call: `aiJson({ task: "vision", prompt: visionContextSheetPrompt, schema: contextSheetSchema, userContent: [image_url] })` — schema-validated by the gateway (already built). Sign codes cross-checked against the Sign registry: unknown/low-confidence (<0.5) → `ImageStatus.NEEDS_HUMAN_ID`, never silent guessing.
- Admin corrections stored on `ImageAsset.aiContextSheet` (corrected版) + a `contextSheetCorrections` few-shot store: new table NOT needed — store correction pairs in `AuditLog.meta` AND a JSON file cache? NO — decision: add `ImageCorrectionExample` later if few-shot proves valuable; v1 logs corrections to AuditLog and uses the corrected sheet only.
- Generation job: N=5 candidates via `questionGenerationPrompt` grounded in corrected sheet + `kb.search` retrieval (top 6 chunks); each candidate MUST include ≥1 citation to a retrieved chunk (validator rejects otherwise).
- Validator chain (pure module `src/server/services/pipeline/validators.ts`, unit-tested): 1) contract schema parse; 2) citation-support judge (`aiJson` task `validation`, `citationSupportJudgePrompt`); 3) exactly-one-correct + distractor distinctness (reuse template-engine checks); 4) similarity vs pool (embedding cosine vs existing variants of same topic > 0.93 → reject); 5) length/style lints. Output = `validatorReportSchema`; failures auto-reject with reasons persisted.
- Survivors → `MasterItem` rows (status IN_REVIEW, `createdBy: AI`, modelVersion+promptVersion, sourceImageId) + initial `ItemVariant` → spec-04 review queue.
- Cost guard: `registerCostGuard` (gateway hook, already built) → increments `tp:ai:spend:<date>` (estimate: tokens × configured price); when > `schoolConfig.ai.dailyBudgetUsd` → pause both queues (`queue.pause()`) + admin banner via Settings row; resume manually or at midnight cron.

## Files

`src/server/queues/{connection.ts,worker.ts,queues.ts}`; `src/server/services/pipeline/{upload.ts,vision-job.ts,generation-job.ts,validators.ts,file-store.ts,phash.ts}`; admin UI `(admin)/images/*` (upload dropzone with progress, image board by status, context-sheet editor with detection chips over the image, retry button); contracts already in `contracts/image-pipeline.ts`.

## Acceptance → tests

- E2E (mock gateway): upload fixture image → vision job (mocked `aiJson` returning fixture sheet) → ≥3 validated candidates in review queue. Mock at the `aiJson` boundary — tests never hit a live model.
- Same image twice → dedupe warning (unit on phash + integration).
- EXIF verifiably stripped: fixture with GPS EXIF → stored file re-read with sharp metadata → no GPS (unit).
- Worker killed mid-job → BullMQ retry, no orphan `ImageStatus` (stalled-job handling test: job marked ANALYZING re-enters queue; idempotent upsert proves no duplicates).

## Pitfalls

- Every artifact writes modelVersion + promptVersion (gateway returns them — persist!).
- Never enqueue generation for an image whose sheet isn't human-confirmed (`contextVerifiedAt`).
- Upload route must enforce batch ≤50 and content-type sniffing (not extension).
