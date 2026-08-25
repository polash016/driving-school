# Plan — Spec 03: Authentication & Roles (approved 2026-08-24)

> Supersedes the Fable draft of this file (kept in git history). Approved by the developer in the
> spec-03 planning session; the ten binding decisions below are logged in `DECISIONS.md`.

## Context

TeoriPro has a foundation (spec-01), a full schema (spec-02), Zod contracts + AI gateway, and a verified
quiz engine core (spec-07) — but **no identity**. Every downstream spec is blocked on it: the engine's
`startQuiz(userId, …)` has no user, `authorize()` in `src/server/authz.ts` has no session to decide on,
and there is no way for a school to onboard a student.

Spec-03 delivers exactly that: password login with argon2id, invite-only student onboarding (links + CSV),
email verification and reset, mandatory TOTP for ADMIN, session view/revoke, per-IP rate limiting, and
audit rows for every auth event. Outcome: `authorize()` becomes real, protected route groups exist for
specs 04/08–11 to hang pages on, and a school owner can onboard a class end-to-end.

---

## 1. Binding decisions

| #   | Decision                                                                                                                                                                                                                                    | Rationale                                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Auth.js v5 (`next-auth@beta`, credentials-only, JWT strategy) — no Prisma adapter.** Own tables `UserSession` + `AuthToken`. Adapter + `Account` arrive with the Vipps/OIDC spec.                                                         | With credentials there is no DB-session strategy; adapter tables would sit empty and duplicate our hashed-token flow. Deviates from the Fable draft and `schema.prisma:3`.                                                                                           |
| D2  | **Auth.js is cookie/JWT plumbing only. Login logic lives in our service** (`verifyCredentials`), which issues a **one-time Redis login ticket**; the Credentials provider consumes it (GETDEL, 60 s TTL) and mints the session.             | Typed bilingual errors we control (wrong password / unverified / TOTP required / rate-limited) instead of Auth.js beta's `CredentialsSignin` code plumbing; password verified exactly once. Ticket never leaves the server (action → `signIn` are both server-side). |
| D3  | **Session revocation without DB sessions:** JWT carries `sid`; `UserSession` row per login; `jwt` callback checks validity through Redis `tp:auth:sess:<sid>` (TTL 5 m) — revoke does `cacheDel` so it takes effect immediately.            | Meets "view/revoke active sessions" while keeping the credentials-mandated JWT strategy. Adds one Redis GET (<1 ms) per request.                                                                                                                                     |
| D4  | **`@node-rs/argon2`** (prebuilt N-API binaries), argon2id, **m=19456 (19 MiB), t=2, p=1** (OWASP baseline). `serverExternalPackages: ["@node-rs/argon2"]`.                                                                                  | Same algorithm/params as the `argon2` package without node-gyp at install and in the spec-14 container build.                                                                                                                                                        |
| D5  | **Admin surface:** full invite + CSV services **plus one minimal `/admin/invites` page** (create/copy/revoke, CSV upload with per-row results). Spec-11 restyles and expands.                                                               | Onboarding is usable and e2e-testable now; without it nobody can create a student until spec-11.                                                                                                                                                                     |
| D6  | **`experimental.authInterrupts: true`** → `forbidden()` / `unauthorized()` + `forbidden.tsx` / `unauthorized.tsx`.                                                                                                                          | Real 403/401 status codes, so the acceptance test asserts status, not just text. Fallback if the flag misbehaves: render the same bilingual 403 view from the layout at HTTP 200 (documented in notes).                                                              |
| D7  | **2FA recovery = `pnpm auth:reset-2fa <email>` CLI** (clears `totpSecret`, audit row, forces setup at next login). Recovery codes → spec-12 follow-up.                                                                                      | Single-instance-per-school deployment: the owner has server access. Avoids a table + display/regenerate UI in this spec.                                                                                                                                             |
| D8  | **Email sent inline through a `MailTransport` port** (`smtp` via nodemailer / `capture` in dev+test); the BullMQ `emails` queue swaps in behind the same port in spec-06 when the worker exists. Mailpit added to `docker-compose.dev.yml`. | No worker process exists yet (spec-06 introduces BullMQ). Port keeps the swap a one-file change.                                                                                                                                                                     |
| D9  | **Business logic in `src/server/services/auth/*`** (framework-agnostic, no `next/*`); `src/server/auth/*` holds only Auth.js/Next wiring.                                                                                                   | Architecture §2 layering rule; the Fable draft put both under `src/server/auth/`.                                                                                                                                                                                    |
| D10 | **`InviteLink.maxUses` semantics:** `null` = unlimited, `1` = single-use; the create service maps an omitted `maxUses` → `1`. Fixes the contradictory comment at `schema.prisma:202` vs `contracts/auth.ts:40`.                             | One reading, enforced in one place, asserted by a test.                                                                                                                                                                                                              |

