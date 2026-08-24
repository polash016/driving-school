# Brief — Spec 13: Performance, PWA/Offline, Accessibility Audit (Opus expands to a full plan)

**Key decisions already made**
- Budgets in CI: `@next/bundle-analyzer` + a size-limit script asserting exam-route JS <150KB gz; axe already wired (`e2e/a11y.spec.ts` from spec-01 — extend to home/exam/dashboard, fail CI on serious+).
- The deferred spec-01 item lands here: Lighthouse CI (`@lhci/cli`, mobile preset) — Perf ≥90 / A11y ≥95 / BP ≥95 on home, exam, dashboard. Needs full Chrome in CI image.
- RSC audit: every `"use client"` file justified in a table in the notes (interactive? → keep; else convert).
- PWA: `manifest.webmanifest` from school.config (name/colors/icons); service worker via Workbox (`@serwist/next` is the maintained Next-16-friendly wrapper — verify, else hand-rolled Workbox build step): app-shell precache + runtime caching.
- **Offline practice packs**: student picks topics → server endpoint returns a pack (assembled variants WITHOUT correctness + a pack id); answers queue in IndexedDB; on reconnect, sync submits answers to a pack-grading endpoint (server grades as PRACTICE attempts; conflict rule: server wins on duplicates via idempotent pack-item ids). Grading stays server-side — offline mode shows "answers sync when online", NOT instant correctness (the anti-leak invariant survives offline; make this explicit in UI copy). EXAM requires connection (bilingual notice).
- Web Vitals RUM: `useReportWebVitals` → `/api/rum` (rate-limited, sampled 10%) → pino logs; thresholds documented in notes; dashboard = simple admin chart later.
- Redis cache coverage review + `EXPLAIN` pass on top-10 queries — repeat the spec-02 volume method, document.

**Pitfalls:** service worker must NEVER cache attempt/answer API responses (network-only strategy for `/api/quiz/*`); precache manifest keyed by build id; font subset must include æøå (Geist latin covers it — verify glyphs render in nb).
