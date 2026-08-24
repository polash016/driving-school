# Plan — Spec 03: Authentication & Roles (detailed, authored by Fable for Opus)

## Decisions (binding)
- Auth.js v5 (`next-auth@beta`) with **Credentials provider + Prisma adapter**, JWT session strategy (credentials flow can't use DB sessions in Auth.js) — BUT session revocation is required, so: keep a `UserSession` table (id, userId, tokenHash, userAgent, ip, createdAt, lastSeenAt, revokedAt) written on login; the JWT carries `sessionId`; the `jwt` callback checks revocation (cached in Redis `tp:auth:sess:<id>`, TTL 5m, invalidated on revoke). This gives view/revoke active sessions without DB-session strategy.
- Passwords: `argon2id` via `argon2` package — memoryCost 19456 (19 MiB), timeCost 2, parallelism 1 (OWASP baseline; document in SECURITY note).
- 2FA TOTP: `otpauth` package. Secret in `User.totpSecret` (encrypted at rest with `AUTH_SECRET`-derived key). Enforcement: ADMIN cannot complete login without TOTP once provisioned; first ADMIN login forces setup. Optional for INSTRUCTOR.
- Emails: `nodemailer` SMTP transport (Resend-compatible); bilingual templates from i18n messages, rendered server-side. Env: `SMTP_URL`, `EMAIL_FROM`.
- Rate limiting: fixed-window Redis counters via `keys.rateLimit(route, ip)` — 5/min/IP on login, reset-request, register. Central `rateLimit(route, key, limit, windowSec)` helper in `src/server/rate-limit.ts` (spec-12 reuses it).
- Vipps Login: `src/server/auth/vipps-stub.ts` exporting a clearly-marked disabled provider + `featureFlags.vippsLogin` (add to school.config schema, default false).

## Schema delta (new migration; Auth.js adapter tables + additions)
`UserSession` as above; `VerificationToken` (Auth.js shape) for email verify + password reset (single-use, hashed token, expiry). No changes to existing tables.

## Files
- `src/server/auth/{config.ts,index.ts}` (Auth.js setup, callbacks map JWT → `SessionUser` from `src/server/authz.ts`), `password.ts` (argon2 wrappers), `totp.ts`, `invites.ts` (create/validate/consume — atomic `usedCount` increment guarded by `maxUses`/`expiresAt`/`revokedAt`), `sessions.ts` (list/revoke).
- Routes: `src/app/[locale]/(auth)/{login,register,forgot-password,reset-password,verify-email}/page.tsx` — mobile-first 390px, tokens only, bilingual; server actions parse `contracts/auth.ts` schemas (already written — import, don't reinvent).
- Middleware/proxy: keep next-intl proxy; protect route groups in layouts via `authorize()` server-side (NOT middleware-only).
- Admin invite UI is spec-11; spec-03 ships the service + a minimal admin action to create invites (used by tests).
- Audit: `auditLog()` helper (`src/server/audit.ts`) — auth.login/logout/failed, invite.created/used, password.reset, session.revoked, 2fa.enabled.

## Acceptance → tests
- Playwright: invite → register → verify-email (intercept email via test SMTP inbox or token capture in dev mode) → login → student dashboard; wrong-role access to `/admin` → bilingual 403 page.
- `authorize()` coverage: unit tests + grep in verification notes; every protected server action calls it first (spec-12 later automates the inventory).
- Rate limit: vitest against Redis — 6th login attempt within a minute → `RateLimitError`; audit rows written.
- Argon2 params asserted in a unit test (hash metadata parse).

## Pitfalls
- Never return different errors for "email exists" vs "wrong password" (user enumeration).
- Invite consumption must be transactional (concurrent registrations on a maxUses link).
- All auth pages must work at 390px with keyboard only; error states bilingual via `errors.*` keys.
