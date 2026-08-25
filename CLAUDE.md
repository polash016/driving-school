# CLAUDE.md — TeoriPro Project System Prompt
> Place this file at the repo root. Claude Code reads it automatically on every session.

## What this project is
TeoriPro: an AI-powered quiz & mock-exam platform for a Norwegian driving school, preparing students for the official Statens vegvesen theory test (teoriprøven, Class B: 45 questions / 90 min / pass at 38). Single-instance deployment per school (NOT shared multi-tenant SaaS): one codebase, each school gets its own deployment, database, domain, and theme. Bilingual UI: English (primary) + Norwegian Bokmål.

## Non-negotiable engineering mandates
1. **Smoothness is a feature.** Every interaction must feel instant: optimistic UI updates, skeleton loaders (never spinners on navigation), prefetch next question during current question, view transitions, 60fps animations (transform/opacity only, never layout-thrashing properties). Any interaction >100ms perceived latency is a bug.
2. **Queries must be as fast as possible.** Every DB query goes through Prisma with explicit `select` (never fetch unneeded columns). Every list query is paginated. Every frequent read path has an index — when you write a query, state which index serves it. N+1 queries are forbidden; use `include`/joins or batched loaders. Hot reads (question serving, dashboard stats) are cached in Redis with explicit invalidation. Target: p95 API response <150ms for reads, <300ms for writes.
3. **Solid features over many features.** A feature is DONE only when: happy path + error states + empty states + loading states + offline behavior + mobile layout + keyboard navigation + both languages all work. Never mark a task complete with TODOs in user-facing paths.
4. **Future proof.**
   - All school-specific values live in `config/school.config.ts` + theme tokens in `config/theme.css` — NEVER hardcode school name, colors, logo, domain, or policy values in components.
   - All user-facing strings go through the i18n layer (`next-intl`) — NEVER hardcode display text, not even temporarily.
   - License-class parameters (question count, time limit, pass mark) come from DB config — never hardcode "45" or "38".
   - Business logic lives in framework-agnostic service modules (`src/server/services/`) so a future mobile app can consume the same API.
   - Every AI call goes through one gateway module (`src/server/ai/client.ts`) pointing at the OmniRoute endpoint — model names are config, never inline strings.

## Current UI iteration rule
Student panel (all student-facing routes): mobile-first, 390px design target, must be flawless on phones; desktop renders as centered max-w-md. The student homepage is built AROUND the reference image `specs/assets/reference-teorimester-homepage.png` (details: specs/spec-09): keep its content and vertical section structure, but the visual design must be distinctly cleaner, more modern, and more user-friendly than the reference — a structural reference, never a pixel-copy. View the image before planning any student-facing UI spec. Admin/instructor panel: desktop-first responsive.

## Stack (do not deviate without asking)
- Next.js 15+ App Router, TypeScript strict, React Server Components by default, client components only when interactive.
- PostgreSQL + Prisma. Redis (ioredis) + BullMQ for caches/queues/AI jobs.
- next-intl (i18n), Auth.js (auth), Tailwind + design tokens from `theme.css`, shadcn/ui as base components restyled to our token system.
- Zod on EVERY API boundary (input AND output). tRPC or route handlers with typed contracts.
- Vitest (unit), Playwright (e2e for exam flows). Test the exam engine exhaustively — it is the product.

## Code conventions
- File structure: `src/app` (routes) / `src/components` (ui, feature folders) / `src/server/services` (business logic) / `src/server/ai` (AI pipelines) / `src/lib` (utils) / `prisma/` / `config/`.
- Server-side validation is the only validation that counts; client validation is UX sugar.
- Correct answers NEVER ship to the client before submission. Grade server-side only. Treat this as a security invariant — flag any code that violates it.
- Every migration is reversible. Never `prisma db push` against anything but local dev.
- Errors: typed error classes, user-safe messages (bilingual), full detail to logs only.
- Accessibility: WCAG 2.1 AA is Norwegian law (universell utforming). Focus rings, ARIA, 44px targets, keyboard paths — in every component, not a cleanup pass.

## Spec-driven workflow
The full process lives in `WORKFLOW.md` — read it (plus the status board `specs/README.md`) at the start of every working session. The contract in brief:
- Work ONLY from the current spec file in `/specs`. `specs/README.md` is the status board — the single source of truth for progress; update it at every phase change.
- Per spec: read the spec fully (and view any referenced images) → written plan via plan mode (files to create/change, schema changes with indexes, Zod API contracts, i18n keys, caching, UI states, test plan) → wait for explicit approval → save the plan to `specs/plans/spec-XX-plan.md` → implement with tests alongside → verify the spec's acceptance checklist item-by-item with evidence into `specs/notes/spec-XX-notes.md`.
- No code before an approved plan. No "done" with open FAILs or TODOs in user-facing paths.
- Approved deviations from a spec or plan are logged in `DECISIONS.md` at the moment of approval.
- Do not start the next spec until the current one's checklist fully passes. If a spec conflicts with this file, this file wins — raise the conflict.

## Repo instruction files
`CLAUDE.md` (mandates — this file) · `WORKFLOW.md` (process) · `specs/README.md` (index + status board) · `specs/spec-XX-*.md` (contracts) · `specs/assets/` (reference images) · `specs/plans/` (approved plans) · `specs/notes/` (verification evidence) · `DECISIONS.md` (approved deviations log).

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
