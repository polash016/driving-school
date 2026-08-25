# Spec 09 — Student Dashboard / Homepage, Progress, History, Readiness Score

## Reference-driven homepage (IMPORTANT)

The student homepage MUST be structured around the competitor reference screenshot at
`specs/assets/reference-teorimester-homepage.png`. **Read/view this image before planning.**
Keep its proven vertical structure, but implement a distinctly more modern, clean, user-friendly version using our theme tokens.

**Keep from the reference (same vertical order):**

1. Header: school logo (from config) + EN/NO language switcher + menu.
2. Quick-start tiles at top — ours: **Image Quiz / Theory Test / Sign Test**, each with a Practice⇄Exam mode toggle (persisted per user). Tap = instant quiz (Spec 07).
3. Headline stats — ours: pass rate %, exams passed, streak, readiness score gauge.
4. "How I'm doing" — per-topic mastery section.
5. "My previous tests" — attempt history with resume.
6. Account/footer links, language selector, log out.

**Modernize (fix the reference's weaknesses — these are requirements, not suggestions):**

- No flat gray cards / harsh shadows: use token surfaces, 12–16px radii, subtle elevation, 4pt-grid whitespace.
- Topic bars: smooth red→amber→green fill with rounded caps; 0% shows a neutral "Not started" pill, never a full red bar; every row is a tappable target (min 44px) with chevron → topic practice for that topic.
- Previous tests: status-differentiated compact cards — chip (In progress / Passed 41/45 / Failed 33/45), date, ONE clear action (Resume or Review). No wall of identical buttons.
- Stats: readiness score as animated gauge (SVG, transform/opacity animation only), pass rate with trend indicator.
- Color discipline: primary for actions, green only for success, red only for genuine failure.

## Viewport rule for the ENTIRE student panel (applies to Specs 08, 09, 10)

Build all student-facing screens **mobile-first at 390px as the design target; the layout must be excellent on phones and merely acceptable (centered, max-w-md) on desktop for now.** Do not invest in desktop-specific student layouts yet — no multi-column desktop dashboards. Admin/instructor screens (Spec 11) remain desktop-first responsive.

## In scope

- Dashboard per the reference structure above; homework card with deadline inserted between stats and "How I'm doing" when an assignment exists.
- TopicMastery updated transactionally on grading (rolling window, recency-weighted).
- Readiness score v1 (rule-based, documented formula: mock pass rate recency-weighted + topic coverage + volume), stored as snapshots for the history graph.
- Mistake deck: spaced repetition (SM-2) over wrong answers → "My mistakes" quiz mode feeding Spec-07 assembly.
- Statistics page: score history graph, topic heatmap, badges (first pass, 7-day streak, all-topics-green…).
- All dashboard reads served from a single cached aggregate (Redis, invalidated on submit) — one round trip, target <100ms.

## Acceptance checklist

- [ ] Side-by-side check: homepage matches the reference's section order 1–6 (document with screenshot in specs/notes/spec-09-notes.md alongside the checklist evidence).
- [ ] All modernization requirements above verifiably implemented (topic rows tappable ≥44px, no red 0-bars, status-differentiated test cards, animated gauge).
- [ ] Rendered at 390px width with no horizontal scroll anywhere; desktop shows centered max-w-md layout.
- [ ] Submit exam → dashboard reflects new mastery/readiness immediately (cache invalidation test).
- [ ] Dashboard route: exactly 1 aggregate query round trip, p95 <150ms.
- [ ] Resume from dashboard lands on exact question. SM-2 intervals unit-tested.
