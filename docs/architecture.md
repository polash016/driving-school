# TeoriPro — Architecture Blueprint

**Authority:** decisions in this document are binding for all specs. Written by Fable (2026-08-24) as part of the approved master plan; deviations require a `DECISIONS.md` entry. Opus: read this fully before implementing any spec.

---

## 1. System overview

Single-instance deployment per school. One Next.js app (App Router) + one worker process sharing the same codebase, one PostgreSQL (with pgvector), one Redis (cache + BullMQ). All AI calls leave through one gateway to OmniRoute.

```
Browser ── RSC/route handlers ──▶ contracts (Zod) ──▶ services ──▶ Prisma ──▶ Postgres
                 │                                      │    │
                 │  (reads)                             │    └──▶ Redis cache
                 └───────────◀ typed client DTOs ◀──────┘
Worker (BullMQ) ──▶ same services + src/server/ai ──▶ OmniRoute
```

## 2. Module map & layering rule

```
src/
  app/[locale]/(student)/…      # student routes: mobile-first 390px
  app/[locale]/(admin)/…        # admin/instructor routes: desktop-first
  app/api/…                     # route handlers (thin: parse → authorize → service → serialize)
  components/ui/…               # shadcn base components restyled to tokens
  components/<feature>/…        # feature components
  server/
    contracts/                  # Zod input/output schemas — THE api surface (Fable-authored)
    services/                   # framework-agnostic business logic (NO next/*, NO react imports)
    ai/                         # gateway client, prompts/, pipeline jobs
    queues/                     # BullMQ queue + worker definitions
    db.ts                       # Prisma client singleton
    redis.ts                    # ioredis singleton + cache helpers
    authz.ts                    # authorize() chokepoint
  lib/                          # pure utils (shared client/server where safe)
  i18n/                         # next-intl config + messages/en.json, messages/nb.json
config/
  school.config.ts              # ALL school-specific values
  theme.css                     # ALL design tokens
prisma/                         # schema, migrations, seed
```

**The layering rule (non-negotiable):** route/RSC → contract (Zod parse) → service → Prisma. 
- Routes never contain business logic and never call Prisma directly.
- Services never import from `next/*` or React — a future mobile API consumes them unchanged.
- Every service function: input validated by a contract schema at the boundary, output shaped by a contract schema (this is also the anti-leak mechanism, §7).

## 3. Config injection

- `config/school.config.ts` exports a typed, `Object.freeze`d `schoolConfig`. Server code imports it directly; client components receive only the values they need via a `ConfigProvider` fed from the root layout (never the whole object — it may hold policy values not for the client).
- Runtime-changeable policies (exam cooldowns, focus-loss policy, pass-guarantee criteria) live in the DB `Setting` table (spec-11) with audit log — `school.config.ts` holds only deploy-time identity/theme/feature-flags.
- License-class parameters always come from the `LicenseClass` DB row, never from config or literals.

## 4. i18n architecture

- next-intl, locales `en` (default) + `nb`; URL prefixes `/en` and `/no` (`localePrefix.prefixes: { nb: '/no' }`). Cookie `NEXT_LOCALE` persists choice; middleware handles negotiation.
- Message files: `src/i18n/messages/{en,nb}.json`, namespaced per feature (`home.*`, `exam.*`, `admin.*`, `errors.*`). A key added to one locale MUST be added to both — CI check compares key sets.
- DB content (questions, topics, signs) is bilingual JSON `{ en: …, nb: … }`; a single `pickLocale(content, locale)` helper in `src/lib/i18n-content.ts` resolves it (fallback `nb → en`, log missing).
- Bilingual emails and error messages come from the same message files (server-side `getTranslations`).

## 5. Caching architecture (Redis)

Key scheme: `tp:<domain>:<entity>:<id>[:<qualifier>]` — all keys go through typed helpers in `src/server/redis.ts` (`cacheGet/cacheSet/cacheDel` with JSON + TTL). Never hand-write key strings at call sites.

| Key | Holds | TTL | Invalidated by |
|---|---|---|---|
| `tp:quiz:pool:<masterItemId>:<locale>` | list of ready variant ids | none (set-managed) | warmer add / assembly consume / item retire |
| `tp:quiz:seen:<userId>` | recent contentHashes (sorted set, window) | 30d sliding | trimmed on write |
| `tp:dash:agg:<userId>` | dashboard aggregate (stats, mastery, history page 1) | 24h | exam submit, homework change (explicit `cacheDel`) |
| `tp:kb:facts` | facts table snapshot | 1h | fact edit |
| `tp:cfg:settings` | DB Setting rows | 5m | settings save |
| `tp:rl:<route>:<key>` | rate-limit counters | window-sized | expiry |

