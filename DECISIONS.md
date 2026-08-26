# DECISIONS.md — Approved deviations & architecture decisions

Append-only. Every time the developer approves a deviation from a spec or an approved plan —
or an architecture decision is made that isn't captured in a spec — it gets an entry here
**at the moment of approval**. Claude scans this file during Phase A of every spec.

## Entry format

```markdown
## YYYY-MM-DD · spec-XX · <short title>

- **Decision:** what was decided / what deviates from the spec or plan.
- **Why:** the reason.
- **Impact:** files/specs affected; anything a later spec must know.
- **Approved by:** developer
```

---

## 2026-08-24 · spec-00 · Fable/Opus work split (approved master plan)

- **Decision:** Fable (scarce tokens) executes the highest-leverage foundation ahead of normal spec order: architecture blueprint (`docs/architecture.md`), spec-01 foundation, spec-02 schema, API contracts + AI gateway module, and the **core** of spec-07 (deterministic engine: expansion, assembly, anti-leak serializer, grading, attempt lifecycle — no live AI jobs, no UI). Spec-07 is split into _core (Fable)_ / _integration (Opus)_. Fable also writes detailed plans for specs 03, 05, 06, 12 and briefs for 04, 08–11, 13, 14, plus `docs/handoff-opus.md`. Opus executes everything else in spec order 03 → 14.
- **Why:** Fable tokens are limited; Opus tokens are not. The schema, engine invariants (leak-proofing, uniqueness, grading), and architecture are the hardest-to-redo parts.
- **Impact:** Status board shows 01, 02 done by Fable and 07 split. Per-spec plan approval for Fable-executed specs was granted via the approved master plan (plan files still written as records).
- **Approved by:** developer

## 2026-08-24 · spec-03 · Auth stack shape: credentials-only Auth.js, no Prisma adapter

- **Decision:** Auth.js v5 (`next-auth@beta`) runs **credentials-only with the JWT strategy and no Prisma adapter**. Instead of the Auth.js adapter tables, spec-03 adds two owned tables: `UserSession` (view/revoke, id carried in the JWT as `sid`) and `AuthToken` (sha256-hashed, single-use, `EMAIL_VERIFY`/`PASSWORD_RESET`). The adapter and an `Account` table arrive with the Vipps/OIDC spec, when OAuth account linking actually needs them.
- **Why:** the credentials flow cannot use DB sessions, so the adapter's `Session`/`Account`/`VerificationToken` tables would sit empty and duplicate our own hashed-token flow — two token systems to keep straight for no benefit.
- **Impact:** deviates from the Fable draft of `specs/plans/spec-03-plan.md` and from the comment at `prisma/schema.prisma:3` ("Auth.js adapter tables arrive with spec-03's migration") — that comment is corrected in this spec's migration. Session revocation is enforced in the `jwt` callback via Redis `tp:auth:sess:<sid>` (TTL 5 m, `cacheDel` on revoke, so revocation is immediate).
- **Approved by:** developer

## 2026-08-24 · spec-03 · Login-ticket pattern: Auth.js is cookie/JWT plumbing only

- **Decision:** the login server action calls our `verifyCredentials` service (rate limit → argon2 verify → email-verified check → TOTP check), which issues a **one-time Redis login ticket** (`tp:auth:ticket:<id>`, 60 s, GETDEL). The Auth.js Credentials provider only consumes that ticket and mints the session.
- **Why:** typed bilingual errors we control (invalid credentials / unverified email / TOTP required / rate-limited) instead of relying on Auth.js beta's `CredentialsSignin` error-code plumbing, and the password is verified exactly once. The ticket never reaches the browser — action and `signIn` both run server-side.
- **Impact:** `src/server/services/auth/credentials.ts` owns login logic; `src/server/auth/config.ts` stays thin. Redis becomes a hard dependency of the login path (already core infrastructure).
- **Approved by:** developer

## 2026-08-24 · spec-03 · Auth implementation details (hashing, layering, scope, 403, 2FA recovery)

