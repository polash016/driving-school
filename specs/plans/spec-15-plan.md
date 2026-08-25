# Plan — Spec-15: Dynamic languages & AI translation

## Context

Today the platform is bilingual by construction: `en` and `nb` are baked into a Prisma enum, two
separate Zod enums, a Postgres GENERATED column whose SQL literally names `'en'` and `'nb'`, and a
`{ en, nb }` JSON shape on every content column with **both keys required**. Adding Arabic or
Spanish is not a config change — it is a change to how the product thinks about language.

You want: an admin adds a language → AI translates everything that already exists → a teacher who
speaks it can review and approve (or not, your choice per language) → students see the site and
sit tests in it. Accurately, and without burning tokens re-translating what has not changed.

This becomes **spec-15**, delivered in two phases (your call): the engine proven with Spanish
first, then Arabic with right-to-left layout.

---

## The three constraints that shape everything

**1. Translations cannot live in the existing content JSON.** `ItemVariant.content` is frozen by
the `tp_item_variant_immutable` trigger, and its `contentHash` is both `@unique` _and_ the
per-student seen-window key (`tp:quiz:seen:<userId>`). Writing a third locale into that JSON would
change every hash, break every student's seen-window, and fight the immutability guarantees built
for defensibility. Same for `MasterItem.content` once APPROVED (`tp_approved_item_frozen`).

→ Translations live in a **separate, locale-keyed table**, overlaid at render time. `contentHash`,
`stemEmbedding` (calibrated on the en+nb concatenation) and the guarded `searchText` column are
**never touched**. Zero risk to the exam engine, zero migration of existing content.

**2. The locale set is hardcoded in four places** — `prisma enum Locale`, `contracts/common.ts`,
`config/school.config.ts`, and `LOCALE_PREFIXES`. All four must become runtime data. One BCP-47
schema in a new client-safe `src/lib/locale.ts` replaces both duplicate Zod enums; `school.config`
keeps its list, redefined as the _compiled fallback set_ rather than the truth.

**3. There is no job runner.** BullMQ is not installed. Batch work is `tsx` scripts. Translation is
therefore a **resumable, chunked service** driven by a script _and_ an admin button — not a queue.

Two facts that make this feasible, both verified:

- Next 16's `proxy.ts` **defaults to the Node.js runtime**, so locale middleware can read Redis.
- next-intl's `Locale` type resolves to `string` (this app does not augment `AppConfig`), so
  arbitrary language codes typecheck, and `getRequestConfig` may return messages from any async
  source — including the database.

---

## Decisions

- **D1 — Translations are an overlay, never an edit.** A `Translation` row keyed
  `(locale, entity, entityId, field)` carrying the translated string plus the `sourceHash` it was
  made from. Render merges overlay over the `en` base by **option key** — keys are already the
  cross-locale join and the option shuffle is locale-agnostic, so this works with no engine change.
  Missing or unapproved → falls back to English. `buildClientQuestion` stops being able to throw.
- **D2 — `en` is the base catalogue and the universal fallback; `nb` stays a base locale.** `en`
  and `nb` keep living in the JSON columns and the on-disk message files exactly as today. Only
  _added_ languages use the overlay. Nothing about the existing two-language product changes.
- **D3 — Translate a question as one unit, never string-by-string.** Stem, all options and the
  explanation go to the model together, with **both** the Norwegian (the legal source) and the
  English (the fluent pivot) as context. A question is a single semantic object: translating an
  option in isolation is how "must yield" quietly becomes "should yield" and the answer key stops
  being right.
- **D4 — Approval is per language, and it is your switch.** `Language.requiresApproval` — on, and
  a translation is `MACHINE` until a reviewer approves it and English shows meanwhile; off, and it
  serves as soon as the AI finishes. Mirrors `aiApprovalsRequired` in `security-policy.ts`.
- **D5 — A language reaches students only at 100% coverage.** `studentVisible` cannot be turned on
  below full coverage of every required unit. No student ever meets a half-Arabic test.
- **D6 — § references are never translated.** Citations are `{sourceCode, ref}` — `"§ 7"` is a
  legal address, not prose. What _is_ translated is the source's display name (`KbSource.name`,
  monolingual today). Students currently see the raw slug, `"trafikkreglene § 7"`; this becomes a
  translated label plus the verbatim reference. The knowledge base itself stays Norwegian: it is
  the grounding the AI cites, and a translation layer between a question and the law it rests on is
  exactly what a disputed mark does not need.

---

## Phase 1 — the language engine, proven with Spanish

### Schema (one migration)

