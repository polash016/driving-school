# Spec 07 — Dynamic Quiz Engine (THE CORE — use Fable for planning)

## Objective
Leak-proof, instant, unique exams. Three layers: parameterized templates → AI surface variation → blueprint assembly.

## In scope
- Template engine: MasterItem parameterSlots (numbers, sign refs, actors) with constraint rules; deterministic expansion respecting facts table; expansion validator.
- Variant cache warmer (BullMQ, off-peak): keep ≥K validated variants per (masterItem, locale) in pool; AI surface-variation job (reword phrasing/distractors, preserve concept) → validator chain → ItemVariant with contentHash.
- Assembly service `assembleQuiz({userId, mode, licenseClass|topicIds, seed})`: samples per blueprint (topic counts + imageRatio for mixed mock exams), excludes variants this user saw within window (contentHash history), shuffles options, returns question payloads WITHOUT correct answers.
- Attempt lifecycle: create → serve → answer autosave (every answer, idempotent) → resume (server state, cross-device) → submit → server-side grading → results with per-topic breakdown and explanations+citations (revealed only after submit; in PRACTICE mode graded per-question server-side with immediate explanation response).
- Timer server-authoritative (submittedAt vs startedAt + grace); expiry auto-submits.
- **Instant start (<3s hard requirement):** assembly reads only from warmed cache; if pool thin, top up synchronously from template expansion (no live LLM call in request path — ever). Log assembly time.

## Acceptance checklist
- [ ] Two users same second → different variants, orders, option orders (test with fixed seeds).
- [ ] Same user cannot receive same contentHash twice within window (test).
- [ ] Client payload never contains isCorrect (serializer test + e2e network assertion).
- [ ] Assembly p95 <500ms server-side with 5k-variant pool; end-to-end tap→first question <3s (Playwright).
- [ ] Disconnect mid-exam, reopen on second browser → resumes at same question with same remaining time.
- [ ] Grading matches official rules from LicenseClass config (property-based tests incl. B: 45/38/90min).
