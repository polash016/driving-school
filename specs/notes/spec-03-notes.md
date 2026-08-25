# Spec 03 — Authentication & Roles · verification evidence

Verified 2026-08-24 against the approved plan (`specs/plans/spec-03-plan.md`).
Stack: Next 16.3.2 · Auth.js 5.0.0-beta.32 (credentials-only) · Prisma 6.19 · Postgres 16 + pgvector · Redis 7 · mailpit.

Commands run for this pass:

```
docker compose -f docker-compose.dev.yml up -d      # db 5544, redis 6399, mailpit 1025/8025
pnpm exec prisma migrate dev                        # 20260824085333_auth
DATABASE_URL=$TEST_DATABASE_URL pnpm exec prisma migrate deploy
pnpm exec tsc --noEmit && pnpm exec eslint          # both clean
pnpm test                                           # 141 passed (21 files)
pnpm build                                          # ✓ compiled, authInterrupts active
pnpm e2e                                            # 17 passed
```

---

## Acceptance checklist

### ✅ Playwright: student invite→register→login; wrong-role access to admin routes returns 403 page (bilingual)

`e2e/auth.spec.ts`, run on the 390 px `mobile-chromium` project:

```
✓ e2e/auth.spec.ts:99  › invite → register → verify email → log in (1.2s)
✓ e2e/auth.spec.ts:157 › wrong role gets a bilingual 403 on admin routes (389ms)
✓ e2e/auth.spec.ts:177 › signed-out access to an account page returns 401 with a way in (131ms)
✓ e2e/auth.spec.ts:186 › admin must set up two-factor before a session exists, then can invite (485ms)
```

What the first test actually exercises: `/en/register` without a token shows "Invitation required" →
with the seeded token the form appears → registration → **the verification link is read out of the
real email in mailpit** (only its sha256 hash is in the database — asserted in the test) → login is
refused with "Verify your email address first" → confirming the address → login lands on `/en` with
"Log out" in the header → `/en/account/security` renders with the current device marked.

The 403 test asserts the **HTTP status**, not just the copy (possible because `forbidden()` is enabled
via `experimental.authInterrupts`):

| Request as INSTRUCTOR                   | Status  | Heading                               |
| --------------------------------------- | ------- | ------------------------------------- |
| `GET /en/admin/invites`                 | **403** | "You do not have access to this page" |
| `GET /no/admin/invites`                 | **403** | "Du har ikke tilgang til denne siden" |
| `GET /en/account/security` (signed out) | **401** | "Please log in to continue"           |

### ✅ All protected server actions/routes verifiably pass through `authorize()` (grep + test)

`src/app/auth-coverage.test.ts` walks the App Router tree and fails on: an uncovered page/layout in a
protected group, an exported server action without `requireUser()`, or any direct `authorize()` call in
the app layer. `src/server/authz.test.ts` pins the role ladder (13 cases).

```
$ grep -rn "requireUser(" src/app --include='*.ts*' | grep -v '\.test\.'
src/app/[locale]/(account)/layout.tsx:12:        await requireUser();
src/app/[locale]/(account)/account/security/page.tsx:20: const user = await requireUser();
src/app/[locale]/(account)/account/actions.ts:25,42,54,73,90  (5 exported actions)
src/app/[locale]/(admin)/layout.tsx:12:          await requireUser("INSTRUCTOR");
src/app/[locale]/(admin)/admin/invites/page.tsx:24:         await requireUser("ADMIN");
src/app/[locale]/(admin)/admin/invites/actions.ts:26,52,66   (3 exported actions)

$ grep -rn "authorize(" src --include='*.ts*' | grep -v '\.test\.' | grep -v authz.ts
src/server/auth/require-user.ts:20:  return authorize(session, role);      ← the only caller
src/server/auth/config.ts:30:      async authorize(credentials) {          ← Auth.js provider callback (unrelated name)
```

`src/app/[locale]/(auth)/actions.ts` is the one file allow-listed as public — it is the way in
(login/register/reset/verify). The test asserts that allow-list only ever contains `(auth)` files.

### ✅ Rate limiting on auth endpoints (Redis, 5/min/IP)

`src/server/rate-limit.test.ts` runs against the real Redis (5 cases, all green): the 6th login attempt
inside the window throws `RateLimitError`; the window is set on the first hit and never extended;
routes count independently; a successful login clears the counter; **Redis down fails open** with a warn
log rather than locking a school out of its own app.

Budgets (`RATE_LIMITS`, `src/server/rate-limit.ts`): login 5/min/IP **+ 10/15 min per email-hash** ·
register 5/min/IP · password-reset 5/min/IP + 3/h per email · token consume 10/min/IP · TOTP 5/min/user.
Email keys are sha256-derived, so no address is ever stored in Redis. The limiter is real enough that
the integration suite had to give each simulated login its own IP.

### ✅ Argon2 params documented

`src/server/services/auth/password.test.ts` parses the encoded hash rather than trusting the options
object:

