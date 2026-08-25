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

---

## Phase 1b — the AI translation pipeline (2026-08-25)

### Planning costs nothing, and says what a run will cost before you commit

```
$ pnpm i18n:translate es
Spanish (Español) — 698 unit(s) need translating.
  KB_SOURCE        1
  LICENSE_CLASS    1
  MASTER_ITEM      130
  TOPIC            32
  UI_MESSAGE       534
Estimated 293.2k in / 181.5k out ≈ $0.28. QA back-translation runs on 100% of units, which
roughly doubles that.
This language requires approval: translations will land for review, not in front of students.

Plan only. Re-run with --apply to translate.
```

No AI call is made to produce that. The estimate is a labelled guess; every row records its real
`promptTokens`/`completionTokens`, so the second language's estimate can come from the first
language's measurements instead.

### Real output, from the real bank

```
EN : The road is wet and visibility is poor. The sign says 80 km/h. What speed should you drive?
ES : La carretera está mojada y la visibilidad es escasa. La señal indica 80 km/h. ¿Qué velocidad
     debes llevar?
KEY: b   opts EN: a,b,c,d   opts ES: a,b,c,d      semanticScore 0.968
```

Option keys byte-identical, `80 km/h` intact, and the answer-integrity check returned the identity
permutation — every translated option still nearest to its own English source:

```
[{"key":"a","nearest":"a","self":0.8816}, {"key":"b","nearest":"b","self":1},
 {"key":"c","nearest":"c","self":1},       {"key":"d","nearest":"d","self":0.8004}]
```

That check is the one that answers "is the correct answer still correct". A swap here means the
key now points at a different meaning, and it is caught without a human reading the language.

### The approval switch does what it says

The same question, same data, with only the language's `requiresApproval` flag moved:

```
requiresApproval = true   → "The road is wet and visibility is poor…"   (English)
requiresApproval = false  → "La carretera está mojada y la visibilidad…" (Spanish)
```

Status records what happened; the resolver decides what is servable. So the switch takes effect
immediately, with no data migration, and turning it back on loses no audit trail.

### The exam engine did not notice — again

```
ItemVariant rows touched in the last hour | 0
MasterItem rows touched in the last hour  | 0
```

Five master translations produced five variant translations by derivation, at **zero token cost**.
Variants belonging to an older master version are deliberately not derived: showing a student a
translation of a different question than the English they sat is the exact failure this design
exists to prevent.

### A threshold I had wrong, corrected against real data

The first run flagged four of ten Spanish category names as `SEMANTIC_DRIFT` — and all four were
correct translations ("Glorietas" for "Roundabouts", "La regla de la derecha" for "The right-hand
rule"), scoring 0.637–0.872 while the other six scored 1.000.

Two or three words carry too little signal for a round-trip cosine to mean anything. The drift
check now runs only on units of 40 characters or more; short names keep the structural checks and,
where the language requires it, a human. A check that flags correct work is worse than no check,
because reviewers learn to ignore it.

Question stems are sentences and sit well above that floor — the five translated questions scored
0.826 to 0.968.

### Failing safe, observed rather than assumed

Two failure modes happened on their own during these runs, and both behaved correctly:

- **No route configured for the new task.** Batches failed, jobs were marked FAILED, the run paused
  and reported it. Nothing crashed. (Failed jobs are now re-queued on the next run, up to three
  attempts — without that, "resumable" would only have been true for the happy path.)
- **The QA provider rate-limited us.** Five units came back `QA_UNAVAILABLE` and were held for
  review rather than served unverified. Worth knowing operationally: a school on a free tier will
  see more held items, because a QA call that cannot run is treated as a QA failure.

### Tests

22 new cases in `translation.test.ts`, each a way a translated exam could go wrong quietly:

```
✓ refuses a changed speed limit — the error that would mark a right answer wrong
✓ refuses a renamed option key — the keys are how the languages stay gradable together
✓ refuses a translation that lost the option the answer key points at
✓ refuses a translated legal reference — a § is an address, not prose
✓ refuses output that is just the input echoed back
✓ refuses Latin text for a language that does not use it
✓ refuses a dropped ICU placeholder — that is a crash, not a typo
✓ renders a missing option in English rather than throwing
✓ serves machine translations only where the language allows it
✓ changes when the glossary changes — new terminology means re-translating
```

Totals: **321 unit/integration**, **26 e2e**, `tsc` and `eslint` clean.

---

## Phase 1c — the admin surface (2026-08-25)

### The board

`/admin/languages` (ADMIN) lists every language with its coverage as **numbers, not just a bar** —
because English is merged underneath every catalogue, a half-translated language *looks* finished
to anyone who cannot read it. "412 of 698" is the only honest way to state it.

Per language: check what is left (no AI call, shows the estimated cost first), translate a slice,
require approval or stop requiring it, and show or hide from students.

### The gate, enforced in the service and not only in the UI

```
✓ refuses to show an unfinished language to students
✓ counts a translation only while it still matches its source
✓ counts machine output only when the language does not require approval
✓ never counts something a check flagged or a reviewer refused
✓ always serves a new language at /<code>, whatever anyone would prefer
✓ refuses a language that already exists / a built-in / a code that is not a language tag
```

The stale-source case is the one worth calling out: a translation stamped with a hash that no
longer matches its source does not count as coverage. Without that, editing a question would
silently un-translate it while the dashboard kept claiming 100%.

### The review screen

`/admin/languages/[code]` is **INSTRUCTOR**, not ADMIN — judging a translation needs someone who
reads the language, and that is usually a teacher rather than whoever holds the admin account.

Source left, translation right, in the language's own direction. Option rows are keyed by option
key, so a swapped or missing option is visible without reading a word — a missing one renders as
"not translated" in red rather than as a shorter list nobody notices.

QA codes are rendered as sentences: the reviewer reads the language but does not read our source,
so `NUMBER_DRIFT` becomes **"A number changed"** and `ANSWER_PERMUTED` becomes **"The options may
have swapped meaning."**

A correction is worth more than an approval, so it is re-checked structurally (a human drops a
placeholder as easily as a model does) and then written into translation memory — the reviewer's
wording is reused everywhere that source text appears, instead of being fixed once and
re-generated wrongly next time.

```
✓ a reviewer sees the source beside the translation, with the flag in words
✓ the language board is admin-only, and an unfinished language stays hidden
```

Every question's detail page also carries a **this question in every language** table, so a
reviewer can check one question across all of them at once.

### Two more defects found and fixed

**The quiz controls could be un-tappable on a phone.** I thought I had fixed this by moving the
navigator; I had not. The real cause was `mt-auto` pinning it to the bottom — pretty when the
content is short, but once a practice explanation appears at 390px the flex children overlapped and
whatever sat underneath stopped receiving clicks. It is now a plain top-to-bottom column that grows
and scrolls. A reachable control beats a tidy one.

**The e2e cleanup fought its own safety triggers.** It used a global `ALTER TABLE … DISABLE
TRIGGER`, which is visible to every other connection and can be re-enabled underneath a
concurrently-running spec file. Replaced with `SET LOCAL session_replication_role = 'replica'`
inside one pinned transaction: scoped to that transaction, invisible to anything else, and leaves
nothing disabled if the process dies. Three consecutive full e2e runs, 28 passed each.

### Totals

**330 unit/integration**, **28 e2e**, `tsc` and `eslint` clean.
