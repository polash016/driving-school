# Spec 01 — Project Foundation, Config Layer, i18n, Theming

## Objective

Bootstrap the repo so every later spec plugs into a config-driven, bilingual, themeable shell.

## In scope

- Next.js 15 App Router + TypeScript strict + ESLint + Prettier + Vitest + Playwright setup.
- `config/school.config.ts`: typed school config (name, org.nr, domain, logo path, enabled languages, license classes with {questionCount, timeLimitMin, passMark}, feature flags: signTest, trailerCalculator, passGuarantee, studentPayments). Loaded once, injected via server context.
- `config/theme.css`: CSS custom properties for the full token system (colors incl. tenant primary/accent slots, spacing 4pt, radii, shadows, type scale). Tailwind config consumes ONLY these variables.
- next-intl with `en` (default) and `nb` locale files; locale routing `/en /no`; language switcher component (header desktop / settings mobile); middleware persisting choice in cookie.
- Base layout: header (logo from config, language switcher), responsive shell, dark mode (class strategy, token overrides), error boundary + not-found pages (bilingual).
- shadcn/ui installed and restyled to tokens: Button, Card, Input, Dialog, Sheet, Toast.

## Out of scope

Auth, DB, any feature UI.

## Acceptance checklist

- [ ] `pnpm build` clean, TS strict, zero ESLint errors.
- [ ] Changing school.config.ts name/color/logo changes the whole site with zero component edits.
- [ ] /en and /no render; switcher persists across reload; no hardcoded user-facing string anywhere (grep proves it).
- [ ] Dark mode toggles via tokens only. Lighthouse a11y ≥ 95 on the shell.