```
$ node -e "…hashSync('spec-03-sample', {memoryCost:19456,timeCost:2,parallelism:1})"
$argon2id$v=19$m=19456,t=2,p=1$…
```

**argon2id, 19 MiB memory, 2 iterations, 1 lane** (OWASP baseline), via `@node-rs/argon2` (prebuilt
binaries — no node-gyp in the spec-14 container). A downgrade fails the test. Salting, wrong-password
rejection and malformed-hash handling are covered in the same file.

---

## In-scope items beyond the checklist

| Spec item                                             | Where                                                                    | Evidence                                                                                                                                                                                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Email verification + password reset, bilingual emails | `services/auth/{email-verification,password-reset}.ts`, `server/email/*` | Integration: link mailed in the student's own locale ("Bekreft e-postadressen din"), single-use, expiry rejected, reset revokes every session                                                                                         |
| Invite links (single-use + group + expiry)            | `services/auth/invites.ts`                                               | Concurrency test: two simultaneous registrations on a `maxUses: 1` link → exactly one succeeds, `usedCount` = 1; revoked/expired/mis-addressed each give their own message                                                            |
| CSV import                                            | `services/auth/csv-import.ts`, `lib/csv.ts`                              | Semicolon (Norwegian Excel) dialect, quotes, CRLF, BOM, æøå; import invites new rows, skips existing/duplicate/malformed, mails each invitee                                                                                          |
| 2FA: required ADMIN, optional INSTRUCTOR              | `services/auth/{credentials,totp,totp-enrolment}.ts`                     | RFC 6238 vectors; ±1 step skew; **replay of a valid code rejected**; admin cannot obtain a session before enrolment (e2e asserts zero session cookies at that point); secret encrypted at rest (AES-256-GCM, HKDF from `AUTH_SECRET`) |
| Session view/revoke                                   | `services/auth/sessions.ts`, `/account/security`                         | Revoke drops the Redis flag immediately, `isSessionValid` false on the next request; a foreign session cannot be revoked (403)                                                                                                        |
| Audit log for auth events                             | `server/audit.ts`                                                        | Integration asserts `auth.register`, `invite.used`, `auth.email_verified` per registration and `auth.login_failed` with its reason                                                                                                    |
| Vipps Login stub + feature flag                       | `server/auth/vipps-stub.ts`, `config/school.config.ts`                   | `vipps-stub.test.ts`: flag ships `false`, the factory throws instead of returning a half-configured provider, contributes no providers                                                                                                |
| Admin bootstrap / 2FA recovery                        | `scripts/create-admin.ts`, `scripts/reset-2fa.ts`                        | `pnpm auth:create-admin <email> [password]`, `pnpm auth:reset-2fa <email>` (audited, revokes sessions)                                                                                                                                |

---

## Mandate compliance

- **Queries + indexes (mandate 2).** Every auth query uses its named index. Measured on `teoripro_test`
  at synthetic volume (20 000 users, 40 000 sessions, 40 000 tokens, 20 000 invites, 50 000 audit rows,
  inserted in a transaction and rolled back):

  | Query                                             | Plan                                                     | Exec     |
  | ------------------------------------------------- | -------------------------------------------------------- | -------- |
  | Login lookup `User(email)`                        | Index Scan `User_email_key`                              | 0.025 ms |
  | Invite validation `InviteLink(token)`             | Index Scan `InviteLink_token_key`                        | 0.013 ms |
  | Verify/reset `AuthToken(tokenHash)`               | Index Scan `AuthToken_tokenHash_key`                     | 0.012 ms |
  | Active sessions `(userId, revokedAt)`             | Bitmap Index Scan `UserSession_userId_revokedAt_idx`     | 0.022 ms |
  | Outstanding tokens `(userId, type, consumedAt)`   | Bitmap Index Scan `AuthToken_userId_type_consumedAt_idx` | 0.013 ms |
  | Audit trail `(actorId, createdAt)`                | Bitmap Index Scan `AuditLog_actorId_createdAt_idx`       | 0.017 ms |
  | Admin invite list `(createdById, createdAt DESC)` | Index Scan `InviteLink_createdById_createdAt_idx`        | 0.016 ms |

  Every query uses an explicit `select`; the invite list is paginated.

- **Caching (mandate 5).** Five new keys, all via `keys.*`: `tp:auth:sess:<sid>` (300 s, deleted on
  revoke/logout/password change), `tp:auth:ticket:<id>` (60 s, GETDEL), `tp:auth:seen:<sid>` (300 s
  write throttle), `tp:auth:totp:<userId>` (600 s), `tp:auth:totpused:<userId>:<code>` (90 s).
  `grep -rn '"tp:' src | grep -v redis.ts` → no hand-written keys.
- **i18n (mandate 4).** ~120 new keys in both locales; `messages.test.ts` proves key parity, and the new
  `src/i18n/message-keys.test.ts` resolves every runtime `messageKey` literal (typed errors, CSV row
  outcomes) in **both** catalogues — so a pruned key can never surface as raw `auth.errors.x` to a user.
  Emails are translated from the same catalogue.
