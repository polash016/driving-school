# Spec 12 — Security Hardening & Anti-Cheat

## In scope
- Pass over ALL routes: Zod input+output validation, authorize() coverage, rate limits (per-route budgets in one config), CSRF where relevant, security headers (CSP without unsafe-inline, HSTS, frame-ancestors none), cookie flags.
- Anti-cheat: signed short-TTL image URLs; per-user diagonal watermark on exam images (Cloudflare worker or sharp at serve time, cached per user+image); print CSS disabled on exam routes; attempt cooldown policies from settings; server-side answer-rate anomaly flagging (answers faster than humanly possible → flag on attempt for instructor).
- Audit log coverage: auth events, content lifecycle, settings changes, exports — with admin audit viewer.
- GDPR endpoints: student data export (JSON) and account deletion (anonymize attempts, delete PII) behind admin approval; documented data map in SECURITY.md.
- Dependency & secret hygiene: .env validation at boot (zod), no secrets in client bundle (build-time check).

## Acceptance checklist
- [ ] Automated route-inventory test: every route lists auth level + rate limit (fails on unlisted route).
- [ ] Attempt to fetch another user's attempt/answers → 403 (IDOR tests across roles).
- [ ] Exam image URL expires; screenshot shows visible per-user watermark.
- [ ] Deletion request → PII gone, aggregate stats preserved (test).