---

## 2. Schema delta (one reversible migration)

```prisma
enum AuthTokenType { EMAIL_VERIFY  PASSWORD_RESET }

model UserSession {                       // login sessions; JWT carries this id as `sid`
  id         String    @id @default(cuid())
  userId     String
  userAgent  String?
  ip         String?
  createdAt  DateTime  @default(now())
  lastSeenAt DateTime  @default(now())
  revokedAt  DateTime?
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, revokedAt])            // security page: "my active sessions"
  @@index([lastSeenAt])                   // stale-session sweep (cron, spec-14)
}

model AuthToken {                         // email verification + password reset
  id         String        @id @default(cuid())
  tokenHash  String        @unique        // sha256(token); plaintext exists only in the email
  type       AuthTokenType
  userId     String
  expiresAt  DateTime
  consumedAt DateTime?
  createdAt  DateTime      @default(now())
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, type, consumedAt])     // invalidate a user's outstanding tokens on reset/verify
  @@index([expiresAt])                    // expiry sweep
}
```

Additions to existing models (no data migration needed):

- `User.totpSecret` — already present; **non-null ⇒ 2FA active** (pending secrets live in Redis during setup, never in the DB).
- `InviteLink.email String?` — when set, registration must use this address (CSV/individual invites bind the recipient; group links leave it null). New `@@index([createdById, createdAt(sort: Desc)])` serves the admin invite list (spec-11 reuses it).
- Back-relations `User.sessions` / `User.authTokens`.

**Index → query map** (verified with `EXPLAIN` in Phase C): `User.email` unique → login lookup ·
`InviteLink.token` unique → invite validation · `AuthToken.tokenHash` unique → verify/reset lookup ·
`UserSession(userId, revokedAt)` → sessions list · `AuditLog(actorId, createdAt)` → per-user auth trail.

---

## 3. Files

**Auth wiring (Next/Auth.js only)**

- `src/server/auth/config.ts` — NextAuth config: Credentials provider (consumes the login ticket), `jwt`/`session` callbacks (`sub`, `role`, `sid`; revocation check), `pages.signIn`, secure cookies.
- `src/server/auth/index.ts` — `{ handlers, auth, signIn, signOut }` + `getSessionUser(): Promise<SessionUser|null>`.
- `src/server/auth/require-user.ts` — `requireUser(role?)` for RSC layouts/actions: `authorize(await getSessionUser(), role)`, mapping `AuthError → unauthorized()` and `ForbiddenError → forbidden()`. **The only place `authorize()` is called from Next code.**
- `src/app/api/auth/[...nextauth]/route.ts` — Auth.js handlers (already excluded from the intl proxy matcher).

**Services (framework-agnostic, Zod in/out)** — `src/server/services/auth/`
`credentials.ts` (verify + ticket issue/consume) · `registration.ts` (invite → user, transactional) ·
`invites.ts` (create/list/revoke/consume) · `csv-import.ts` · `email-verification.ts` · `password-reset.ts` ·
`password.ts` (hash/verify/policy) · `totp.ts` (generate/confirm/verify, ±1 step window) ·
`sessions.ts` (list/revoke/revokeAll/touch) · `crypto.ts` (HKDF from `AUTH_SECRET`, AES-256-GCM for `totpSecret`, sha256 token hash, base64url token gen).

**Shared server infrastructure (spec-11/12 reuse these)**

- `src/server/rate-limit.ts` — `rateLimit(route, key, limit, windowSec)`; fixed window via `keys.rateLimit`; throws `RateLimitError`; **fails open with a warn log if Redis is down**.
- `src/server/audit.ts` — `auditLog({ actorId, action, entityType, entityId, meta, ip, userAgent })`.
- `src/server/http/request-context.ts` — `clientIp()` / `userAgent()` from `headers()`.
- `src/server/email/{mailer.ts,transports.ts,templates.ts}` — `MailTransport` port; bilingual templates rendered with `createTranslator` from `next-intl` core (not `next-intl/server`).
- `src/lib/csv.ts` — small RFC-4180 parser (no new dependency), unit-tested.

**Routes & UI** (`(auth)` public · `(account)` STUDENT+ · `(admin)` ADMIN)