- **Layering (architecture §2).** `grep -rln "from \"next\|from \"react" src/server/services` → none.
- **Solid features (mandate 3).** Every auth screen has loading (pending submit), error (inline +
  `role="alert"`), success and empty states; 44 px targets, labels, `aria-describedby`, `autocomplete`
  (`email`/`current-password`/`new-password`/`one-time-code`), `inputmode="numeric"` for codes.
  Axe (WCAG 2.1 A/AA, serious+critical) is clean on `/en/login`, `/no/login`, `/en/forgot-password`,
  `/no/forgot-password`. An unverified login now offers "send the verification email again" rather than
  dead-ending. No TODOs in user-facing paths.
- **Security.** One generic message for wrong-password vs unknown-email (with a timing-equalising argon2
  verify on the unknown-email path); password reset never reveals whether an address exists; only token
  hashes are stored; TOTP secrets encrypted at rest; the login ticket never reaches the browser;
  verification is confirmed by POST so mail scanners cannot burn the token.

## Fixed while running the app (pre-existing)

**Dates rendered in the host's time zone.** next-intl had no `timeZone`, so it fell back to the
server's — a dev machine reported `Asia/Dhaka`, and the account security page's "Last active …"
timestamps followed it. A container in any other region would have shown Norwegian students the wrong
times. `locales.timeZone` (validated against `Intl.supportedValuesOf`) is now part of
`config/school.config.ts` and passed through `src/i18n/request.ts`; verified live in the RSC payload
(`Europe/Oslo`). This is the mandate-4 rule applied to formatting: a school value, not a literal.

## Fixed while implementing (pre-existing)

**Schema drift that would have destroyed knowledge-base search.** `prisma/schema.prisma` did not declare
`KbChunk.textSearch` or the raw-SQL indexes from `20260824054002_kb_hybrid_search`, so `prisma migrate
dev` generated `DROP INDEX "KbChunk_embedding_hnsw_idx"` and `DROP COLUMN "textSearch"` into this
spec's migration. Fixed by declaring the generated column plus its GIN index in the schema and stripping
the remaining HNSW statement from the migration; `prisma/migrations.test.ts` now fails the build if such
a statement is ever committed again. Post-migration check:

```
$ psql … -c "SELECT indexname FROM pg_indexes WHERE tablename='KbChunk'"
 KbChunk_embedding_hnsw_idx | KbChunk_textSearch_idx | KbChunk_sourceId_idx | KbChunk_pkey
```

Prisma still proposes `DROP INDEX "KbChunk_embedding_hnsw_idx"` and `ALTER COLUMN "textSearch" DROP
DEFAULT` in every future migration (it cannot model an HNSW index or a GENERATED column) — **delete
those two statements from generated SQL**; the guard test catches the mistake.

## Test inventory added by this spec

| File                                           | Cases | Covers                                                                                                            |
| ---------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------- |
| `services/auth/password.test.ts`               | 7     | argon2 params, verification, salting, policy                                                                      |
| `services/auth/crypto.test.ts`                 | 6     | token entropy/hashing, AES-GCM round-trip + tamper, email rate keys                                               |
| `services/auth/totp.test.ts`                   | 6     | RFC 6238 vectors, skew window, malformed input, otpauth URI                                                       |
| `services/auth/auth-flows.integration.test.ts` | 20    | invites (incl. concurrency), registration, verification, login, 2FA, sessions, reset, CSV — real Postgres + Redis |
| `server/rate-limit.test.ts`                    | 5     | window, isolation, reset, fail-open                                                                               |
| `server/authz.test.ts`                         | 13    | role ladder + ownership                                                                                           |
| `server/auth/vipps-stub.test.ts`               | 3     | stub is inert and flagged off                                                                                     |
| `lib/csv.test.ts`                              | 8     | RFC-4180 + Excel dialects                                                                                         |
| `app/auth-coverage.test.ts`                    | 5     | authorize() chokepoint coverage                                                                                   |
| `i18n/message-keys.test.ts`                    | 3     | runtime message keys resolve in both locales                                                                      |
| `prisma/migrations.test.ts`                    | 3     | hybrid-search objects are never dropped                                                                           |
| `e2e/auth.spec.ts`                             | 4     | the acceptance flows end to end                                                                                   |

Totals: **141 unit/integration** (66 before this spec — measured by re-running only the pre-existing
10 files) and **17 e2e** (9 before: 6 shell + 3 axe), all green.

## Known limitations (deliberate, carried forward)

- 2FA recovery is the CLI script; recovery codes are a spec-12 follow-up (DECISIONS 2026-08-24).
- Email is sent inline through the `MailTransport` port; the BullMQ `emails` queue swaps in behind it
  when the worker lands in spec-06.
- `/admin/invites` is the minimal invite surface — spec-11 restyles it and adds the rest of the admin UI.
- Auth.js adapter tables (`Account`) arrive with the Vipps/OIDC spec, not before.
