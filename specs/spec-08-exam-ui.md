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

---

## Amendment 2026-09-03 — the tile block is superseded by spec-16

The "Quick-start tiles (Image / Theory / Sign) with Practice⇄Exam toggle" bullet in **In scope**
above is **withdrawn**. The student panel now has three entry points, specified in
[spec-16](spec-16-task-sets.md):

- **Task set** — a numbered full mock exam drawn from its own slice of the bank. This is the
  primary path and replaces the Mock Exam tile.
- **Practice** — the configurable path (`/quiz/new`: length, timer, categories).
- **Sign test** — unchanged, one tap into a sign run.

The **Theory Test** and **Image Quiz** tiles are removed. The official teoriprøven mixes text,
image and sign questions in one paper, so splitting them into separate student-facing modules
exposed an authoring distinction the exam does not make.

`startQuizInput.itemType` **remains** — the Sign test still uses it, and it is still one engine
with one parameter. Nothing in the exam screen, practice reveal, review grid, result screen,
anti-cheat chrome or a11y requirements of this spec changes; a `TASK_SET` attempt renders through
the same runner as `EXAM`.