- `src/app/[locale]/(auth)/{login,register,forgot-password,reset-password,verify-email,two-factor}/page.tsx` + `layout.tsx` + `actions.ts`.
- `src/app/[locale]/(account)/account/security/page.tsx` — change password, 2FA setup (otpauth URI + QR), active sessions list/revoke.
- `src/app/[locale]/(admin)/admin/invites/page.tsx` + `actions.ts`; `(admin)/layout.tsx` calls `requireUser("ADMIN")`.
- `src/app/[locale]/{forbidden,unauthorized}.tsx` — bilingual 403/401 boundaries.
- `src/components/auth/*` — client form components (`useActionState`, inline + form-level errors, pending buttons); `site-header.tsx` gains an account/log-out affordance.

**Config / scripts / infra**
`next.config.ts` (`experimental.authInterrupts`, `serverExternalPackages`) · `src/lib/env.ts` (`AUTH_SECRET`, `APP_BASE_URL`, `SMTP_URL?`, `EMAIL_FROM`, `MAIL_TRANSPORT`) · `.env.example` ·
`docker-compose.dev.yml` (mailpit) · `scripts/{create-admin.ts,reset-2fa.ts}` + `pnpm auth:create-admin` / `auth:reset-2fa` · deps: `next-auth@beta`, `@node-rs/argon2`, `otpauth`, `nodemailer`, `qrcode`.

---

## 4. Contracts (`src/server/contracts/auth.ts` — extend, never re-invent)

Already there and used as-is: `registerViaInviteInput`, `loginInput`, `requestPasswordResetInput`,
`resetPasswordInput`, `createInviteInput`, `invite`, `csvImportRow`, `sessionInfo`, `password` (min 10).

New (all `.strict()`, input **and** output):
`verifyEmailInput {token}` · `changePasswordInput {currentPassword, newPassword}` ·
`totpSetup` (out) `{secret, otpauthUri, qrDataUrl}` · `confirmTotpInput {code}` ·
`revokeSessionInput {sessionId}` · `csvImportResult` (out) `{created, skipped, rows:[{email, status, messageKey}]}` ·
`sessionUser` (out) `{id, email, role}` · `actionResult` (out, in `contracts/common.ts`)
`{ok:true, data?} | {ok:false, code, messageKey, fieldErrors?}`.

Server actions return `actionResult` only; `AppError.meta` never crosses the boundary.

---

## 5. Redis (mandate 5 — every key via `keys.*`, every set names its invalidation)

| Key (new helper in `src/server/redis.ts`)        | Holds                                       | TTL    | Invalidated by                                  |
| ------------------------------------------------ | ------------------------------------------- | ------ | ----------------------------------------------- |
| `keys.authSession(sid)` `tp:auth:sess:<sid>`     | session-valid flag                          | 300 s  | `cacheDel` on revoke / logout / password change |
| `keys.authTicket(id)` `tp:auth:ticket:<id>`      | one-time login ticket `{userId, sessionId}` | 60 s   | GETDEL on consume                               |
| `keys.authSeen(sid)` `tp:auth:seen:<sid>`        | `lastSeenAt` write throttle (SET NX EX)     | 300 s  | expiry                                          |
| `keys.totpSetup(userId)` `tp:auth:totp:<userId>` | pending (unconfirmed) TOTP secret           | 600 s  | confirm / expiry                                |
| `keys.rateLimit(route, key)` (exists)            | fixed-window counters                       | window | expiry                                          |

**Rate limits:** login 5/min/IP + 10/15 min per email-hash · register 5/min/IP · forgot-password 5/min/IP +
3/h per email-hash · reset + verify 10/min/IP · TOTP verify 5/min/user. Email keys are hashed.

---

## 6. i18n (both `en.json` and `nb.json` — the key-parity test fails otherwise)

New namespaces: `auth.login.*`, `auth.register.*`, `auth.forgot.*`, `auth.reset.*`, `auth.verify.*`,
`auth.twoFactor.*`, `auth.account.*` (password / 2FA / sessions), `auth.errors.*`
(`invalidCredentials`, `emailNotVerified`, `totpRequired`, `totpInvalid`, `inviteInvalid`, `inviteExpired`,
`inviteUsed`, `inviteEmailMismatch`, `tokenInvalid`, `tokenExpired`, `passwordTooShort`, `passwordTooCommon`,
`passwordSameAsEmail`), `admin.invites.*`, `emails.*`, plus `errors.forbidden*` / `errors.unauthorized*`
for the new boundaries. No user-facing string outside these files, emails included.