- **Decision:** (a) password hashing uses **`@node-rs/argon2`** (prebuilt N-API binaries) with argon2id m=19456/t=2/p=1, plus `serverExternalPackages`, rather than the node-gyp `argon2` package; (b) auth **business logic lives in `src/server/services/auth/*`** (framework-agnostic) while `src/server/auth/*` holds only Auth.js/Next wiring; (c) spec-03 ships a **minimal `/admin/invites` page** (create/copy/revoke + CSV upload) on top of the invite/CSV services — spec-11 restyles and expands it; (d) **`experimental.authInterrupts: true`** in `next.config.ts` so `forbidden()`/`unauthorized()` return real 403/401 with bilingual boundaries; (e) **2FA recovery is the `pnpm auth:reset-2fa <email>` CLI**, recovery codes deferred to spec-12; (f) emails go through a `MailTransport` port (SMTP/capture) sent inline — the BullMQ `emails` queue swaps in behind the port once the worker exists (spec-06); (g) `InviteLink.maxUses`: `null` = unlimited, `1` = single-use, omitted input → `1` (resolves the contradiction between `schema.prisma:202` and `contracts/auth.ts:40`).
- **Why:** (a) no compiler at install or in the spec-14 container, identical algorithm/params; (b) architecture §2 layering rule (services never import `next/*`); (c) without it nobody can onboard a student until spec-11; (d) the acceptance checklist requires a real 403 page, and this is the only App Router API that sets that status; (e) single-instance-per-school deployments give the owner server access, so a table + regenerate UI is not worth it yet; (f) no worker process exists before spec-06; (g) one reading of the field, enforced in one place.
- **Impact:** `specs/plans/spec-03-plan.md` (approved version) is authoritative. New shared infrastructure that later specs reuse: `src/server/rate-limit.ts`, `src/server/audit.ts`, `src/server/email/*`, `src/server/auth/require-user.ts` (the only caller of `authorize()` from Next code), `src/lib/csv.ts`. Spec-11 inherits the invites page; spec-12 replaces the `auth-coverage` test with the full route manifest and revisits recovery codes.
- **Approved by:** developer

## 2026-08-24 · spec-03 · Schema drift fix: KbChunk hybrid-search objects declared in the Prisma schema

- **Decision:** `KbChunk.textSearch` (the GENERATED tsvector from `20260824054002_kb_hybrid_search`) and its GIN index are now declared in `prisma/schema.prisma`, and the HNSW index statement Prisma still proposes dropping was stripped from the spec-03 migration. `prisma/migrations.test.ts` fails the build if any future migration drops either object.
- **Why:** the schema did not model those raw-SQL objects, so `prisma migrate dev` generated `DROP INDEX "KbChunk_embedding_hnsw_idx"` and `DROP COLUMN "textSearch"` into spec-03's migration — applying it would have silently destroyed knowledge-base search before spec-05 ever used it.
- **Impact:** Prisma has no `hnsw` index type and cannot model a GENERATED column, so **every** future migration will still propose `DROP INDEX "KbChunk_embedding_hnsw_idx"` and `ALTER COLUMN "textSearch" DROP DEFAULT` — delete those two statements from generated SQL (the schema comment on `KbChunk` says so, and the guard test enforces it). Touches spec-02's artifacts; spec-05 depends on both objects existing.
- **Approved by:** not yet — applied during spec-03 implementation because the generated migration could not ship otherwise; flagged for the developer in `specs/notes/spec-03-notes.md` (§Fixed while implementing).

## 2026-08-24 · spec-04/05/06 · AI question factory: scope mapped onto the roadmap

- **Decision:** the requested end-to-end loop (upload images → AI writes a legally grounded question set → curate it, fix questions with AI, add more → students sit an image exam and a theory exam) is delivered across the existing specs in dependency order **04 → 05 → 06**, each with its own plan, approval gate and evidence file — not as one combined spec. Spec-04 gains question **sets** (`GenerationBatch` + `MasterItem.batchId`), set curation and an AI-accuracy dashboard; spec-05 gains the AI provider registry as its first deliverable; spec-06 gains the storage port, the no-upload composite-image path and the AI revision loop. Spec-08's Image/Theory/Sign tiles are the same engine with a new optional `startQuizInput.itemType` filter — no new attempt mode, no migration.
- **Why:** generation cannot cite law before the KB exists (spec-05), and generated questions need a place to be judged (spec-04), so the numeric order already matches the dependency order. Separate gates keep each piece verifiable instead of merging four acceptance checklists into one.
- **Impact:** `specs/spec-04/05/06/08-*.md` carry dated amendment sections; the full loop is live at the end of spec-06. The "AI fixes it" control ships disabled-with-tooltip in spec-04 and goes live in spec-06 (see next entry).
- **Approved by:** developer

## 2026-08-24 · spec-06 · AI-generated images are composites, never pure diffusion

- **Decision:** when no photo is uploaded, the AI generates only a **sign-free background scene**; the pipeline then composites official skiltforskriften SVGs from the spec-05 sign registry onto it at chosen positions (`sharp`). The composed image needs human approval before any question generated from it leaves DRAFT. A vision read-back re-verifies the sign codes; mismatch fails the job.
- **Why:** diffusion models render Norwegian road signs inaccurately — wrong glyphs, invented signs, wrong colours — and a wrong sign makes the exam question legally wrong. Compositing means the sign codes are known by construction, so the context sheet is ground truth instead of a guess, and the question is defensible against the official teoriprøve.
- **Impact:** spec-06 depends on the spec-05 sign registry (SVG assets) for the no-upload path; the `image` task joins the AI route table.
- **Approved by:** developer