```prisma
enum TextDirection { LTR RTL }
enum TranslationStatus { MACHINE  APPROVED  REJECTED }
enum TranslationEntity { UI_MESSAGE  ITEM_STEM  ITEM_OPTION  ITEM_EXPLANATION
                         TOPIC_NAME  TOPIC_DESCRIPTION  LICENSE_CLASS_NAME
                         SIGN_NAME  SIGN_MEANING  KB_SOURCE_NAME }

/// A language the school offers. `en` and `nb` are seeded as base languages: their content lives
/// in the {en,nb} JSON columns and the on-disk catalogues, and they are never overlaid.
model Language {
  code             String        @id                      // BCP-47: "en","nb","es","ar"
  englishName      String
  nativeName       String                                 // shown in the switcher
  urlPrefix        String        @unique                  // "/en","/no","/es","/ar"
  direction        TextDirection @default(LTR)
  isBase           Boolean       @default(false)
  requiresApproval Boolean       @default(true)           // D4
  studentVisible   Boolean       @default(false)          // D5 — gated on 100% coverage
  fallbackCode     String        @default("en")
  sortOrder        Int           @default(0)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([studentVisible, sortOrder])   // the switcher + the registry load
}

model Translation {
  id            String            @id @default(cuid())
  locale        String
  entity        TranslationEntity
  entityId      String                                    // MasterItem id, Topic id, or UI key
  field         String            @default("")            // option key for ITEM_OPTION, else ""
  value         String
  /// sha256 of the source text this was translated from. Source changed → stale → re-translate.
  sourceHash    String
  status        TranslationStatus @default(MACHINE)
  modelVersion  String?
  promptVersion String?
  /// Cosine between the source and translated stem in a multilingual embedding space.
  qaScore       Float?
  qaFlags       String[]
  reviewedById  String?
  reviewedAt    DateTime?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([locale, entity, entityId, field])  // upsert target; one translation per field
  @@index([locale, entity, entityId])          // batch overlay load for a page or an attempt
  @@index([locale, status, entity])            // review queue + coverage counts
}

/// Content-addressed reuse: the same source string translated once, ever. Option texts, topic
/// names and short UI strings repeat heavily — this is most of the token saving.
model TranslationMemory {
  sourceHash String
  locale     String
  value      String
  createdAt  DateTime @default(now())
  @@id([sourceHash, locale])
}

/// The termbase. Injected into every translation prompt — this is what makes a term render the
/// same way in question 3 and question 91, which is what a reviewer actually notices.
model TranslationTerm {
  id     String @id @default(cuid())
  locale String
  source String            // "vikeplikt" / "right of way"
  value  String
  note   String?
  @@unique([locale, source])
}

/// A translation run, so progress survives a page reload and a killed process.
model TranslationBatch {
  id          String   @id @default(cuid())
  locale      String
  status      BatchStatus @default(PENDING)   // reuses the existing enum
  requested   Int      @default(0)
  completed   Int      @default(0)
  failed      Int      @default(0)
  flagged     Int      @default(0)
  createdById String?
  startedAt   DateTime @default(now())
  finishedAt  DateTime?
  @@index([locale, startedAt(sort: Desc)])
}
```

Plus: `Profile.preferredLocale` **enum → String** (`ALTER COLUMN … TYPE TEXT USING …::text`, then
drop `enum Locale`) — 8 production call sites, all pass-through. And `ExamAttempt.locale String`,
set at start: a disputed mark must be answerable with _the language the student actually sat it
in_. `AiTask` gains `TRANSLATION`.

### Locale runtime — `src/i18n/`

- **`registry.ts` (new)** — four layers, each falling back to the next:
  `globalThis` memo (30 s) → Redis `tp:i18n:registry` (1 h) → Postgres → **compiled `en`/`nb`**.
  The compiled floor is what makes "DB and Redis both down" degrade to exactly today's behaviour:
  the built-ins are never read from the database. `invalidateRegistry()` clears the memo and the
  Redis key on any language change; because Next 16 requires the middleware in-process, that memo
  is shared with the proxy and invalidation is synchronous — with the 30 s TTL as the fallback if
  that ever stops holding.
- **`navigation.ts`** — **no change.** Verified in next-intl 4.13.7: `createNavigation` never reads
  `routing.locales`. It builds `Link`/`redirect`/`getPathname` from `localePrefix.mode`,
  `localePrefix.prefixes` and `localeCookie` only, and `getLocalePrefix()` falls back to
  `/<locale>` for anything not in the prefixes map. So `<Link locale="ar">` already emits
  `/ar/login` for a language that did not exist at build time. _(An earlier draft of this plan
  proposed replacing these with in-house wrappers — that was wrong, and it is now deleted work.)_
- **`routing.ts`** — stays **static and client-safe** (it reaches the client through
  `navigation.ts`, so it can never be async). It only needs `localePrefix.prefixes` for the
  built-ins and `defaultLocale`.
