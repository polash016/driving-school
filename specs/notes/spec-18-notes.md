# Spec 18 — Verification Notes

Run 2026-09-05 against the dev stack, a 704-question bank, 10 published task sets and a student
with 5 real seeded attempts. Every item is PASS/FAIL **with the output that proves it**.

---

## Acceptance checklist

### ✅ No literal colour, blur radius or shadow in any changed component

Every glossy value reads a token. The one thing that could not be expressed as a Tailwind utility —
the composed `box-shadow` stack — lives in `globals.css` as `.glass`, still reading tokens.

### ✅ Editing the tokens alone re-themes home and `/task-sets`

`Card` became glass with no edit to `Card`'s own colours: `--card: var(--surface-glass)` in
`globals.css` was the whole change. Admin proves the inverse — `data-surface="plain"` reverts the
same components to solid:

```
default            : card bg=lab(100 0 0 / 0.72) blur=blur(18px) saturate(1.7) | field=radial-gradient(…)
data-surface=plain : card bg=lab(100 0 0)        blur=none                     | field=none
```

### ✅ Contrast measured on the real rendered pages

axe, 4 routes × light/dark × en/nb — **all eight combinations clean**:

```
axe light /en           : blocking=0 contrast=0
axe light /en/task-sets : blocking=0 contrast=0
axe light /no           : blocking=0 contrast=0
axe light /no/task-sets : blocking=0 contrast=0
axe dark  (same four)   : blocking=0 contrast=0
```

axe returns **incomplete** for 43 nodes across the two pages — it cannot compute contrast through
translucency and gradients, which is exactly the risk glass introduces. Those were measured from
**composited pixels** (element screenshot → most-frequent colour = surface, luminance-extreme
colour = text):

```
/en           : measured 27 nodes axe could not resolve
/en/task-sets : measured 16 nodes axe could not resolve
lowest measured ratio: 5.02 (needed 4.5) — header > p
```

Every one passes, with the worst case 0.5 above the threshold.

**Two contrast defects were found and fixed, both pre-existing rather than introduced here:**

1. The passed task-set tile: `--status-success` on `--status-success-soft` measured **2.92:1**
   (needs 4.5). The same green on white is 3.43:1, so every "Passed" badge in the app was failing
   too. `/task-sets` had never been in the axe spec's route list, which is why it had gone unseen.
2. The "Not passed" chip used Tailwind's `text-destructive` (the fill colour) at **4.49:1** — under
   by 0.01.

Fixed by splitting the job: `--status-success-strong` / `--status-danger-strong` for text (measured
4.8:1 on soft, 5.6:1 on white), originals keep fills and borders.

### ✅ `prefers-reduced-transparency: reduce` → opaque

Read from the computed style, not from the stylesheet:

```
normal              : bg=lab(100 0 0 / 0.72) blur=blur(18px)
reduced-transparency: bg=lab(100 0 0)        blur=blur(0px)
```

### ✅ `prefers-contrast: more` → opaque, solid border

```
contrast: more      : bg=lab(100 0 0)        blur=blur(0px)
```

### ✅ `@supports not (backdrop-filter)` → opaque fallback

Declared in `theme.css`; the same token collapse as above, so a browser without support renders a
solid card rather than a see-through one.

### ✅ Focus ring visible on glass and on the gradient hero

Screenshots captured at `scratchpad/focus-glass-tile.png` and `focus-hero.png`; the existing 2px
`--focus-ring` at 2px offset reads clearly against both the frosted tile and the blue gradient.

### ✅ Admin renders unchanged

`data-surface="plain"` on the admin layout: no aurora field, solid cards, no backdrop-filter — see
the computed-style output above.

### ✅ 390px: no horizontal scroll, light and dark

```
/en overflow = 0   /en/task-sets overflow = 0   /no overflow = 0
```

### ✅ Suites green

```
pnpm test : 435 passed (44 files)
pnpm e2e  : 33 passed, 1 skipped
```

### ✅ Both locales at parity

`missing: [] extra: []`. Greeting and stat labels present in `en` and `nb`.

---

## Follow-ups requested mid-implementation, and what they exposed

**"Hover on sign test makes the bg grey and the border white — not modern."**
Correct, and the cause was worse than styling. `ghost`'s `hover:bg-muted` supplied the grey; but
the reason the cards looked unseparated in the first place was that **`ring-1` erased their
shadow**. Tailwind's ring utilities compose into `box-shadow`, and a utility beats a base-layer
rule, so `.glass`'s shadow and highlight never rendered. The 1px edge now sits inside the same
`box-shadow` declaration, and hover **lifts** instead of tinting:

```
sign tile idle : 0 8px 22px  /0.12 , 0 2px 4px /0.07
sign tile hover: 0 14px 32px /0.18 , 0 3px 8px /0.10
button background on hover: rgba(0,0,0,0)   ← no grey wash
```

**"Increase the shadow a little so the cards are more visible."**
`--shadow-card` went from `0 6px 18px /0.09` to `0 8px 22px /0.12`, plus a new
`--shadow-card-hover`. Both in tokens, both with dark and plain counterparts.

**"Inject real category-wise data so the bars can be showcased, and make pass rate functional."**
`pnpm dev:seed-progress <email> [--sets N] [--reset]` **sits real attempts through the real
engine** — start → answer → submit — with accuracy steered per topic. Nothing is hand-inserted, so
grading, topic breakdowns, progress rows and attestation digests are all production-shaped:

```
task set #1: 35/45 — not passed (pass mark 38)
task set #2: 34/44 — not passed
task set #3: 40/45 — PASSED
task set #4: 34/45 — not passed
task set #5: 39/45 — PASSED
→ dashboard: pass rate 40%, sets passed 2
→ category bars: 88% / 48% / 56% / 67% / 91% / 40% / 40%
```

This also surfaced two bugs the empty state had hidden:

- `categoryPerformance`'s **raw SQL** duplicated the tests-only rule and still read
  `mode = 'EXAM' OR setupSnapshot IS NOT NULL` — task sets were excluded from category standing.
  Spec-16 updated the Prisma copy of that rule and missed this one.
- The category bar's middle band was `bg-primary`, putting the **action** colour on a progress
  scale. Now the red→amber→green ramp spec-09 specified.
- Attempt history rows all read "Task set" with no number; `taskSetNumber` is now carried through.

## Not done

**Production data injection.** Requested, not performed: SSH to `88.222.245.164` is refused from
this machine (`Permission denied (publickey,password)`; no host entry in `~/.ssh/config` or
`known_hosts`). See the handover note in the session summary — the seeder runs unchanged against
production over a tunnel once access exists, but **which account to seed is a decision, not a
detail**: writing synthetic graded attempts into a real student's record would falsify an
assessment history that this system deliberately attests and trigger-protects.