## 2026-08-24 · spec-05 · Multi-provider AI gateway with admin-managed keys

- **Decision:** the gateway keeps its single-module surface (`aiJson` / `aiEmbed`) but gains three adapters — Google Gemini (native), Anthropic (native) and one OpenAI-compatible adapter covering DeepSeek, OpenRouter, Groq, Mistral, Ollama and the current OmniRoute endpoint by base URL. Provider records and per-task routes (`vision`, `generation`, `validation`, `embedding`, `image`) live in the database with an ordered fallback chain; API keys are encrypted at rest with the spec-03 AES-256-GCM helpers and managed in an admin screen that never returns a plaintext key. Env keys remain the fallback so CI and dev need no database.
- **Why:** the school must supply its own keys (including free tiers) without a redeploy, and quota exhaustion on one provider must not stop question generation. It also lets cheap models run the high-volume validator chain while a strong model handles generation.
- **Impact:** supersedes `CLAUDE.md`'s "model names are config, never inline strings" — model **routing** becomes runtime config in the DB; the "every AI call goes through one gateway module" mandate is unchanged and reinforced. `CLAUDE.md` is updated when spec-05 lands.
- **Approved by:** developer

## 2026-08-24 · spec-06 · Image storage is a driver port, served through the app

- **Decision:** `StorageDriver` with `local` (a configured VPS directory outside the repo) as the default and `s3` (any S3-compatible endpoint) opt-in by config — one code path either way. Image bytes are never served from a public URL or bucket; they stream through `/api/images/[id]` behind `requireUser()`.
- **Why:** production runs on a single VPS where local disk is the simplest thing that works and is backed up with the database, while S3 stays a config flip away. Routing bytes through the app is what makes spec-12's signed short-TTL URLs and per-student watermarks possible without rewriting the pipeline — publicly linkable exam images would foreclose that.
- **Impact:** `config/school.config.ts` gains a storage block (secrets stay in env); spec-12 builds its anti-cheat layer on this route; spec-14 must back up the local image directory alongside Postgres.
- **Approved by:** developer

## 2026-08-24 · spec-04 · Approval publishes: the missing link between the bank and the engine

- **Decision:** `transitionItem(→ APPROVED)` materialises `ItemVariant` rows via the spec-07 template engine (`expandTemplate` + `computeContentHash`); an item without `parameterSlots` gets exactly one variant mirroring its master content, a templated item gets one per expansion. RETIRE deactivates that item's variants (`isActive = false`). Publishing is idempotent — the unique `contentHash` absorbs a re-approve. It lives in its own service, `src/server/services/question-bank/publish.ts`.
- **Why:** `PrismaVariantSource` serves APPROVED masters **joined to active variants**, so an approved item with no variant is invisible to students. Nothing in specs 04, 06 or 07 said who writes that first variant — approving questions would have silently produced empty quizzes.
- **Impact:** spec-07 integration (the Redis pool warmer) and spec-06 (generated items) both depend on this being the single publish path. Retiring never rewrites history: served attempts keep their own immutable variant snapshot.
- **Approved by:** developer

## 2026-08-24 · spec-04 · Review, search and preview mechanics

- **Decision:** (a) rejection reasons are a **`RejectionReason` enum** column beside the free-text `reviewNote`; (b) admin search uses a **generated `tsvector` column + GIN** added in raw SQL (`simple` config over the en+nb stems), guarded by an extended `prisma/migrations.test.ts`; (c) **one `QuestionCard` component** is built here and consumed by spec-08, taking a client-shaped question plus an **optional** `reveal` prop for correctness; (d) `legalCitations` stays **JSON only** in this spec — the queryable `MasterItemCitation` rows are backfilled by spec-05; (e) editing an APPROVED item bumps `version` and writes the **previous content snapshot into `AuditLog.meta`** instead of a version table; (f) INSTRUCTOR browses/edits/reviews, ADMIN additionally imports/exports, bulk-retags and deletes; (g) ship `prisma/seed-items.ts` (~24 sample bilingual DRAFT items) and `scripts/seed-volume.ts` (10k items) so the spec is demoable and its p95 claim measurable.
- **Why:** (a) the amendment's "ranked rejection reasons" cannot rank prose, and spec-06 needs the taxonomy for few-shot examples; (b) search over 10k items must not seq-scan a JSON extract, and `simple` avoids Norwegian stemming applied to English text; (c) the spec demands the preview render exactly as students see it — two implementations would drift inside one spec, and a separate `reveal` prop keeps the anti-leak invariant in the type system; (d) `MasterItemCitation` points at KB chunks and facts that do not exist until spec-05, so rows written now would dangle; (e) follows the brief's "no version table" decision while keeping rollback data; (f) matches spec-11's instructor scoping; (g) every screen in this spec renders an empty table otherwise.
- **Impact:** spec-08 must consume `src/components/quiz/question-card.tsx` rather than reimplementing it; spec-05 backfills citations and adds the `AiProvider` FK for `GenerationBatch.providerId` (a plain column until then); the migration guard test now covers `MasterItem_searchText_idx` as well as the KbChunk objects.
- **Approved by:** developer

