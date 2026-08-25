# Spec 06 — verification notes (sign registry + image upload slice)

Session of 2026-08-25. Scope delivered: the sign registry sourced from `traffic_rules/theory book.pdf`,
the storage driver and authenticated image route, admin image upload and sign review, and the
student homepage's three tiles. **The AI vision pipeline (BullMQ workers, auto-drafted questions
from uploaded photographs) is NOT in this slice** — spec-06's original checklist stays open for it.

Rationale and the decisions taken are in `DECISIONS.md` (two entries dated 2026-08-25).
Plan: `specs/plans/spec-06-plan-signs-images.md`.

## What was actually broken

Measured against the running database before any change:

| Layer                           | State                                                                 |
| ------------------------------- | --------------------------------------------------------------------- |
| `Sign`                          | **0 rows**; `public/signs/` empty; `prisma/data/signs.json` absent    |
| `MasterItem`                    | 169 rows, 130 APPROVED — **all `type = TEXT`**, zero IMAGE, zero SIGN |
| `start-tiles.tsx`               | Practice · Mock exam · Topic practice — no Sign test, no Image quiz   |
| `item-editor.tsx:89`            | `type: item?.type ?? "TEXT"` hardcoded; no UI control, no image field |
| Image upload                    | did not exist — no storage service, no route, no `sharp`              |
| `ImageAsset` / `ImageDetection` | migrated but **never read or written** by app code                    |
| `startQuizInputSchema`          | no `itemType` — the 2026-08-24 amendment had never landed             |

## Evidence

### Extraction — PASS

```
$ pnpm signs:extract
Extracted 287 signs to /home/ds/Projects/driving-school/public/signs
By class: FARE=44 VIKEPLIKT_OG_FORKJORS=7 FORBUD=38 PABUD=11 OPPLYSNING=46
          SERVICE=28 VEGVISNING=66 UNDERSKILT=29 MARKERING=18
```

287 of 287 images paired with a name and a class, 0 unpaired. The script exits non-zero on any
unpaired image or a count other than 287, so a silent mislabel cannot pass.

Correctness was checked against the official catalogue rather than assumed. The give-way group
comes out as exactly the seven Norwegian priority signs, in order:
`Give way · Stop · Priority road · End of priority road · Priority junction ·
Give way for oncoming traffic · Priority over oncoming traffic`.

**A first version of the pairing was wrong and was caught this way**: with a tight tolerance the
caption "Give way" fell just above the image's bottom edge, so every sign in the group shifted by
one and the yield sign was labelled "Stop". Three further failure modes were found the same way —
they are documented in `scripts/extract-signs.ts` and pinned down by `scripts/sign-pairing.test.ts`.

### Enrichment — PASS

```
$ pnpm signs:enrich
Nothing to do — all 287 signs already drafted.
```

Sample output (`XFA001`): `Dangerous curve to the right` / `Farlig sving til høyre` —
"You are approaching a sharp or dangerous curve to the right. You must reduce your speed…" /
"Du nærmer deg en krapp eller farlig sving til høyre. Du må redusere farten…"

A defect was found and fixed here: the task was passed as `"VISION"` where the gateway's `AiTask`
is `"vision"`, so `TASK_ENUM[task]` was `undefined` and the gateway fell back through _every_
configured route — including an embedding model, which 404s on `generateContent`. 249 of 287 signs
failed on the first run because of it. Retry-with-backoff was added for provider rate limits.

### Registry and questions — PASS

```
$ pnpm db:seed-signs
Signs: 223 added, 64 updated.
287 marked provisional — review them in /admin/signs …
Coverage: UNDERSKILT=29 OPPLYSNING=46 MARKERING=18 FORBUD=38 VEGVISNING=66
          PABUD=11 SERVICE=28 VIKEPLIKT_OG_FORKJORS=7 FARE=44

$ pnpm signs:questions
Sign questions: 451 created, 123 skipped, 0 rejected by the quality gate.
Approved SIGN questions in the bank: 574
```

`123 skipped` on the second run is the idempotency guard working — those were created by the first.
**0 rejected by the quality gate**: every generated question satisfies the spec-04b gate
(mandatory citation, exactly one correct answer, ≥3 options, both locales complete, no length tell).

Final database state:

```
approved by type: TEXT=130 SIGN=574
signs: 287 | provisional: 287
sign imageAssets: 287
SIGN items with an active variant (servable): 574
```

574 of 574 have an active variant — an approved item with no variant is invisible to students, so
this is the number that matters.

### Security invariants — PASS

