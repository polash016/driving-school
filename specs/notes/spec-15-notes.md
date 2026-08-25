# Spec-15 — verification evidence

## Phase 1a — the language engine (2026-08-25)

The engine that makes a language runtime data. AI translation, the admin screens and the RTL sweep
are the remaining parts of phase 1/2 and are **not** covered here.

### The headline claim, tested honestly

`e2e/dynamic-languages.spec.ts` runs against a server that was **built and started before the test
file executed**, so the language genuinely did not exist at build time:

```
✓ a language added at runtime routes, with no redeploy (32.7s)
✓ a language that is not student-visible stays out of the switcher
```

The test asserts, in order: the prefix 404s before the language exists → the row is created →
`/{code}` returns 200 with `lang="{code}"` and `dir="rtl"` from the language row → the page reads
English throughout, because nothing is translated yet and English is merged underneath every
catalogue.

Confirmed by hand against the running dev server as well:

```
$ curl -s localhost:3000/es | grep -o '<html[^>]*>'
<html lang="es" dir="ltr" …>

$ curl -s localhost:3000/ar | grep -o '<html lang="[^"]*" dir="[^"]*"'
<html lang="ar" dir="rtl"
```

### What the exam engine did NOT notice

This is the part that mattered most. Translations are an overlay in their own table; the content
JSON, the content hash, the stem embedding and the generated search column are untouched.

| | |
|---|---|
| `ItemVariant.contentHash` values | unchanged — seen-windows and the unique index intact |
| `tp_item_variant_immutable` / `tp_approved_item_frozen` | never fired; nothing tried to edit frozen content |
| `MasterItem.searchText` generated column | untouched; `prisma/migrations.test.ts` still green |
| `stemEmbedding` and its 0.94 / 0.85 thresholds | untouched, so the dedupe calibration still holds |
| Existing `preferredLocale` data | preserved — 8 rows before, 8 rows after, values identical |

That last one was a near miss worth recording: `prisma migrate diff` proposed
`ALTER TABLE "Profile" DROP COLUMN "preferredLocale", ADD COLUMN … DEFAULT 'en'` for the enum → text
change, which would have silently reset every student who chose Norwegian. The migration converts
in place with `USING "preferredLocale"::TEXT` instead.

### Degradation

`src/server/services/i18n/i18n.test.ts` (26 cases) covers the layer that has to work when nothing
else does:

```
✓ the compiled registry still routes English and Norwegian
✓ falls back rather than throwing on an unknown locale  (es → en, "../admin" → en)
✓ merges a partial translation over English without losing a key
✓ never mutates the English catalogue it merges onto
✓ falls back to English, never to Norwegian, for a language nobody chose
✓ builds links for a language the registry learned about later
```

`en` and `nb` are static imports and are never read from the database, so a Postgres or Redis
outage degrades to exactly today's product rather than to a blank page.

### Two defects found on the way, both real

**The question navigator could not be tapped on a phone after answering.** In practice mode the
explanation appears below the options, and on a 390px viewport the action row then overlapped the
navigator — Playwright reported the click being intercepted, twice, by two different elements. It
was reproducible, not a timing flake. The navigator now sits above the actions with the auto margin
on it, which also puts Back/Next in the thumb zone.

**Two e2e tests shared one student.** Harmless until a half-finished test became resumable — after
which one test could pick up the attempt another had left open. It showed up as a flake rather than
a failure, which is the kind that gets chased for an afternoon six months later. Each test now
creates its own user.

### Totals

**299 unit/integration** (26 new), **26 e2e** (2 new), `tsc` and `eslint` clean.
