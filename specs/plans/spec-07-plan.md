# Plan — Spec 07: Dynamic Quiz Engine — CORE (Fable) / INTEGRATION (Opus)

**Status:** approved via master plan (DECISIONS.md 2026-08-24). Split: Fable builds the deterministic core with exhaustive tests; Opus wires the AI variation job, Redis pool warmer (BullMQ), routes/UI, and the <3s end-to-end Playwright gate.

## Core modules — `src/server/services/quiz/` (framework-agnostic, no next/react imports)

| Module | Responsibility |
|---|---|
| `rng.ts` | Seeded deterministic RNG (string seed → mulberry32) + Fisher-Yates shuffle. Pure. |
| `content-hash.ts` | Canonical serialization of variant content → sha256 contentHash. Pure. |
| `template.ts` | parameterSlots expansion: slot kinds `choice` (bilingual-paired), `number`, `fact` (pinned to facts table value); `distinct` constraints; deterministic combo enumeration (capped); placeholder/options/correct-key validation. Facts are INPUT (caller loads them) — module stays pure. |
| `grading.ts` | Pure grading: answers + correct keys + passMark → correctCount/passed/topic breakdown. Property-based tests (fast-check). |
| `timer.ts` | Server-authoritative expiry math with injectable clock. Pure. |
| `assembly.ts` | Pure assembly: blueprint distribution + imageRatio + per-topic candidate pools + seen-hash set + seed → questions with per-attempt shuffled option order. Guarantees: no repeated masterItem per attempt; unseen-first with explicit warnings on fallback; largest-remainder image allocation; deterministic under seed. |
| `serializer.ts` | THE anti-leak boundary: all client DTOs built here and runtime-parsed through the `.strict()` schemas in contracts/quiz.ts (structural + runtime double lock). |
| `ports.ts` | `VariantSource`, `SeenStore`, `Clock` interfaces + in-memory impls for tests. |
| `redis-adapters.ts` | `RedisSeenStore` (sorted set, 30d window, trimmed) using the central key registry. |
| `attempt-service.ts` | Orchestration on Prisma: startQuiz (snapshots class config into the attempt; transaction), serve/resume (expiry auto-submit first), idempotent answer autosave (PRACTICE grades per-question server-side), flag, submit (grade, breakdown, idempotent re-submit returns stored result). |

## Test plan → checklist mapping
- Determinism/divergence: same seed → identical assembly; two users same second different seeds → different variants/order/option order ✅ unit.
- No-repeat window: seen hashes excluded; second attempt shares zero hashes given ample pool ✅ unit + integration.
- Anti-leak: serialized attempt JSON contains no `isCorrect`/`correctOptionKey`/explanation pre-submit ✅ serializer tests + integration stringify sweep (e2e network assertion = Opus).
- Grading vs class config incl. B 45/38: property tests (fast-check) + fixture exam ✅.
- Resume cross-device: serve twice → identical questions/answers/remaining time (fake clock) ✅ integration.
- Expiry auto-submits ✅ integration with clock injection.
- Integration tests run against a real Postgres (`teoripro_test` DB on the dev container, migrated via `prisma migrate deploy`), gated on `TEST_DATABASE_URL`.

## Deferred to Opus (07-integration)
BullMQ variant warmer + AI surface-variation job (via `aiJson` + `surfaceVariationPrompt`, validator chain per `validatorReportSchema`), Redis pool consumption, assembly p95 <500ms measurement at 5k pool, tap→question <3s Playwright, route handlers.