```
$ curl -o /dev/null -w "%{http_code}" http://localhost:3000/api/images/nonexistent   → 401
$ curl -o /dev/null -w "%{http_code}" http://localhost:3000/en/admin/signs           → 401
$ curl -o /dev/null -w "%{http_code}" http://localhost:3000/en/admin/images          → 401
$ curl -o /dev/null -w "%{http_code}" http://localhost:3000/signs/XVP001.png         → 200  (public by design)
```

The answer key never ships before submission: asserted for sign questions in
`e2e/sign-test.spec.ts`, which records every response during the attempt and fails on any GET body
containing `correctOptionKey`. Sign questions travel a different path into the payload (they carry
`sourceImage`), so this is checked separately from the text-only assertion in `student-quiz.spec.ts`.

### Tests — PASS

```
$ pnpm test
 Test Files  38 passed (38)
      Tests  351 passed (351)
```

New coverage: `scripts/sign-pairing.test.ts` (7 — every case a real page the naive version got
wrong), `src/server/storage/local.test.ts` (6, including the path-traversal guard),
`src/server/services/images/upload.test.ts` (8 — sniffing, EXIF, Hamming distance),
`src/server/services/images/upload.integration.test.ts` (5, against the real database and filesystem).

```
$ pnpm e2e
 31 passed
```

`e2e/sign-test.spec.ts` (3) passes: the tile is on the homepage, tapping it serves a question with
its picture, the picture is `object-contain` with a non-describing alt text, an empty pool renders a
genuinely disabled tile, and sign assets are public while `/api/images/[id]` is 401.

### Build — PASS

`pnpm build` compiles with no warnings. `local.ts` needed a `turbopackIgnore` on its runtime path
resolution; without it, static analysis traced the entire project — `public/`, 6 MB of sign
graphics included — into the server bundle.

### Manual, both locales — PASS

Screenshots at the 390px design target. `/en`: Theory test · Image quiz (correctly disabled, no
IMAGE questions exist yet) · Sign test · Test. `/no`: Teoriprøve · Bildeoppgaver er ikke klare ·
Skiltprøve · Prøve — no raw message keys. Sign test served "End of speed limit zone" with three
distractors from the same class and the graphic rendered uncropped.

## Defects found in existing code, and what happened to them

| Defect                                                                                                        | Status                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prisma/seed-signs.ts` accepted 8 of the schema's 9 `SignClass` values — every marker sign silently rejected  | **Fixed**                                                                                                                                                                                                 |
| `QuizRunner` never passed `imageAlt`, so any image would render `alt=""` (WCAG 2.1 AA)                        | **Fixed** — with a neutral label, since describing a test image _is_ the answer                                                                                                                           |
| `QuestionCard` used `object-cover`, which crops. A road sign clipped at the edge can read as a different sign | **Fixed** — `object-contain`                                                                                                                                                                              |
| Quality gate declared every image/sign question after the first a duplicate (shared boilerplate stem)         | **Fixed** — `sourceImageId` folded into the fingerprint                                                                                                                                                   |
| `home.practice` ("Mock exam") became unreferenced when the tiles were replaced                                | **Removed** from both locales                                                                                                                                                                             |
| Answer reveal lands in a second paint, shifting content below it                                              | **NOT fixed — spec-08.** Marked `data-testid="explanation"` with a `KNOWN DEFECT` note. Spec-08 asks for CLS ≈ 0 on reveal and must land the lock and the explanation in one update or reserve the space. |

## Known-flaky, pre-existing

`e2e/student-quiz.spec.ts` fails intermittently when the reveal reflows the page out from under a
click on **Next**.

Verified **pre-existing, not a regression**: with every change of this session stashed and the new
files moved aside, the baseline `pnpm e2e` fails the same family of test.

Investigating it turned up the genuine `shrink-0` overlap above, which is fixed. That took the
failure rate from roughly one run in two down to roughly one in six (measured over six full runs).
What remains is the second-paint reveal defect, which is spec-08's to close — the two tests now
wait on `data-testid="explanation"`, which removes the race but not the underlying shift.

## Outstanding for spec-06 proper

- Vision analysis of uploaded photographs, BullMQ workers, auto-drafted questions, validator chain,
  cost guard — the original spec-06 checklist, untouched by this slice.
- The s3 driver is implemented but only smoke-tested; the MinIO round-trip in the amendment's
  checklist has not been run.
- Composite images (D1) and the AI revision loop (D3) are not started.
- **All 287 signs are provisional.** They are reproductions from a copyrighted third-party book with
  AI-drafted meanings and placeholder codes. Obtain the official Statens vegvesen asset pack and
  work through `/admin/signs?review=1` before launch.