## 2026-08-25 · spec-04 · Editing an approved item supersedes its old variants

- **Decision:** editing an APPROVED item bumps `version`, **deactivates the variants published from the previous version** and republishes from the new one. The spec-04 brief had said variants "stay active until regenerated".
- **Why:** the common reason to edit an approved question is that something about it is wrong. Leaving the old variant active keeps serving the wrong answer to new students indefinitely. Attempts already served are unaffected either way — they reference their variant row directly, so `isActive` does not change what a student in flight sees.
- **Impact:** `src/server/services/question-bank/items.ts`; asserted by the versioning integration test (old variant inactive and byte-identical in the served attempt, new variant active with the corrected key). Spec-07's pool warmer must treat `isActive: false` as "stop offering", which it already does.
- **Approved by:** not yet — applied during spec-04 implementation as a safety correction to the brief; flagged for the developer in `specs/notes/spec-04-notes.md`.

## 2026-08-25 · spec-04b · A pass mark gates a student's progress: assessment integrity

- **Decision:** the result of a mock exam here is the **school's internal gate** before a student may book the official teoriprøve — it is not submitted to, or recognised by, Statens vegvesen. The engineering target is therefore a result that is _defensible_: immutable, auditable and reproducible. On top of that: (a) an **APPROVED question is frozen** — corrections happen by retiring it and approving a linked replacement (`MasterItem.replacesId`), never by editing; (b) approval needs **two distinct reviewers for an AI-drafted question and one non-author reviewer for a human-written one** (`ItemApproval`, keyed by item version so an edit voids earlier sign-offs); (c) a **deterministic quality gate** runs before review and before approval — mandatory legal citation, exactly one answer among the options, ≥3 options, no duplicate or ungradeable options ("all of the above"), both locales complete, no unfilled placeholders, no duplicate of an existing question; (d) every submitted attempt is **sealed**: a sha256 over the questions served, the option order shown, the answers given and the grade, stored on the attempt and verifiable by re-computation.
- **Why:** a wrong or ambiguous question, or a mark that can be altered afterwards, is not a cosmetic defect when the result decides whether a student progresses. "The service never does that" is not a guarantee, so the rules are enforced by **database triggers** as well as by code: a published variant's text and answer cannot change, answers cannot change once an attempt closes, a submitted result cannot be rewritten or deleted, and the seal is write-once.
- **Impact:** supersedes spec-04's acceptance item "editing an approved item creates v+1" — approved items no longer version, they are replaced. `transitionItem` now returns `{applied, approvals}` rather than throwing when a first approval is recorded (a recorded approval is a success for that reviewer). Student-facing history (`/account/history`) reads the retained record. The engine attests inside the grading transaction. **Not covered by code: any actual recognition of these results by an authority — that is an agreement, not an engineering property.**
- **Approved by:** developer

## 2026-08-25 · spec-04/05 · Question similarity: repeats rejected, alternates grouped

- **Decision:** every question stem carries a 1536-dim embedding (`MasterItem.stemEmbedding`, pgvector + HNSW). Cosine against the existing bank classifies a candidate three ways: **≥ 0.94 is a repeat** (rejected at generation, or retired-and-deleted in cleanup), **0.85–0.94 is an alternate** — the same rule asked in different words, which is _kept_ and tagged with a shared `MasterItem.conceptGroupId` — and below that it is a distinct question. Assembly then treats a concept group like a master item: two students may each get one phrasing, one student never gets both in a paper. Retired questions are included in the comparison on purpose.
- **Why:** the model repeated itself relentlessly — 34 of 81 questions in the bank were repeats, and the exact-string `stemFingerprint` check never caught them because it also never ran within a generation batch. Both numbers are calibrated against this bank rather than guessed: at 0.94+ pairs were verbatim rewrites; genuine alternates run 0.835–0.94 ("When should low beams be used?" / "When must you use dipped headlights?"); by 0.82 unrelated rules were being paired (a tram at a stop with two cars meeting on a narrow road). Grouping uses **complete linkage** — single linkage chained "yield to the right" into "turning left yields to oncoming" through intermediate phrasings, and those are different rules. Over-merging is the expensive error, because a merged group contributes exactly one question to any exam.
- **Impact:** `similarity.ts` (classification, bank-wide passes, regrouping) is called by `generation/theory.ts` and by `pnpm qb:dedupe`; `assembly.ts` excludes a used `conceptGroupId`; `exam-readiness.ts` and `rebalanceToAvailability` count **distinct concepts, not rows**, or they promise a paper the pool cannot fill. Cleanup retired 34 repeats and deleted the 26 no student had sat — a question already sat is retired only, because an exam record must keep pointing at the question that was asked.
- **Approved by:** developer (asked for unique questions, difficulty spread, and no repeated question or question type within one exam)