Rules: cache is read-through (miss → service computes → set). Every `cacheSet` call site must name its invalidation trigger in a comment. No cache on write paths. Attempt state (answers, timer) is **never** cached — Postgres is the source of truth for exams.

## 6. Queue topology (BullMQ)

Queues: `ai-vision` (image context sheets), `ai-generation` (candidate items), `variant-warmer` (surface variation top-up), `emails`. One worker process (`src/server/queues/worker.ts`) registers all processors; deployed as a separate container (spec-14).

Rules:
- **Idempotency:** every job carries a deterministic `jobId` (e.g. `vision:<imageId>:<promptVersion>`); processors are safe to re-run (upsert semantics, check-before-write).
- Retries: exponential backoff, max 3; failures land in a dead-letter list surfaced in admin job-status UI (spec-06).
- **Cost guard:** `ai-generation`/`variant-warmer` check a Redis day-budget counter (`tp:ai:spend:<yyyy-mm-dd>`) before each AI call; over budget → queue paused + admin banner. Budget from config.
- No LLM call ever happens in a request path. Request paths only read warmed pools (spec-07 hard rule).

## 7. Security invariants

1. **Anti-leak DTO pattern (the invariant):** correct answers, explanations, and validator internals exist only in server types. Client-bound payloads are produced exclusively by serializers in `src/server/contracts/quiz.ts` whose Zod output schemas *structurally lack* `isCorrect`/`explanation` (pre-submit) — `.strict()` schemas, so an accidental extra field throws in dev/test. A serializer unit test + an e2e network assertion guard this forever.
2. **`authorize()` chokepoint:** `src/server/authz.ts` exports `authorize(session, role | policy)`; every protected route handler/server action calls it first. No inline role checks. A route-inventory test (spec-12) fails on any route not registering its auth level.
3. Grading is server-side only; practice-mode per-question grading is a server round trip (spec-07).
4. Exam images: signed short-TTL URLs + per-user watermark (spec-12). Original uploads EXIF-stripped at ingest (spec-06).
5. Zod on every boundary: parse inputs AND outputs. Unparsed `any` crossing a boundary is a review-blocking defect.

## 8. Error taxonomy

`src/lib/errors.ts`: `AppError` base (code, httpStatus, i18n messageKey, `meta` for logs) with subclasses `ValidationError`, `AuthError`, `ForbiddenError`, `NotFoundError`, `ConflictError`, `RateLimitError`, `AiPipelineError`, `ExamStateError`. Route handlers map `AppError → { code, message: t(messageKey) }` (bilingual, user-safe); full detail + stack goes to structured logs only (pino, `src/lib/logger.ts`). Unknown errors → generic `errors.internal` message, never raw messages to clients.

## 9. Testing strategy

| Layer | Tool | What must be covered |
|---|---|---|
| services (esp. `services/quiz/*`) | Vitest (+ fast-check for grading/assembly properties) | exhaustive — the engine is the product |
| contracts | Vitest | serializer anti-leak tests; schema round-trips |
| routes | Vitest + supertest-style handler invocation | authorize() coverage, error mapping |
| flows (exam, auth, offline) | Playwright | keyboard-only exam, resume, locale switch, network assertion for anti-leak |
| DB | EXPLAIN checks in verification notes | hottest queries use their named index |

Determinism: all randomness flows through the injected seeded RNG (`src/server/services/quiz/rng.ts`); tests pin seeds. Time flows through an injectable `clock` — no bare `Date.now()` in services.

## 10. Student-panel design direction (specs 08–10)

Reference: `specs/assets/reference-teorimester-homepage.png`. Keep its **content and vertical order** (header/logo/language → quick-start tiles → headline stats → "How I'm doing" mastery → previous tests → account/footer). Execute it **distinctly cleaner, more modern, more user-friendly**:
- Token surfaces (no flat gray boxes), 12–16px radii, soft elevation, 4pt-grid whitespace, one accent color for actions; green = success only, red = genuine failure only.
- 390px design target, `max-w-md` centered on desktop; 44px touch targets; skeletons not spinners; transform/opacity animations only.
- Typography: one variable sans (subset incl. æøå), clear hierarchy — numbers big (stats), labels quiet.
Full requirements: spec-09.

## 11. Performance budgets (recap, enforced in specs 07/13)

p95 reads <150ms, writes <300ms; quiz assembly p95 <500ms server-side; tap→first question <3s; exam route JS <150KB gz; interactions <100ms perceived; Lighthouse mobile Perf ≥90 / A11y ≥95.