- **`runtime-routing.ts` (new, server-only)** — `routingFor(snapshot)` builds a routing object from
  the live registry.
- **`proxy.ts`** — keep `createMiddleware`, construct it per request:
  `createMiddleware(routingFor(await getRegistrySnapshot()))(request)`. Verified: `createMiddleware`
  re-reads `locales`/`localePrefix` from its closed-over config on every call and does nothing but
  two object spreads at construction, so this is public API and costs nanoseconds. It keeps
  accept-language negotiation, `NEXT_LOCALE` sync, the `x-next-intl-locale` header contract that
  `getRequestConfig` depends on, and open-redirect sanitisation — all of which a hand-rolled
  matcher would have to reimplement. **The proxy must not import Prisma**: `src/server/db.ts` only
  pins to `globalThis` outside production, so importing it into the middleware bundle creates a
  second connection pool. Registry reads there go memo → Redis → compiled fallback.
- **`request.ts`** — messages become `base(en.json) ⟵ merge ⟵ locale file if base ⟵ merge ⟵ DB
overlay`. English is always the floor, so a missing key renders English, never a raw key.
- **`src/lib/locale-url.ts`** — `LOCALE_PREFIXES` becomes a registry lookup; `localePath` /
  `absoluteUrl` keep their signatures (used by auth redirects and emails).
- **`src/lib/i18n-content.ts`** — `pickLocale` / `pickBilingualText` gain an optional overlay and a
  real fallback chain (requested → `fallbackCode` → `en`), replacing today's binary flip.
- **`src/server/email/templates.ts`** — the static `{ en, nb }` catalogue map becomes the same
  merged loader, so a student whose `preferredLocale` is `es` gets a Spanish email.
- **`layout.tsx`** — `<html lang dir>` from the registry; **delete `generateStaticParams`** — it
  prerenders nothing today (`AccountMenu` calls `auth()`, which makes the layout dynamic;
  `.next/prerender-manifest.json` confirms zero routes under `[locale]`). Landmine to document:
  adding `export const dynamicParams = false` anywhere in this tree would 404 every runtime
  language.

### Translation store & resolver — `src/server/services/i18n/`

- **`registry.ts`** — CRUD for `Language`, coverage computation, `studentVisible` gate (D5).
- **`resolve.ts`** — `loadOverlay(locale, entity, ids[])` → `Map`, one batched query, Redis-cached
  per `(locale, entity)` bucket (`tp:i18n:tr:<locale>:<entity>`), invalidated on approve/import.
  Returns empty for base locales. **No N+1**: `servedRows()` loads one overlay per attempt.
- **`serializer.ts` / `attempt-service.ts`** — `buildClientQuestion(row, locale, overlay?)` merges
  by option key; any key absent from the overlay keeps its English text instead of throwing.
- **Coverage units**: 1 per question (stem+options+explanation as one unit), 1 per topic name,
  1 per UI message key, etc. Current volume: **130 questions, 32 topics, 1 licence class,
  1 KB source, 534 UI keys** — measured, not estimated.

### AI pipeline — `src/server/services/i18n/translate.ts`

- New `translation` task in the gateway (touches 5 places: `AiTask` union, `TASK_ENUM`, Prisma
  enum, `aiTaskSchema`, the admin `TASKS` const — plus `schoolConfig.ai.models` for the env
  fallback).
- **`translation.question` v1.0.0** — one question per unit, en + nb both as source, glossary
  injected, target language named. Hard rules: return the **same option keys**, keep `§`
  references, numbers and units verbatim, preserve register, and the option that is correct must
  remain unambiguously correct.
- **`translation.ui` v1.0.0** — batches of ~60 message keys. Hard rule: **ICU placeholders survive
  exactly** — 45 of the 534 keys carry `{count}`, `{minutes}`, `{school}` and friends; a dropped
  placeholder is a crash, not a typo.
- **Sync** = find every unit where no `Translation` row exists _or_ `sourceHash` has moved, and
  translate only those. Hooked into `transitionItem(→ APPROVED)` so new questions queue themselves.
- **Token discipline**: `TranslationMemory` lookup by `sourceHash` before any call; batching;
  glossary instead of re-explaining terminology; cheap model routed to the translation task.

### Accuracy QA (runs on every translated unit)

1. **Structural** — option keys identical and same count, no empty values, ICU placeholders
   preserved, no placeholder leakage, length within sane bounds of the source.
2. **Semantic drift** — embed the source stem and the translated stem and compare with `cosine()`.
   Both already exist in `similarity.ts`, and the embedding model is multilingual, so this needs no
   back-translation round trip. Below threshold → `qaFlags` and forced review.