## 2026-08-25 · spec-07 · A paper is spread across difficulty bands

- **Decision:** difficulty target per paper is **30% easy (1–2), 40% medium (3), 30% hard (4–5)**, allocated whole-paper (not per topic) by largest remainder, and applied as a _preference_ — a thin pool fills what it can rather than failing to assemble. The same brief is given to the generator, which must set `difficulty` honestly.
- **Why:** the official teoriprøven publishes no difficulty blueprint, so this is the school's own standard, written down rather than implied. Left alone the model drifts easy: the bank measured 21 questions at level 1, 45 at level 2, 3 at level 3 and none above, which tests recall rather than readiness to drive. With the brief in place a generation run came back 9/9/28/19/1 across levels 1–5.
- **Impact:** `DIFFICULTY_TARGET` and `bandOf` in `assembly.ts`; `AssemblyResult.difficultyMix` reports what a paper actually came out as; `pnpm qb:audit` checks assembled papers. Real 45-question papers now assemble at roughly 18 easy / 18 medium / 9 hard — the hard band undershoots only where the pool has no hard questions for a topic.
- **Approved by:** developer

## 2026-08-25 · spec-05 · The AI learns from what was rejected

- **Decision:** every refusal is kept in a `GenerationRejection` ledger — the deterministic gate's, the duplicate check's, and a reviewer's — with the stem, machine reason codes, and the reviewer's **optional free-text note**. Before each generation run, recent refusals for that topic are rendered into the prompt as worked examples ("this stem was rejected, because …"), reviewer refusals first, capped at 12 so the law still dominates the prompt. Rejections are never deleted.
- **Why:** rejection is the only signal that says what _this school_ considers a bad question, and it was being thrown away: gate-rejected candidates existed only in a log line, and a reviewer's reason was overwritten into `reviewNote` as an enum string. A shrinking teaching set would let old mistakes return.
- **Impact:** `rejections.ts` (record + build lessons), `theoryGenerationPrompt` v1.2.0 takes `rejectionLessons` and `difficultyBrief`, the review queue offers a note field before the reason buttons, `transitionItemInput` separates `reason` (the code) from `note` (the words). Writing a lesson never fails the click or the run that produced it.
- **Approved by:** developer

## 2026-08-25 · spec-07/08 · An answer is final the moment it is given

- **Decision:** answering a question writes the answer immediately and **irreversibly**. A second, different answer to the same question is refused by the service (`ConflictError`, `quiz.errors.answerLocked`) and by the database (`tp_attempt_question_immutable` now also refuses any change to a non-null `answeredOptionKey`). Re-sending the _same_ answer stays idempotent, so a retry, a double tap or a flaky connection is not an error. The card locks in the UI and says so, and a new read — `revealAnswered` — re-shows the feedback for an already-answered practice question so navigating back, or reloading, is not a blank card.
- **Why:** answers were already saved per question, but they could be overwritten. In practice mode the correct answer is revealed the moment a question is answered, so navigating back and correcting it turned every practice score into a formality — the student's own record then said nothing about what they knew. For a mark the school uses as its gate before the official teoriprøve, an answer that can be revised after the answer is shown is not evidence of anything.
- **Trade-off, stated plainly:** the real teoriprøven lets a candidate revise answers freely until they submit, so this platform is now _stricter_ than the exam it prepares for. That is a deliberate product choice — accepted because the reveal happens per question here, which the official test does not do. If exam mode is ever made reveal-free end to end, the rule could be relaxed for EXAM attempts alone without touching practice.
- **Impact:** `attempt-service.answer` / `revealAnswered`, `revealInputSchema`, `revealAction`, `quiz-runner.tsx` (per-question reveal cache, locked card), migration `20260825100500_answer_write_once`, guarded by `prisma/migrations.test.ts`. The anti-leak invariant is untouched: the reveal is a separate authenticated read for a question the student has already answered, never part of the page payload, and it refuses EXAM mode outright.
- **Approved by:** developer

## 2026-08-25 · spec-08/09 · Resume, and the record on the home page

