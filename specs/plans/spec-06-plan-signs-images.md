# Sign Test + Image Quiz — vertical slice from `traffic_rules/`

## Context

**The complaint is accurate.** The student homepage shows one section, not three, and the admin
panel has no way to put an image on a question. Verified against the running database and the code:

| Layer                                                                    | State today                                                                                                                               |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `Sign` table                                                             | **0 rows.** `public/signs/` is empty, `prisma/data/signs.json` does not exist                                                             |
| `MasterItem`                                                             | 169 rows, 130 APPROVED — **all `type = TEXT`**. Zero IMAGE, zero SIGN                                                                     |
| [start-tiles.tsx](src/components/quiz/start-tiles.tsx)                   | Practice · Mock exam · Topic practice. **No Sign Test, no Image Quiz**                                                                    |
| [item-editor.tsx:89](src/components/admin/questions/item-editor.tsx#L89) | `type: item?.type ?? "TEXT"` — **hardcoded**, no UI control. IMAGE/SIGN items cannot be authored                                          |
| Image upload                                                             | **Does not exist.** No storage service, no upload route, no `sharp`. The only `<input type="file">` in the repo is the student-roster CSV |
| `ImageAsset` / `ImageDetection`                                          | Migrated, but **never read or written** by any application code                                                                           |
| `startQuizInputSchema`                                                   | **No `itemType` field** — the spec-08 / DECISIONS amendment was never implemented, so an IMAGE-only quiz cannot be requested              |

Everything downstream is already built and correct: [question-card.tsx:47](src/components/quiz/question-card.tsx#L47)
renders `imageUrl`, [serializer.ts:74](src/server/services/quiz/serializer.ts#L74) carries it, and
[attempt-service.ts:175](src/server/services/quiz/attempt-service.ts#L175) already filters
`type = SIGN` for `mode: "SIGN"`. The pipes are laid; **nothing has ever been poured into them.**

`traffic_rules/theory book.pdf` closes the content gap, and I verified this end-to-end rather than
assuming it: pairing each embedded sign icon with its caption via `mutool trace` (image placement
matrices) + `mutool draw -F stext` (text bboxes) yields **287 / 287 images classified with a name
and a class — 253 distinct signs, zero unpaired**, across the ten section headings in pages 176–304:

```
Warning signs 44 · Give way and priority 7 · Prohibitory 38 · Mandatory 11 · Informative 46
Service information 28 · Direction 32 · Street 34 · Supplementary 29 · Marker 18
```

Those ten map cleanly onto the nine `SignClass` enum values. The chapter HTML files are **not**
usable — they are full-page scans with no text layer; the PDF is the only real source.

**Outcome:** a student opens the homepage and sees Theory Test, Image Quiz and Sign Test; tapping
Sign Test runs a real quiz on 253 Norwegian road signs. An instructor opens the admin panel, uploads
a photo, and attaches it to a question.

### Decisions taken (confirmed with the developer)

1. **Scope** — signs + image upload. The spec-06 AI vision pipeline (BullMQ workers, auto-drafted
   questions from photos) stays out.
2. **Sign content** — extracted names, plus AI-drafted meanings so the test can ask what a sign
   _means_, admin-reviewable.
3. **Go-live** — all 287 seeded active so the test works immediately, every one `provisional: true`
   with a `sourceNote`, filterable in a new `/admin/signs` screen.

### Stated assumptions & concerns

- **Provenance.** These icons are reproductions from a copyrighted third-party book. The sign
  _designs_ are defined by skiltforskriften and are not anyone's artwork, but this is not the
  official Statens vegvesen asset pack — which is exactly what
  [signs.example.json](prisma/data/signs.example.json) says to obtain. Every seeded row is flagged
  provisional with its source, and `/admin/signs` supports swapping the file per sign. **Get the
  official pack before commercial launch**; the schema and screens are built so that is a data
  change, not a code change.
- **No official sign codes exist in the PDF** (verified: zero skiltforskriften codes in the text
  layer). Rather than have an AI guess codes — a wrong code that _looks_ authoritative is worse than
  an obviously provisional one — signs get stable internal codes `X<CC><nnn>` (e.g. `XFA001`),
  editable to the official code in `/admin/signs`. Codes are identifiers; students never see them.
- **AI-drafted meanings are drafts.** They are grounded in the sign image + KB where available, and
  carry the provisional flag until a human clears it.

---

## Work

### Phase 1 — Content: PDF → sign registry → sign questions

**`scripts/extract-signs.ts`** (`pnpm signs:extract`) — one-off ingestion; its _output_ is committed,
so `mutool`/`pdfimages` are developer-machine prerequisites, never build or deploy dependencies.

- Per page 176–304: `mutool trace` for image placement rects, `mutool draw -F stext` for text
  blocks. Track section headings in y-order to carry the current `SignClass`; pair each image with
  the nearest text block below its bottom edge, falling through to the next page's first block.
  Discard pure-digit blocks (page footers) and split blocks on 3+ space runs (a caption and a
  section heading sometimes share a block — this is the one real failure mode and it is handled).
- `pdfimages -png` per page for the bytes; assert the per-page count equals the trace count before
  joining by index, so a draw-order mismatch fails loudly rather than mislabelling a sign.
- `sharp`: trim the white border, pad square, resize 512×512, write `public/signs/<code>.png`.
- Emit `prisma/data/signs.json` with `code`, `signClass`, `file`, `name.en`, `provisional: true`,
  `sourceNote` (book, page, caption).
- **Guard:** assert 287 images and 0 unpaired, exit non-zero otherwise.

**`scripts/enrich-signs.ts`** (`pnpm signs:enrich`) — fills `meaning` and the `nb` half of `name`.

- Per sign: `aiJson({ task: "VISION", userContent: [<the sign PNG>], … })` — sending the actual image
  markedly outperforms name-only, and `aiJson` already accepts `userContent`
  ([client.ts:154](src/server/ai/client.ts#L154)). Ground with `kb.search` over skiltforskriften
  where the KB has content; degrade to image+name when it does not.
- `nb` name and meaning via the same gateway on `task: "TRANSLATION"` (both routes are live on the
  configured Gemini provider — verified).
- New versioned prompt `src/server/ai/prompts/sign-meaning.ts`. Resumable and idempotent: skip
  signs already carrying a meaning so a failed run can be re-driven cheaply.

**`prisma/seed-signs.ts`** — fix two real bugs found while reading it:

- Its manifest enum accepts 8 `signClass` values; the schema has **9**. `MARKERING` is missing, and
  18 marker signs would be rejected.
- Persist the new `provisional` / `sourceNote` fields.

**Migration** `add_sign_provenance`: `Sign.provisional Boolean @default(false)`, `Sign.sourceNote String?`.
**No new index** — the admin list is 287 rows filtered by a flag and ordered by class, already served
by the existing `Sign_signClass_idx`; adding a low-cardinality index would cost writes and buy nothing.

**`scripts/seed-sign-questions.ts`** (`pnpm signs:questions`) — deterministic, no AI, seeded RNG via
the engine's own [rng.ts](src/server/services/quiz/rng.ts). Two formats per sign, both carrying the
sign image with text options (which is what `ItemVariant.content` supports):

| Format      | Stem                        | Options                                                |
| ----------- | --------------------------- | ------------------------------------------------------ |
| Meaning     | "What does this sign mean?" | correct meaning + 3 meanings from the same `signClass` |
| Recognition | "What is this sign called?" | correct name + 3 names from the same `signClass`       |

Topic mapping: `FARE → warning-signs`, `FORBUD`/`PABUD → prohibition-mandatory-signs`,
`VIKEPLIKT_OG_FORKJORS → priority-yield-signs`, remainder → `information-signs`. Citation:
skiltforskriften § for the class. Items go through the existing
[validation.ts](src/server/services/question-bank/validation.ts) quality gate and
[publish.ts](src/server/services/question-bank/publish.ts) so variants are materialised the single
sanctioned way — an approved item with no variant is invisible to students.

> **Deferred, deliberately:** spec-08's _meaning→sign_ direction (pick among four sign **images**)
> needs image-valued options, which `ItemVariant.content` and the client contracts do not model.
> That is a schema + contract change, out of this slice. Logged in `DECISIONS.md`.

### Phase 2 — Storage driver + authenticated image serving

Implements the approved spec-06 amendment (D3) and unblocks upload.

- `src/server/storage/{index.ts,local.ts,s3.ts}` — port `put/get/stream/delete/exists`, driver
  selected by config. Keys `images/{yyyy}/{mm}/{id}.{ext}`.
- `config/school.config.ts` — a `storage` block (driver, local dir, bucket/region/endpoint);
  **secrets from env only**. Local dir lives outside the repo.
- `src/app/api/images/[id]/route.ts` — behind `requireUser()`, streams bytes,
  `Cache-Control: private, max-age=300`. **Bytes are never served from a public path**; spec-12
  layers signed short-TTL URLs on this exact route later.
- Add `sharp` and `@aws-sdk/client-s3`. The MinIO round-trip in the spec-06 checklist is deferred to
  that spec's verification; `local` is fully unit-tested here.

### Phase 3 — Admin: upload, registry, and IMAGE/SIGN authoring

- **`/admin/images`** — grid with status/uploader/date filters; drag-drop batch upload (≤50 files,
  ≤15 MB, jpeg/png/webp) with a license-attestation checkbox, reusing the existing
  [image-pipeline.ts](src/server/contracts/image-pipeline.ts) contracts that today have **zero call
  sites**. `[id]/page.tsx` shows the image and the questions made from it.
- **`src/server/services/images/upload.ts`** — content-type **sniffed from magic bytes, never the
  extension**; `sharp` strips EXIF/GPS by re-encode and caps the long edge at 2048; dHash perceptual
  hash → duplicate warning against `ImageAsset_perceptualHash_idx`; `storage.put()`; row written with
  `url = /api/images/{id}`, `exifStripped: true`.
- **`/admin/signs`** — the registry review surface: list by class, bilingual search, provisional
  filter, edit code/names/meanings, replace the image file, activate/deactivate, re-draft a meaning
  with AI.
- **[item-editor.tsx](src/components/admin/questions/item-editor.tsx)** — add the **Type** control
  (TEXT/IMAGE/SIGN) that has never existed, an image picker setting `sourceImageId` for IMAGE, and a
  sign picker for SIGN. The contract and service already accept `sourceImageId`
  ([question-bank.ts:44](src/server/contracts/question-bank.ts#L44)) — the editor simply never sent
  it. Live preview gains `imageUrl` + `imageAlt`.
- Admin nav ([layout.tsx](<src/app/[locale]/(admin)/layout.tsx>)) gains Images and Signs.

### Phase 4 — Student: the three tiles

- **`startQuizInputSchema`** gains `itemType: itemTypeSchema.optional()`; in `attempt-service.ts`,
  `typeFilter = input.itemType ?? (input.mode === "SIGN" ? "SIGN" : undefined)`. This is the
  amendment DECISIONS.md already approved — one optional filter, **no new attempt mode, no
  migration**. Served by the existing `MasterItem_topicId_status_type_idx`.
- **[start-tiles.tsx](src/components/quiz/start-tiles.tsx)** — Theory Test · Image Quiz · Sign Test
  per spec-09, keeping Topic practice and the mock-exam entry below. Each tile is readiness-gated by
  approved count for its type, reusing the existing honest pattern: genuinely `disabled` with a
  shortfall tooltip, never faded-but-live.
- **[quiz-runner.tsx:189](src/components/quiz/quiz-runner.tsx#L189)** — pass `imageAlt`. It is
  accepted by `QuestionCard` and never supplied, so every image would render `alt=""`. A real
  WCAG 2.1 AA defect, fixed before any image ships.
- i18n `en` + `nb`: `home.theoryTest|imageQuiz|signTest` + locked variants, `nav.images|signs`,
  `admin.images.*`, `admin.signs.*`. Sign question text is content, not UI strings — it lives
  bilingually in `MasterItem.content`.
- Cache: `keys.signCatalogue(locale)` added to the registry in
  [redis.ts:22](src/server/redis.ts#L22), TTL 1h, **invalidated on any Sign write**.

### Phase 5 — Tests, docs, board

- **Unit** — caption-pairing against fixture pages; distractor selection deterministic under a seed;
  local storage driver round-trip; EXIF actually stripped; a `.png` that is really a script is
  rejected by sniffing; phash dedupe.
- **Integration** — `seed-signs` idempotent on re-run; generated sign questions pass the quality gate.
- **e2e `e2e/sign-test.spec.ts`** — homepage shows the tile → start → image renders → answer →
  submit → result, asserting **no response body carries `correctOptionKey` before submit** (the
  standing security invariant).
- **e2e `e2e/admin-images.spec.ts`** — upload → list → attach to an IMAGE question → publish →
  student sees the image; `/api/images/[id]` without a session → **401**; raw storage path not
  publicly reachable.
- **a11y** — axe on `/admin/images`, `/admin/signs` and the sign-test route; 390px no horizontal
  scroll (extends [shell.spec.ts](e2e/shell.spec.ts)).
- **Docs** — `specs/README.md` board: 06 → 🔨 (storage + upload done, vision pipeline pending),
  10 → 🔨 (sign registry landed). `DECISIONS.md` entries for: sign registry sourced from the theory
  book with provisional flagging; deterministic sign questions instead of AI-generated; `itemType`
  implemented; s3 MinIO verification deferred; meaning→sign image-options deferred. Evidence into
  `specs/notes/spec-06-notes.md`.
- **`.gitignore`** — add `traffic_rules/` (34 MB of third-party source material, currently untracked
  and unignored, one `git add -A` away from entering history).

---

## Verification

```bash
pnpm signs:extract          # asserts 287/287 paired; writes public/signs/ + prisma/data/signs.json
pnpm signs:enrich           # AI meanings + nb, resumable
pnpm exec prisma migrate dev && pnpm db:seed-signs && pnpm signs:questions
pnpm test                   # unit + integration
pnpm e2e                    # incl. sign-test.spec.ts, admin-images.spec.ts, a11y
```

Then drive the real app (`pnpm dev`):

1. `/en` signed in as a student → **three tiles**; Sign Test starts and shows a sign image.
2. Same in `/no` — names and meanings in Norwegian, no raw message keys.
3. Admin → `/admin/images` → upload a photo → `/admin/questions/new` → type **IMAGE** → pick it →
   publish → it reaches a student.
4. `/admin/signs` → provisional filter lists all 287; edit one code and meaning, confirm it sticks.
5. Log out, hit `/api/images/<id>` → **401**.
6. DevTools network on a sign attempt → **no `correctOptionKey` before submit**.

Final counts to confirm: `Sign` 287 rows, `MasterItem` gains ~506 SIGN items, and
`MasterItem.groupBy(type)` reports TEXT + SIGN + any IMAGE items authored by hand.
