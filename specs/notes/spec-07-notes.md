# Verification — Spec 07: Dynamic Quiz Engine — CORE (Fable portion)

Status: **core PASS / integration pending (Opus)** per the approved split (DECISIONS.md 2026-08-24).
Test evidence: 66/66 Vitest tests green (10 files), including 8 integration tests against a real Postgres (`teoripro_test` via `TEST_DATABASE_URL`); lint, `tsc --noEmit`, `next build` clean.

## Checklist items verified NOW (core)

### ✅ Two users same second → different variants, orders, option orders
- `assembly.test.ts`: same seed → byte-identical result; different seeds → different variant sets AND option orders.
- Integration: `u1`/`u2` started at the same fake-clock second → different exams end-to-end through Prisma.

### ✅ Same user cannot receive same contentHash twice within window
- `assembly.test.ts`: seen hashes excluded when pool allows; explicit warnings + reuse only when pool thin; shortfall reported when exhausted.
- Integration: `u3`'s second exam shares zero stems with the first (SeenStore-backed). `RedisSeenStore` (30d sliding sorted set) ships; in-memory port used in tests.

### ✅ Client payload never contains isCorrect (serializer layer)
- `serializer.test.ts`: served-attempt JSON contains no `correctOptionKey` / `isCorrect` / `explanation`; poisoned input rows never reach the wire (whitelist-copy builders); the `.strict()` contracts themselves throw on any extra field (guards future refactors).
- Integration: JSON sweeps on real serve/answer/resume payloads. **Remaining for Opus:** the e2e network-level assertion in Playwright (spec-07 checklist) once routes exist.

### ✅ Grading matches official rules from LicenseClass config
- `grading.test.ts`: fast-check properties (count/partition/order-invariance/monotonicity) + explicit B rules 45/38 boundary cases (37 fail / 38 pass / 45 pass).
- Integration: pass mark read from the attempt's SNAPSHOT (frozen at start); 4/6 vs passMark 4 → passed; re-submit idempotent (no double grading, `onGraded` fired once).

### ✅ Disconnect / reopen on second browser → same question, same remaining time
- Integration: fresh serve after answering + 60s clock advance → same questions, answer restored, `currentPosition` advanced, `timeRemainingSec` exactly `5400−60`. Timer is server-authoritative (`timer.ts`, injectable clock, 30s grace); expiry auto-submits with status EXPIRED and grades answered questions (verified).

## Also verified (beyond checklist)
- Template engine (`template.test.ts`): deterministic expansion, fact-pinned slots (throws on unknown fact key), distinct constraints, duplicate-option and unresolved-placeholder rejection — spec-07 layer 1 complete.
- contentHash canonicalization (presentation-order independent, master-scoped).
- IDOR: foreign attempts read as NotFound (existence not leaked).
- Subtree gathering: blueprint root topics collect items from child topics (integration fixture places r1 items on a child).

## Remaining for Opus (07-integration) — see plans/spec-07-plan.md "Deferred"
Variant cache warmer (BullMQ) + AI surface-variation job + validator chain; Redis pool on the assembly hot path (PrismaVariantSource stays as miss-path); assembly p95 <500ms at 5k pool measurement; tap→first-question <3s Playwright; route handlers wiring `authorize()` → service.
