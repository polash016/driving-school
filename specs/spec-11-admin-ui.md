# Spec 11 — Admin & Instructor Dashboards

## In scope
- Admin dashboard: active students, cohort pass rate trend, at-risk list (readiness below threshold + inactivity), review-queue count, AI usage meter (from Spec-06 cost guard).
- Student management: list/search, groups, invite links + CSV import UX, student detail (progress, attempts, per-topic mastery, instructor notes, assign homework).
- Homework: create assignment (topic set or blueprint, deadline, group/individual), completion tracking, reminder notifications (email; push later).
- Instructor role sees only content review + their groups' students (authorize() scoping).
- Instance settings screen: read-mostly view of school.config + editable runtime policies (exam cooldowns, focus-loss policy, pass-guarantee toggle & criteria) stored in DB Settings table with audit log.
- Announcements: admin → all/group, shown as dismissible banner + email.

## Acceptance checklist
- [ ] Instructor cannot access billing/settings/other groups (authz tests).
- [ ] At-risk list matches documented criteria (seeded scenario test).
- [ ] Homework assignment → appears on target students' dashboards with deadline; completion updates live.
