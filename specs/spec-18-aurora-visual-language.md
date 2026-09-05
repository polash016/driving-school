# Spec 18 — Aurora: the student panel's visual language

> Approved 2026-09-05 from a three-way mockup review (Aurora / Cupertino / Refined). The chosen
> direction is **Aurora — glossy**. Reference: `specs/assets/spec-18/home-aurora.png` and the live
> mockup source `specs/assets/spec-18/home-designs.html`.

## Objective

Give the student panel a single, modern, glossy visual language — frosted-glass surfaces over a
soft aurora field — without touching a single business rule, and without breaking the per-school
theming that `config/theme.css` exists for.

## Why this exists

The panel is correct and plain. Every surface is a flat white card on a flat grey page, which
reads as unfinished next to what students compare it to. The reference competitor is no better,
so matching it is not the bar — CLAUDE.md's own rule is "distinctly cleaner, more modern and more
user-friendly than the reference".

## The approach that makes this cheap

`config/theme.css` → shadcn semantic variables (`globals.css`) → components. Components consume
**only** the mapped variables: `Card` is already `bg-card shadow-card ring-1 rounded-lg`. So the
restyle is overwhelmingly a **token change**, and every surface in the app inherits it. Component
edits are limited to the few places that need structure the tokens cannot express (the hero's
gradient and sheen, the icon chips, the stat pair).

**This is the constraint that keeps the work honest:** if a colour, blur or shadow is written into
a component instead of a token, a school can no longer re-theme it, and mandate 4 is broken.

## In scope

### 1. New tokens (`config/theme.css`) — light and dark

```
/* Aurora field — three brand-derived blooms behind everything */
--aurora-a / --aurora-b / --aurora-c        colour stops
--aurora-field                              the composed background-image

/* Glass */
--surface-glass          card fill (translucent)
--surface-glass-strong   sheets/popovers (less translucent — they sit over content)
--glass-ring             the bright 1px top edge
--glass-blur             blur radius
--glass-highlight        inset 0 1px 0 … the specular top line

/* Depth */
--shadow-card            tinted, layered
--shadow-hero            coloured glow under the hero

/* Hero */
--gradient-hero          the task-set card's gradient
--gradient-stat          the stat numerals' gradient
--chip-brand / --chip-accent   tinted icon chips
```

A school re-themes the whole look by editing these. **No component may contain a literal colour,
blur radius or shadow.**

### 2. `[data-surface="plain"]` — the admin opt-out

Admin is desktop-first and dense with tables; glass behind a data table is noise. The admin layout
sets `data-surface="plain"`, which reverts the glass tokens to solid surfaces and hides the aurora
field. One attribute, no duplicated components.

### 3. Accessibility — non-negotiable (WCAG 2.1 AA is Norwegian law)

- **Contrast is verified, not assumed.** Body text on glass, and white text on the hero gradient,
  are measured against the *worst* point of the surface beneath them. Target ≥4.5:1 for body,
  ≥3:1 for large text and UI boundaries.
- **`prefers-reduced-transparency`** → glass becomes opaque. This is the setting a user reaches for
  precisely because translucency hurts them to read; honouring it is not optional.
- **`prefers-contrast: more`** → opaque surfaces and a solid, darker border.
- **`@supports not (backdrop-filter: blur(1px))`** → opaque fallback, so a browser without support
  gets a solid card rather than an unreadable transparent one.
- Focus rings stay visible **on glass and on the gradient hero** — the existing 2px `--focus-ring`
  at 2px offset is checked against both.

### 4. Performance — mandate 1 (60fps, nothing above 100ms)

- **One** aurora layer, `position: fixed`, painted once behind everything — never per-card.
- `backdrop-filter` only on surfaces that actually overlap the field. It is the single most
  expensive thing here, so the count of blurred layers on the homepage is capped and stated.
- No animated blur, ever. Motion remains transform/opacity only.
- The sheen on the hero is a **static** gradient, not an animation.
- Lighthouse Performance ≥90 on mobile for `/` and `/task-sets`, as spec-13 already requires.

### 5. Screens

| Screen | What changes |
|---|---|
| Shell (`[locale]/layout.tsx`) | Aurora field; glass header |
| Home `/` | Greeting + progress line; gradient hero with sheen and glow; glass tiles with tinted icon chips; **stat pair** (pass rate, sets passed); glass section cards |
| `/task-sets` | Glass numbered tiles; glass progress card; passed tiles keep the success token |
| Start sheet | `--surface-glass-strong` |
| `/quiz/*` | Inherits surfaces from tokens only. **No new decoration on the exam screen** — a glossy, busy paper during a timed test is a distraction, and spec-08's calm is deliberate. |
| Admin | Unchanged (`data-surface="plain"`) |

### 6. Content additions (from the approved mockup)

- **Greeting** replaces the generic headline for a signed-in student: `Hei, {name}` with
  `{passed} of {total} task sets passed` beneath. Falls back to a name-free greeting when the
  profile has no first name.
- **Stat pair**: pass rate and sets passed — already required by spec-09, still unbuilt.

Both need `en` + `nb` strings; nothing goes in outside the i18n layer.

## Out of scope

- Admin/instructor visual language.
- The exam question card's internals (spec-08).
- Dark-mode *redesign* — dark gets a correct, tested Aurora treatment, not its own art direction.
- Any change to business logic, queries, or the engine.

## Acceptance checklist

- [ ] No literal colour, blur radius or shadow in any changed component — every value reads a token.
      Evidence: grep over the diff.
- [ ] Editing the aurora/glass tokens in `theme.css` alone visibly re-themes home and `/task-sets`.
      Evidence: screenshot before/after a token swap.
- [ ] Contrast measured on the real rendered pages: body text on glass ≥4.5:1, hero text ≥4.5:1,
      muted text ≥4.5:1. Evidence: computed-contrast output, not an assertion.
- [ ] axe: no serious/critical violations on `/` and `/task-sets`, light **and** dark, `en` and `nb`.
- [ ] `prefers-reduced-transparency: reduce` → surfaces are opaque. Evidence: rendered screenshot.
- [ ] `prefers-contrast: more` → opaque surfaces, solid borders. Evidence: rendered screenshot.
- [ ] `@supports not (backdrop-filter:…)` → opaque fallback. Evidence: rendered with the feature
      disabled.
- [ ] Focus ring clearly visible on a glass tile and on the gradient hero. Evidence: screenshots.
- [ ] Admin renders unchanged: solid cards, no aurora. Evidence: before/after screenshot.
- [ ] 390px: no horizontal scroll on `/` or `/task-sets`, light and dark.
- [ ] Lighthouse mobile Performance ≥90 and Accessibility ≥95 on `/` and `/task-sets`.
- [ ] Full suite green: `pnpm test` and `pnpm e2e`.
- [ ] Both locales at parity; greeting and stat labels present in `en` and `nb`.
