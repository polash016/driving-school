# Brief — Spec 08: Student Exam & Practice UI (Opus expands to a full plan)

**Import, don't reinvent:** the whole engine (`createAttemptService` + `PrismaVariantSource` + `RedisSeenStore` + `invalidateDashboardOnGraded`), `contracts/quiz.ts` DTOs, `authorize()`, tokens.

**Route layer contract (thin!):** route handlers/server actions = parse input schema → `authorize()` → `attemptService.*` → response. No business logic in routes. Wire `onGraded: invalidateDashboardOnGraded`.

**Key decisions already made**
- 390px mobile-first, max-w-md desktop (WORKFLOW §6). One question per screen; large answer Cards (min 44px); server-synced countdown from `timeRemainingSec` at serve + local tick, re-synced on every answer ack (never trust local).
- Practice mode: `answer()` already returns `PracticeAnswerResult` with localized explanation + citations — render reveal state + "Read more" expander; prefetch next question during the reveal (payload already client-side — prefetch = preload next image only).
- EXAM mode: `answer()` returns `{saved:true}` ONLY. Never render correctness pre-submit. The spec-07 e2e network assertion lands here: Playwright intercepts all responses during an exam and asserts no `correctOptionKey`/`isCorrect` (do this — it's the last open spec-07 checklist item).
- Locale switch mid-exam: `serveAttempt` with the other locale — same variant, answers/flags/timer preserved (engine guarantees it; e2e verifies).
- Sign test: mode SIGN via `startQuiz`; adaptive re-queue of misses is a client-side session queue (no engine change).
- Focus-loss events: increment via a small endpoint updating `focusLossCount` (policy handling per spec-12 plan).
- A11y is law: full keyboard path (arrows/enter answer, F flag, N/P navigate), SR announcements (aria-live on question change), reduced-motion variant, TTS via Web Speech API with locale voice.

**Pitfalls:** never index questions by array position in the client (use `position` field); CLS ≈ 0 on answer reveal (reserve explanation space); the countdown at T-10min turns amber — no flashing (WCAG).

**Done =** spec-08 checklist PASS incl. keyboard-only 45-question mock in both locales.
