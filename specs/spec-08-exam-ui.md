# Spec 08 — Student Exam & Practice UI (+ Sign Test)

## Objective

Official-test-parity exam experience that stays calm and silky at 60fps.

## Viewport rule

All screens in this spec are **mobile-first at 390px design target** (see Spec 09 viewport rule): excellent on phones, acceptable centered max-w-md on desktop. No desktop-specific student layouts in this iteration.

## In scope

- Quick-start tiles (Image / Theory / Sign) with Practice⇄Exam toggle (persisted per user); tap → quiz instantly (Spec 07). The three tiles are the same engine with one parameter: `startQuizInput.itemType` (`IMAGE` / `TEXT` / `SIGN`) filters assembly candidates — no new attempt mode, no migration (amendment 2026-08-24).
- Exam screen: one question/screen, large answer cards (44px+ targets), flag, navigator drawer (answered/flagged/current/skipped), server-synced countdown (amber at 10min, no flashing), image viewer with pinch/scroll zoom, language switcher mid-exam (re-renders current question in other locale, same variant).
- Practice mode: answer → instant correct/incorrect state + explanation + "Read more" citation expander; next-question prefetched during answer reveal.
- Review-before-submit grid; submit confirmation dialog.
- Result screen: pass/fail hero (subtle confetti on pass), score ring, per-topic bars, wrong-answer review list.
- Sign Test mode: rapid-fire sign→meaning and meaning→sign, progress dots, adaptive re-queue of misses within session.
- Exam mode chrome: fullscreen request, copy/context-menu disabled, focus-loss events logged (policy from config: warn/log/auto-submit).
- Full a11y: complete keyboard path (arrows+enter answer, F flag, N/P navigate), screen-reader announcements, reduced-motion variant, TTS read-aloud button per question (Web Speech API, correct locale voice).

## Acceptance checklist

- [ ] Playwright: full 45-question mixed mock exam keyboard-only, both locales.
- [ ] Question→question transition <100ms perceived (prefetch verified: next payload requested during current question).
- [ ] Mid-exam locale switch preserves answers, flags, timer.
- [ ] Lighthouse: Performance ≥90 mobile, A11y ≥95 on exam route. No layout shift on answer reveal (CLS ≈ 0).
