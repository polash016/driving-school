# Handoff: Fable → Opus — START HERE

You are picking up TeoriPro after the Fable foundation phase (2026-08-24). Read in this order:
`CLAUDE.md` (auto-loaded) → `WORKFLOW.md` → `docs/architecture.md` → `specs/README.md` (status board) → the plan/brief for your current spec.

## What exists and is DONE (do not rebuild)
- **Spec-01 foundation** ✅ — Next 16 / TS strict / Tailwind v4; `config/school.config.ts` + `config/theme.css` token system (shadcn components already restyled to tokens); next-intl `/en` + `/no` with cookie persistence (`src/proxy.ts`); dark mode (next-themes, class); bilingual error/not-found; Vitest + Playwright (mobile 390px project) + axe. Evidence: `specs/notes/spec-01-notes.md`.
- **Spec-02 schema** ✅ — 24 models, every index commented with its query and EXPLAIN-verified; pgvector HNSW + norwegian tsvector (raw SQL migration); idempotent seed (class B, 32 bilingual topics, default blueprint); ERD `docs/erd.md`. Evidence: `specs/notes/spec-02-notes.md`.
- **Contracts + gateway** ✅ — `src/server/contracts/*` (import these — NEVER invent API shapes); `src/server/ai/client.ts` (the ONLY way to call AI; models from config; versioned prompts in `src/server/ai/prompts/`); `authz.ts`, `errors.ts`, `logger.ts`, `db.ts`, `redis.ts` (central cache-key registry `keys.*`).
- **Spec-07 ENGINE CORE** ✅ (integration pending, yours) — `src/server/services/quiz/`: template expansion, seeded assembly, anti-leak serializer, grading, server-authoritative timer, attempt lifecycle. 66 tests green incl. 8 against real Postgres. Evidence: `specs/notes/spec-07-notes.md`.

## Invariants that must NEVER break (grep-able, tested)
1. Correctness never ships pre-submit: only `serializer.ts` builds client quiz payloads; contracts are `.strict()`. Add the Playwright network assertion in spec-08.
2. Every AI call goes through `aiJson`/`aiEmbed`; no model names or prompts inline; NEVER in a request path.
3. Every boundary parses input AND output with `src/server/contracts` schemas; services never import next/react.
4. All user-facing strings via next-intl (both locales — key-parity test enforces); school values via config; license rules from DB (the engine snapshots them per attempt).
5. Cache keys only via `keys.*`; every cacheSet names its invalidation trigger.

## Your execution order
**03 → 04 → 05 → 06 → 07-integration → 08 → 09 → 10 → 11 → 12 → 13 → 14**
- Detailed plans exist for 03, 05, 06, 12 (`specs/plans/spec-XX-plan.md`) — follow them; get developer approval at session start, then implement.
- Briefs exist for 04, 08, 09, 10, 11, 13, 14 (`spec-XX-brief.md`) — expand each into a full Phase-A plan (WORKFLOW §3) before coding.
- 07-integration items are listed in `specs/plans/spec-07-plan.md` §Deferred + `notes/spec-07-notes.md` §Remaining.
- One spec per session; update the status board at every phase change; every 3rd spec run the compliance review (WORKFLOW Phase D).

## Student UI north star
Homepage around `specs/assets/reference-teorimester-homepage.png`: keep its content/section order, execute it distinctly cleaner, more modern, more user-friendly (WORKFLOW §6 + spec-09 requirements). 390px mobile-first; desktop centered max-w-md.

## Local dev
```
docker compose -f docker-compose.dev.yml up -d   # pgvector @5544, redis @6399
pnpm install && pnpm exec prisma migrate deploy && pnpm exec prisma db seed
pnpm dev            # app
pnpm test           # unit + integration (TEST_DATABASE_URL in .env → teoripro_test)
pnpm e2e            # Playwright (builds + starts on :3100)
```
Auth.js adapter tables arrive with YOUR spec-03 migration. `.env.example` lists required vars; AI vars are optional until spec-05/06.