- **Decision:** the home page leads with the test the student walked away from — mode, how far they got, time left if timed, and a Continue button — followed by the last three tests with score, percentage and a pass/fail badge. Opening an attempt that is no longer in progress redirects to its result rather than rendering a paper that can no longer be answered. A timed attempt whose clock ran out while the student was away is **not** offered as resumable: opening it closes and grades it, so calling it resumable would be a lie. The result page gained the facts a result is normally quoted with — date sat, time used, percentage, wrong-answer count, per-topic bars, and the seal and guarantee badges.
- **Why:** leaving a test half-finished is ordinary. Nothing was ever lost (answers are written as they are given), but the student had no obvious way back in — the only affordance was a small row in a list. And a finished test needs to be readable as a result, not just as a stack of questions.
- **Impact:** `getResumableAttempt` / `getAttemptSummary` in `history.ts`, `ResumeCard` and `RecentTests` components, `quiz/[attemptId]/page.tsx` redirect, and the attempt paper page. Spec-09's dashboard supersedes the home-page layout later; these are the pieces it will reuse.
- **Approved by:** developer

## 2026-08-25 · spec-08/09 · Test vs mock exam, and a record of tests only

- **Decision:** the two entry points swap names. The configured, guarantee-eligible run started from the setup screen is the **Test**; the quick ten-question run is the **Mock exam**. Naming now comes from an explicit `AttemptKind` (`TEST | PRACTICE | TOPIC | SIGN`) carried on every attempt summary, not from the engine's `mode` — a configured test runs in TOPIC mode internally and must still be called a test everywhere it is shown. **The record (`/account/history`, the home list) shows tests only**: `mode = EXAM`, or an attempt carrying a `setupSnapshot`, which is written only by the setup screen. `listAttemptHistory({ onlyTests: false })` still returns everything for support and for tests.
- **Why:** the student's record is evidence of tests sat, and mixing ten-question practice runs into it made the record meaningless at a glance. Deriving the name from `mode` could not express this, because one mode serves both a configured test and a topic drill; `setupSnapshot` is the fact that actually distinguishes them, and it is written at start time rather than inferred later.
- **Impact:** `attemptKindSchema`, `kindOf`, `TEST_ONLY` in `history.ts`; every student-facing label moved from `history.mode.*` to `history.kind.*` (the old keys are deleted, so a missed call site fails the message-key test rather than silently reading "Topic practice" on a test). Behaviour of the tiles is unchanged — only their names and what the record lists.
- **Approved by:** developer

## 2026-08-25 · spec-09 · Category standing, from tests only and answered questions only