---

## 7. UI states, a11y, mobile

390 px design target, desktop centered `max-w-md`, token surfaces, 12–16 px radii, 44 px targets
(admin invites page is desktop-first).

- **Loading:** pending state on submit via `useActionState` — no spinners on navigation.
- **Empty:** sessions list with only the current session; CSV import with zero valid rows.
- **Error:** inline field errors (`aria-describedby`) + form-level `role="alert"`; one generic message for
  wrong email _or_ wrong password (no enumeration); forgot-password always reports "check your email".
- **Offline:** action failure → sonner toast with retry, form values preserved.
- **Keyboard/a11y:** labels, visible focus rings, logical order, `autocomplete`
  (`email`, `current-password`, `new-password`, `one-time-code`), `inputmode="numeric"` for TOTP,
  axe clean (serious/critical = 0) in both locales.

---

## 8. Test plan → acceptance checklist

| Checklist item                                                        | Proof                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Playwright: invite → register → login; wrong-role → bilingual 403** | `e2e/auth.spec.ts`: seed admin + invite via Prisma → register at 390 px → read the `AuthToken` from the DB (no dev-only endpoint ships) → verify → login → header shows the account menu; instructor session hits `/en/admin/invites` and `/no/admin/invites` → **status 403** + localized heading. `e2e/a11y.spec.ts` extended to `/login` + `/register`, both locales. |
| **All protected actions pass through `authorize()`**                  | `src/server/authz.test.ts` + `src/app/auth-coverage.test.ts`: walks `(admin)`/`(account)` layouts and every `actions.ts`, failing on any protected layout or exported action that does not call `requireUser(`. Grep evidence in the notes; spec-12 replaces it with the full route manifest.                                                                            |
| **Rate limiting 5/min/IP (Redis)**                                    | `src/server/rate-limit.test.ts` against real Redis: 6th call throws `RateLimitError`, window expiry resets, Redis-down fails open. Integration test asserts the `auth.login_failed` audit row.                                                                                                                                                                           |
| **Argon2 params documented**                                          | `password.test.ts` parses the hash header and asserts `argon2id, v=19, m=19456, t=2, p=1`; documented in `specs/notes/spec-03-notes.md`.                                                                                                                                                                                                                                 |

Additional unit/integration coverage (TDD, `TEST_DATABASE_URL` pattern from
`attempt-service.integration.test.ts`): concurrent invite consumption (`maxUses=1` → exactly one success) ·
invite expiry/revoked/email-mismatch · `AuthToken` single-use + expiry · TOTP RFC-6238 vectors with a fixed
clock, previous-code replay rejected · `totpSecret` encrypt/decrypt round-trip · ADMIN cannot complete login
without TOTP and is forced into setup · session revoke invalidates immediately · password policy ·
CSV parser (quotes, commas, CRLF, BOM) · email templates render in both locales.

---

## 9. Verification (Phase C, evidence into `specs/notes/spec-03-notes.md`)

```bash
docker compose -f docker-compose.dev.yml up -d          # pg 5544, redis 6399, mailpit 8025
pnpm exec prisma migrate dev --name auth                # down SQL reviewed for reversibility
pnpm exec prisma db seed && pnpm auth:create-admin admin@demo.teoripro.no
pnpm test            # unit + integration, incl. new auth suites
pnpm e2e             # auth.spec.ts + a11y.spec.ts on the 390px project
pnpm lint && pnpm exec tsc --noEmit
psql … -c 'EXPLAIN ANALYZE …'                           # the five queries in §2's index map
grep -rn "authorize(\|requireUser(" src/app
```

Manual: login → mailpit shows the bilingual verification mail; revoke a session in another browser → that
browser is signed out on its next request.

---

## 10. Risks

1. **`next-auth@5.0.0-beta.32` on Next 16** — peer range allows `^16` and we avoid the middleware wrapper (proxy stays next-intl-only; enforcement is server-side in layouts). First implementation step is a smoke test of `signIn`/`auth()`; if it fails, fall back to a hand-rolled signed-cookie session over the same `UserSession` table — a stack deviation that stops for approval + a `DECISIONS.md` entry.
2. **`experimental.authInterrupts`** — fallback in D6.
3. **Native `@node-rs/argon2` in the spec-14 container** — flagged now; `serverExternalPackages` set from the start.
4. **Email deliverability** — dev/test use mailpit/capture; real SMTP credentials are a spec-14 concern.
