# Spec 03 — Authentication & Roles

## Objective
Secure auth with three roles and school-driven student onboarding.

## In scope
- Auth.js: email+password (argon2), email verification, password reset (bilingual emails via Resend or SMTP).
- Roles ADMIN / INSTRUCTOR / STUDENT enforced in a single `authorize(role)` server helper used by every protected route/service — no inline role checks scattered around.
- Student onboarding: admin generates invite links (single-use or group link with expiry) and CSV import; students self-register only via invite. No open signup.
- 2FA (TOTP) required for ADMIN, optional for INSTRUCTOR.
- Session management: view/revoke active sessions; audit log entries for auth events.
- Vipps Login: leave a clearly-marked adapter stub + feature flag (implemented in a later spec).

## Acceptance checklist
- [ ] Playwright: student invite→register→login; wrong-role access to admin routes returns 403 page (bilingual).
- [ ] All protected server actions/routes verifiably pass through `authorize()` (grep + test).
- [ ] Rate limiting on auth endpoints (Redis, 5/min/IP). Argon2 params documented.
