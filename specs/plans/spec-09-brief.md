# Brief — Spec 09: Student Dashboard / Homepage (Opus expands to a full plan)

**THE reference rule:** build the homepage AROUND `specs/assets/reference-teorimester-homepage.png` — view the image before planning. Keep its content and vertical order (header/logo/lang → quick-start tiles → headline stats → "How I'm doing" → previous tests → account/footer). The design must be **distinctly cleaner, more modern, more user-friendly** than the reference — token surfaces, 12–16px radii, subtle elevation, purposeful color (primary=actions, green=success only, red=real failure only), 60fps transform/opacity micro-interactions. Never a pixel-copy. All modernization bullets in spec-09 are REQUIREMENTS.

**Import, don't reinvent:** `contracts/dashboard.ts` (`dashboardAggregateSchema` — includes `masteryPercent: null` = "Not started" neutral pill, `action: RESUME|REVIEW` = exactly one button per test card), cache helpers + `keys.dashAgg` (invalidation already fired by the engine's `onGraded`), `remainingSeconds` for in-progress cards.

**Key decisions already made**
- ONE aggregate query path: `dashboardService.getAggregate(userId, locale)` → single Redis read (`tp:dash:agg`), miss → one batched Prisma round (mastery via `TopicMastery_userId_idx`, history via `ExamAttempt_userId_startedAt_idx`, homework via deadline indexes) → cacheSet 24h. Target <100ms.
- TopicMastery update: transactional on grading — extend the engine's `gradeAndClose` via a second hook or do it inside `onGraded` (recommended: a `progressService.applyGradedAttempt(attemptId)` called from `onGraded`, updating mastery (recency-weighted rolling window over `recentOutcomes` ring buffer), ReadinessSnapshot, and SM-2 `MistakeCard`s for wrong answers — one transaction, THEN cache invalidation).
- Readiness v1 (document the formula in the plan): `0.5·recencyWeightedMockPassRate + 0.3·topicCoverage(green share) + 0.2·volumeFactor(min(1, answered/300))`, ×100.
- SM-2: standard algorithm over `MistakeCard` (fields exist); "My mistakes" quiz = assembly with a candidate source that maps due cards → their masters' variants.
- Statistics page: score history (ReadinessSnapshot), topic heatmap, badges (first pass, 7-day streak, all-topics-green) — computed in the aggregate, not stored.

**Pitfalls:** topic bars use ROOT topics (engine breakdowns already roll up); 0% ≠ red bar (null mastery = neutral); every topic row is a ≥44px tappable → topic practice; document the reference side-by-side comparison with a screenshot in `specs/notes/spec-09-notes.md`.
