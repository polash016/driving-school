# Plan — Spec 01: Foundation, Config Layer, i18n, Theming

**Status:** approved via master plan (see DECISIONS.md 2026-08-24 · Fable/Opus work split). Executed by Fable.

## Stack resolution

- create-next-app produced **Next 16.3 / React 19.2 / Tailwind v4 / TS strict** — satisfies "Next.js 15+". Tailwind v4 is CSS-first: our `config/theme.css` defines all tokens as CSS custom properties; `globals.css` maps them into Tailwind via `@theme inline`. No `tailwind.config` needed.
- Dark mode: class strategy via `next-themes` (`attribute="class"`), token overrides under `.dark`.
- Toast: shadcn's current toast is **sonner** (Toast component deprecated upstream) — restyled to tokens.

## Files

- `config/school.config.ts` — typed + zod-validated, frozen; name, orgNr, domain, logo, languages, licenseClasses (B: 45/90/38 as _seed defaults_ — runtime values come from DB in spec-02+), featureFlags (signTest, trailerCalculator, passGuarantee, studentPayments), aiBudget.
- `config/theme.css` — full token system: brand primary/accent slots, surface/border/text scale, semantic success/warning/danger, radii, shadows, spacing base, type scale; `.dark` overrides.
- `src/app/globals.css` — imports theme.css, maps tokens via `@theme inline`.
- `src/i18n/{routing.ts,request.ts,navigation.ts}` + `src/i18n/messages/{en,nb}.json`; `src/middleware.ts` (locale negotiation, cookie persistence). URL prefixes: `/en`, `/no` (locale `nb`).
- `src/app/[locale]/layout.tsx` (header: config logo + LanguageSwitcher + ThemeToggle), `page.tsx` (placeholder shell), `error.tsx`, `not-found.tsx` + root catch-all — all strings from messages.
- `src/components/layout/{site-header,language-switcher,theme-toggle}.tsx`.
- shadcn/ui: button, card, input, dialog, sheet, sonner → `src/components/ui/`, restyled to tokens.
- `vitest.config.ts` + `src/config.test.ts` (config zod-parse) + `src/i18n/messages.test.ts` (en/nb key-parity — enforces mandate 4 forever).
- `playwright.config.ts` + `e2e/shell.spec.ts` (locale routing, switcher persistence, dark mode).
- `.prettierrc`, `pnpm format`/`test`/`e2e` scripts.

## Test plan → acceptance checklist mapping

- Build/lint/strict → `pnpm build`, `pnpm lint`.
- Config swap → change name/color in config, verify via e2e text/CSS var (manual + documented).
- /en + /no render, switcher persists, no hardcoded strings → e2e + key-parity test + grep.
- Dark mode via tokens only; a11y → e2e class assertion + Lighthouse/axe best-effort.
