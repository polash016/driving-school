# Brief — Spec 11: Admin & Instructor Dashboards (Opus expands to a full plan)

**Import, don't reinvent:** `authorize()` + `authorizeOwner` (instructor group scoping goes in services, per its docstring), invite service (spec-03), `contracts/auth.ts` (invites, CSV rows), Settings table + `keys.settings` cache, AuditLog helper, dashboard aggregate patterns from spec-09.

**Key decisions already made**
- Desktop-first responsive (admin panel exception to the 390px rule).
- Admin dashboard tiles: active students (7d), cohort pass-rate trend (ReadinessSnapshot/aggregate over attempts), at-risk list (documented criteria: readiness <60 OR no activity 14d — thresholds from Settings), review-queue count, AI usage meter (read `tp:ai:spend:<date>` + budget from config).
- Instructor scoping: every service call takes the session; instructors filtered to their groups via one `scopeToGroups(session)` helper — never inline where-clauses.
- Homework: create (topic set or blueprint + deadline, group/individual) → appears on student dashboards via the existing `dashboardHomeworkSchema` + invalidate `tp:dash:agg:*` for affected students (targeted, not wildcard: iterate member ids).
- Settings screen: read-mostly school.config view + editable runtime policies (exam cooldowns, focus-loss policy, pass-guarantee toggle, anomaly thresholds) — writes audit-logged, cache invalidated.
- Announcements: `Announcement` table (small migration: title/body Json, audience group?/all, createdBy, expiresAt) → dismissible banner (student layout) + email fan-out via the spec-03 mailer queue.

**Pitfalls:** authz tests are the acceptance core (instructor ≠ settings/billing/other groups); at-risk list needs a seeded scenario test; homework completion updates live = invalidate on submit via the existing `onGraded` chain (extend `progressService.applyGradedAttempt` to check homework completion).
