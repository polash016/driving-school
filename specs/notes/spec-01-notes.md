# Verification — Spec 01: Foundation, Config Layer, i18n, Theming

Executed by Fable, 2026-08-24. Stack as built: Next 16.3.2 (App Router, Turbopack), React 19.2.8, TS strict, Tailwind v4, next-intl 4.13, zod 4.4, next-themes, shadcn (radix base), Vitest 4, Playwright 1.x (mobile-chromium project at 390×844).

## Acceptance checklist

### ✅ `pnpm build` clean, TS strict, zero ESLint errors
- `pnpm build`: "Compiled successfully", TypeScript pass clean, routes `/en` + `/nb`(served as `/no`) SSG, proxy (middleware) registered.
- `tsconfig.json` `strict: true` (scaffold default, verified). `pnpm lint`: zero errors/warnings.
- `pnpm test`: 7/7 unit tests pass (config schema/frozen/locale-consistency/passMark; i18n key parity en↔nb + non-empty).

### ✅ Changing school.config name/color/logo changes the whole site with zero component edits
- Name: rendered only via `schoolConfig.school.shortName` (header, metadata). Logo: only via `schoolConfig.branding.*`. Colors: components reference only shadcn semantic vars, which `globals.css` maps to `config/theme.css` tokens.
- Grep evidence: `grep -rn "TeoriPro|teoripro|999999999" src/` → only two CSS *comments* in globals.css; `grep -rnE '#hex|oklch\(' src/ --include=*.ts*` → none (raw colors exist only in `config/theme.css` and `public/logo*.svg`, both school-swappable).

### ✅ /en and /no render; switcher persists across reload; no hardcoded user-facing string
- Playwright (9/9 pass): root → locale redirect; switcher `/en → /no`; cookie persistence (revisit `/` lands on `/no`); both locales render with no raw message keys; bilingual not-found on unknown paths.
- Grep: no JSX literal text nodes in `src/app` + `src/components/layout`. Documented exception: `LanguageSwitcher` renders visual locale codes "EN"/"NO" (aria-hidden) with translated `sr-only` full names — locale codes, not display copy.
- Unit test `messages.test.ts` permanently enforces en/nb key parity.

### ✅ Dark mode toggles via tokens only / ⚠️ Lighthouse a11y ≥ 95: PARTIAL (axe pass; Lighthouse deferred)
- Dark mode: class strategy (next-themes), `.dark` overrides live only in `config/theme.css`; e2e verifies `<html class="dark">` toggling.
- A11y evidence: axe (`@axe-core/playwright`, WCAG 2.x A+AA tags) → **zero serious/critical violations** on `/en`, `/no`, and dark mode. Skip-link, focus-visible ring, 40–44px targets, `aria-pressed` switcher, reduced-motion support implemented.
- Lighthouse itself requires full Chrome (only Playwright headless shell installed); the numeric Lighthouse gate is CI-enforced in spec-13. Rated PARTIAL here, tracked as an explicit spec-13 item.

## Deviations / notes for later specs
- Next 16 uses `src/proxy.ts` (middleware successor) — next-intl `createMiddleware` works as the default export.
- shadcn's current CLI installed the "lyra" preset (radix primitives, Phosphor icons); all six components restyled to tokens: radii from `--radius-*`, `text-sm`, 40–44px control heights, `shadow-card` elevation.
- shadcn Toast is deprecated upstream → sonner `<Toaster />` mounted in the locale layout.
- Build route list prints the locale as `/nb`; the public URL prefix is `/no` (verified by e2e).
