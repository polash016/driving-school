# Spec 13 — Performance Budget, PWA/Offline, Accessibility Audit

## In scope

- Performance pass: bundle analysis (route JS budgets: exam route <150KB gz), image optimization (next/image, AVIF/WebP), font subsetting incl. æøå, React Server Components audit (client components justified or converted), Redis cache coverage review for all hot reads, DB EXPLAIN pass on top-10 queries.
- PWA: manifest, installable, service worker (Workbox): app-shell precache + downloaded practice packs (student picks topics → variants+images cached locally, practice offline, results sync on reconnect with conflict rule: server wins on duplicates). EXAM mode requires connection (clear bilingual offline notice).
- Web Vitals RUM (report to endpoint) with dashboards; alert thresholds documented.
- Accessibility audit: axe automated run in CI on key routes + manual keyboard/screen-reader script executed and logged; fix all criticals (universell utforming compliance statement page added).

## Acceptance checklist

- [ ] Lighthouse mobile: Perf ≥90, A11y ≥95, Best Practices ≥95 on home, exam, dashboard.
- [ ] Airplane-mode Playwright: downloaded pack practice works offline end-to-end; sync on reconnect.
- [ ] CI fails if route JS budget or axe criticals regress.