- **Decision:** a "how you are doing by category" panel sits above the record on the home page. It aggregates over the student's **closed test attempts**, counts only the questions they actually **answered**, and lists **every** root category — including ones never tested, shown as "Not tested yet".
- **Why:** three deliberate choices. _Tests only_, because the panel answers "how do I perform under test conditions", and practice with instant feedback does not answer that. _Answered only_, because a blank on a test scores zero but is not evidence that a category is weak — counting blanks as wrong would make the panel useless for a student who has answered a handful of questions, which is exactly when it is most wanted. _Every category_, because the gaps are the useful part; a list that silently omits untested categories reads as coverage. Counts are shown next to the percentage, since "1 of 2" and "34 of 68" are both 50% and mean different things.
- **In-progress attempts are excluded, deliberately.** Their answers are ungraded until submission, and grading them for a panel would put correctness about an in-flight exam in front of the student — with a thin category that is enough to reveal whether a specific answer was right. The anti-leak invariant wins over the nicer empty state: the panel fills the moment a test is handed in.
- **Impact:** `categoryPerformance()` in `history.ts` (one grouped scan of `ExamAttemptQuestion` joined to the student's closed test attempts) and `CategoryProgress`. Spec-09's mastery dashboard supersedes this panel later and can reuse the query.
- **Approved by:** developer

## 2026-08-26 · spec-05/06 · Mode 2 — AI questions from an uploaded image

- **Decision:** an image can now be turned into questions by AI, with the human confirmation step **optional** (developer's call; I had recommended mandatory). The governing rule throughout is that **the AI may write prose but may not be the source of a fact**: sign identity is the only fact a legal citation hangs off, so it is the only thing put through closed-vocabulary selection, agreement across three readings, and a crop-and-discriminate re-check against same-class graphics.
- **Why this shape:** measured on this deployment's own model against clean registry graphics — open recall 2/7 usable, closed vocabulary 6/7, and the single miss returned at **0.95 confidence**. So identification is always a choice from the registry, and self-reported confidence gates nothing.
- **`skiltforskriften` ingested** (60 chunks). It was absent, and it is the regulation that defines every sign — grounding, not the model, was the accuracy ceiling. `htmlToLegalText` was leaking Lovdata anchors, repeated headings and its "Del paragraf" control into every chunk; fixing that more than doubled the recovered text.
- **Eight of the nine sign-class citations shipped the previous session were wrong** — guessed rather than read. 498 of 574 questions were **retired and replaced** (not edited: approved questions are frozen and 50 had been served in real attempts). `SECTION_FOR_CLASS` now carries the section titles and an instruction to verify against the KB.
- **The blind answer-check is the centrepiece.** A second pass sits the question with the key, the explanation and the authored option order all withheld, and refuses on disagreement. It also returns `sceneSupported`, after a real batch produced a question about where to stop for a picture containing no stop sign — the **law was right while the picture was wrong**, and § 6 covers all priority signs so nothing else caught it. That is counted separately as `IMAGE_MISMATCH`, since it needs a different fix from a disputed key.
- **Two checks now sit behind a prompt instruction the model ignored twice.** Told not to name the sign, it wrote "the Give Way sign"; told again, it paraphrased the sign's meaning into the stem with the correct option restating it. `checkStemHidesTheSign` catches the name, `checkStemDoesNotLeakAnswer` catches the paraphrase by embedding.
- **Bounding boxes are treated as approximate, and their format as unstable.** The same model on the same picture returned `[[y, x, h, w]]` as fractions on one run and on the 0–1000 grid on the next; order was determined by fitting against known sign positions, scale is detected per box, and crop padding is 40% because a box ~10% of image width out will otherwise slice a sign in half. A bad crop degrades to "unresolved", never to a mislabelled sign.
- **Schema strictness sits only where it matters.** Whole readings were being discarded over `confidence` and `conditions`, which decide nothing; `code` stays strict, and every other tolerance fails towards refusing the question.
- **The review queue shows the image**, and a banner when `factsVerified` is false. `ReviewItem` had no image field, so approving an image question was a rubber stamp — which would have made the two-person sign-off worthless for exactly these questions.
- **Impact:** migration `add_batch_facts_verified`; `src/server/services/pipeline/{vision,validators}.ts`, `generation/image.ts`, `ai/prompts/{vision,validation}.ts`, `/admin/images/[id]` context-sheet editor. `kbSearchInput` gains a `sourceCodes` filter, applied inside both legs of the hybrid query so a small regulation is not starved by a large one. Two dead prompts removed — one shared an id with the live one, and `promptId` is artifact provenance.
- **Known weakness, stated plainly:** the blind check runs on the same model that wrote the question, because only Gemini is configured. It is an independent call, not an independent judgement. A second provider in `/admin/ai` is the cheapest accuracy upgrade available.
- **Approved by:** developer

## 2026-08-26 · tooling · Editing an applied migration breaks `prisma migrate dev`

- **Decision:** the safe order is `migrate dev --create-only` → edit the SQL → `migrate deploy`, now documented next to the generated-column warning in `schema.prisma`.
- **Why:** this repo REQUIRES hand-editing generated migrations, to strip the HNSW-index and generated-column drops Prisma proposes every time. Editing one after it has been applied changes its file checksum, and every later `migrate dev` then demands a full database reset — which would have destroyed the sign registry, the question bank and the knowledge base.
- **Impact:** recovering from it means repairing `_prisma_migrations.checksum` by hand (sha256 of the file) for **every row of that migration, the rolled-back attempt included** — Prisma compares against those too, which is not obvious and cost a while to find.
- **Approved by:** developer

## 2026-08-25 · spec-05/06/08 · Sign registry from the theory book, and the three-tile homepage

- **Decision:** the sign registry is seeded from `traffic_rules/theory book.pdf` (chapter 10), because `prisma/data/signs.example.json` asks for an official Statens vegvesen asset pack the school does not have and Wikimedia was already ruled out. `pnpm signs:extract` recovers all **287** sign graphics with their English names and sign class; `pnpm signs:enrich` drafts each sign's meaning and Norwegian from the graphic via the AI gateway; `pnpm signs:questions` turns the registry into **574** approved SIGN questions. Every seeded row carries `provisional: true` and a `sourceNote` naming book and page, and `/admin/signs` is where a person corrects it and clears the flag.
- **Why:** the sign test was unbuildable without sign data — the registry was empty, so `MasterItem` held 130 questions and every one of them was `TEXT`. The sign DESIGNS are defined by skiltforskriften and are not anyone's artwork, but these particular reproductions come from a copyrighted third-party book, so they are flagged rather than treated as final. **The official pack should replace them before commercial launch**; the schema and the admin screen make that a data change, not a code change.
- **Sign codes are internal placeholders (`X<CC><nnn>`), not skiltforskriften codes.** The PDF contains none, and an AI-guessed code would read as authoritative while being wrong — worse than one that is obviously provisional. Codes are identifiers; students never see them. `/admin/signs` makes `code` editable so a school can enter the real one.
- **Sign questions are generated deterministically, NOT by the AI.** Two per sign — "What does this sign mean?" and "What is this sign called?" — with three distractors drawn from the same sign class, under the engine's own seeded RNG. Distractors from the same class on purpose: offering a service sign against a warning sign makes the question answerable on shape and colour alone. Both forms carry the sign graphic with text options, which is what `ItemVariant.content` models.
- **Sign items are inserted APPROVED, bypassing two-person sign-off.** Defensible only because the content is mechanical: it restates registry rows and invents nothing. The registry, reviewed in `/admin/signs`, is the thing a human signs off.
- **Sign graphics are public; uploaded photographs are not.** Signs are reference material — spec-10 puts them in a browsable catalogue and a logged-out demo quiz — so they are served straight from `public/signs/`. Exam photographs go through `/api/images/[id]` behind `requireUser()`. Each sign is wrapped in an `ImageAsset` row so a sign question reuses the engine's existing image path (`variant.masterItem.sourceImage.url`) with no schema or serializer change.
- **`startQuizInput.itemType` is now implemented** (the amendment approved 2026-08-24 that had never landed): Theory / Image / Sign are one engine with one optional filter. No new attempt mode, no migration. Each tile is gated on its own pool and renders genuinely `disabled` when empty.
- **Impact:** migration `20260825124426_add_sign_provenance` (`Sign.provisional`, `Sign.sourceNote`; no new index — 287 rows filtered by a flag are already served by `Sign_signClass_idx`). New: `scripts/{extract-signs,enrich-signs,seed-sign-questions,sign-pairing}.ts`, `src/server/ai/prompts/signs.ts`, `/admin/signs`. Fixed: `prisma/seed-signs.ts` accepted 8 of the schema's 9 `SignClass` values, silently rejecting every marker sign, and it now seeds incrementally instead of all-or-nothing.
- **Deferred:** spec-08's _meaning→sign_ direction (choosing among four sign **images**) needs image-valued options, which `ItemVariant.content` and the client contracts do not model. That is a schema + contract change and is out of this slice.
- **Approved by:** developer

## 2026-08-25 · spec-06 · Image storage driver, upload hardening, and image-aware duplicate detection

- **Decision:** the approved storage-driver port (D3, 2026-08-24) is implemented — `src/server/storage/{index,local,s3}.ts` with `put/get/stream/delete/exists`, driver chosen by `schoolConfig.storage`, keys namespaced `images/{yyyy}/{mm}/{id}.{ext}`. Bytes are never reachable from a public URL: the local directory sits outside `public/` and `/api/images/[id]` streams them behind `requireUser()`. `/admin/images` uploads in batches, and the question editor finally exposes a **Type** control (TEXT/IMAGE/SIGN) with an image picker — `type` had been hardcoded to `"TEXT"`, so IMAGE and SIGN questions could not be authored at all.
- **Uploads are sniffed by magic bytes, never by filename or declared content type**, re-encoded to strip EXIF (Norwegian traffic photos are taken on phones, which stamp GPS into them), and capped at 2048px on the long edge.
- **Duplicate detection compares perceptual hashes by Hamming distance, not equality.** A dHash is deliberately not stable to the bit — re-encoding moves a couple of comparisons — so an indexed equality lookup would catch only a byte-identical re-upload, which a checksum already does, and miss the case the hash exists for. Candidate fingerprints are compared in memory, which is affordable for ONE deployment's library; the note in `upload.ts` says what to do if a school outgrows it.
- **The quality gate's duplicate check now folds `sourceImageId` into the stem fingerprint.** Image and sign questions share a boilerplate stem by design — "What does this sign mean?" is the right wording for every sign there is — so fingerprinting the stem alone declared the second sign question a duplicate of the first and every one after it. Text questions are unaffected.
- **`sourceImageId` became nullable in the contract, and an image/sign question without a picture is now rejected at the boundary** rather than reaching the quality gate: switching a question back to TEXT must be able to say "no picture" explicitly, and omitting the field would leave the old link in place.
- **Impact:** `sharp` and `@aws-sdk/client-s3` added. `config/school.config.ts` gains a `storage` block (credentials from env only). The MinIO round-trip in spec-06's checklist is still outstanding; `local` is covered by unit and integration tests. `local.ts` carries a `turbopackIgnore` on its runtime path resolution — without it, static analysis traced the whole project, `public/` included, into the server bundle.
- **Approved by:** developer

## 2026-08-24 · spec-00 · Workflow & instruction structure adopted

- **Decision:** Spec-driven workflow formalized in `WORKFLOW.md`; progress tracked in `specs/README.md` status board; approved plans stored in `specs/plans/`; verification evidence in `specs/notes/`; deviations logged here.
- **Why:** Keeps every session resumable, keeps plans and evidence auditable, and keeps specs as stable contracts.
- **Impact:** All specs 01–14 follow the Phase A–D loop. Spec-09's notes path standardized to `specs/notes/spec-09-notes.md`.
- **Approved by:** developer