3. **Answer integrity** — of the translated options, the one under the correct key must be the
   nearest neighbour of the _English_ correct option. This catches the failure that actually
   matters: options translated in a way that moves the answer.

Anything flagged goes to review regardless of `requiresApproval`.

### Admin UI — `(admin)/admin/languages/`

- **Board**: languages with coverage bars, direction, approval toggle, `studentVisible` gate,
  "Sync now" and last-run summary. Mirrors `provider-panel.tsx` — server actions,
  `requireUser("ADMIN")` outside the try, `ActionResult`, audited.
- **Review queue** `/admin/languages/[code]/review`: source (en + nb) beside the translation,
  QA flags shown, approve / reject / edit, keyboard-driven — reuses the `review-queue.tsx` pattern.
- **Language tabs on the question detail page** so a reviewing teacher sees one question in every
  language side by side. _(You asked for this explicitly.)_ Admin chrome itself stays en/nb.

### Student UI

Switcher becomes a dropdown above two languages, listing `nativeName`, only `studentVisible`
languages. Everything else is already locale-driven.

### Tests

`messages.test.ts` becomes "every base catalogue matches `en`'s key set; DB catalogues report
missing keys as coverage, not failure" · registry fallback when Redis is down · prefix routing and
`/no` alias preserved · overlay merge (missing option → English, never throw) · `contentHash`
unchanged after translating an item (**the regression that would break seen-windows**) · QA rejects
a dropped ICU placeholder, a changed option key, and a moved answer · coverage gate refuses
`studentVisible` below 100% · e2e: add a language → sync → approve → student sits a Spanish test →
history renders in Spanish · axe on `/es`.

---

## Phase 2 — Arabic and right-to-left

- `dir` driven by `Language.direction`; `LocaleProvider` exposes it to client components.
- Convert the **32 physical direction utilities** in student-facing components (`ml-`/`mr-`/`pl-`/
  `pr-`/`left-`/`right-`/`text-left`/`border-l`/`rounded-l`/`inset-x-`) to logical equivalents
  (`ms-`/`me-`/`ps-`/`pe-`/`start-`/`end-`/`text-start`/`border-s`/`rounded-s`). Densest: `ui/button.tsx`,
  `ui/sheet.tsx`, `ui/dialog.tsx`, `ui/card.tsx`, `quiz/question-card.tsx`, `quiz/recent-tests.tsx`.
- Arabic font via `next/font` with `subsets: ["arabic"]` (Geist has no Arabic coverage), applied
  through a CSS variable when `dir="rtl"`.
- Tests: e2e Arabic exam run, no horizontal scroll at 390px, axe on `/ar`, and a mirrored-layout
  assertion on the exam runner.

---

## Token budget (measured against current content)

|                                          | per language, one-off                          |
| ---------------------------------------- | ---------------------------------------------- |
| 130 questions (en+nb source in, batched) | ~66k                                           |
| 534 UI keys (batched 60/call)            | ~17k                                           |
| 32 topics + licence class + source name  | ~3k                                            |
| QA embeddings                            | negligible (multilingual embed, no round trip) |
| **Total**                                | **≈ 85–90k tokens**                            |

Incremental sync afterwards costs only what changed — a new question is ~500 tokens.
`TranslationMemory` removes repeated option texts and topic names entirely.

---

## Verification

Evidence into `specs/notes/spec-15-notes.md`, per WORKFLOW:

- Add Spanish in the admin UI → sync → coverage reaches 100% → `studentVisible` unlocks → a student
  sits and submits a Spanish test → `/account/history` renders that paper in Spanish → the attempt
  records `locale = es`.
- `contentHash` for every existing variant is byte-identical before and after translation (proves
  the seen-window and the immutability triggers are untouched).
- Turn `requiresApproval` on for a second language → machine translations do **not** reach students
  → approve one → it appears.
- Kill the sync mid-run → re-run → it resumes and re-translates nothing already done.
- QA: hand-corrupt a translation (drop `{count}`, rename an option key, swap the answer) → each is
  caught and flagged.
- Redis flushed → app still routes `/en` and `/no`.
- Phase 2: `/ar` renders RTL, axe clean, no horizontal scroll at 390px.

---

## What this deliberately does not do

- **The knowledge base stays Norwegian.** It is the legal grounding the AI cites; translating it
  would add a translation layer between a question and the law it rests on.
- **Templated questions are excluded from v1.** `parameterSlots` is unused today (0 of 139 items),
  and translating a template means preserving `{{slot}}` placeholders through an AI round trip.
  They fall back to English and are named in the coverage report.
- **Admin chrome stays en/nb** — except the per-question language tabs a reviewer needs.
- **No job queue is introduced.** If translation later needs to run unattended at scale, BullMQ is
  the answer, and it is spec-06's decision to make, not this one's.
