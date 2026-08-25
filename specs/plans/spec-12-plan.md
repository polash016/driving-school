# Plan — Spec 12: Security Hardening & Anti-Cheat (detailed, authored by Fable for Opus)

## Decisions (binding)

- **Route inventory as code**: `src/server/route-manifest.ts` — every API route/server action registers `{ path, authLevel: Role|"PUBLIC", rateLimit: {limit, windowSec} }`. A vitest walks `src/app/**/route.ts` + server-action files and FAILS on any handler not in the manifest. Handlers read their own manifest entry to apply `authorize()` + `rateLimit()` — single source of truth, no drift.
- Security headers in `next.config.ts` `headers()`: CSP **without unsafe-inline** (nonce-based scripts — Next 16 supports nonce via middleware/proxy; hash Tailwind's inline styles are not needed since Tailwind emits a stylesheet), `strict-transport-security`, `frame-ancestors 'none'`, `referrer-policy: strict-origin-when-cross-origin`, `permissions-policy` minimal.
- Signed image URLs: HMAC(`AUTH_SECRET`) over `imageId|userId|exp` as query params on `/api/images/[id]`; TTL 5 min; verify + stream. Watermark: `sharp` composite of a diagonal translucent SVG (`user.email` short-hash tiled), cached per `(imageId,userId)` in `storage/watermarked/` (LRU cleanup) — serve time <50ms cached.
- Print CSS: `@media print { .exam-route * { display: none } }` + `beforeprint` logging on exam routes.
- Anomaly flagging: on submit, compute median `timeSpentMs` (answered questions); if median < 1500ms AND correctCount/questionCount > 0.8 → `anomalyFlagged = true` + AuditLog; instructor sees a badge (spec-11 hook). Thresholds from Settings (runtime-editable).
- Attempt cooldowns: `Setting` key `exam.cooldownMin` checked in `startQuiz` route wrapper (service stays pure; policy in route layer or a thin policy service).
- GDPR: `src/server/services/gdpr.ts` — export (all user rows as JSON zip) + deletion (anonymize: email → `deleted-<id>@anonymized.local`, null profile PII/passwordHash/totpSecret, set `deletedAt`, keep attempts/mastery for aggregates). Both behind ADMIN `authorize()` + audit. `SECURITY.md` documents the data map (every table with PII columns listed).
- Env validation at boot: extend `src/lib/env.ts` required set (AUTH_SECRET, SMTP_URL in prod); build-time client-bundle secret check: vitest greps `.next/static` for env values? — decision: use `@next/env`-safe pattern + a build script grepping the client chunks for `AUTH_SECRET|OMNIROUTE_API_KEY|DATABASE_URL` values, failing CI on hit.
- Focus-loss policy: exam UI (spec-08) logs `focusLossCount`; policy from Settings: `warn` (default) shows bilingual warning toast, `log` silent, `autosubmit` calls submit after N=3 (threshold in Settings).

## Acceptance → tests

- Route-inventory vitest (fails on unlisted route) — the core deliverable.
- IDOR matrix: Playwright/vitest hitting attempt/answers/dashboard endpoints as другой user + each role → 403/404 (engine already returns NotFound for foreign attempts — keep route layer consistent).
- Image URL expiry test (time-travel HMAC), watermark visual snapshot (Playwright screenshot contains per-user hash text).
- Deletion drill: create user with attempts → delete → PII gone (SQL assertions), aggregate counts unchanged.

## Pitfalls

- CSP nonce must flow through the locale layout — verify no inline script regressions (next-themes injects one: use its nonce prop).
- Do not rate-limit `serveAttempt` so hard that exam autosave breaks (answer autosave needs ~1 req/s headroom per active student).
- Watermark cache invalidation on image replace (keyed by imageId hash → replace = new id, so safe).
