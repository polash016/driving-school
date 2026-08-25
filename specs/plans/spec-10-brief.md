# Brief — Spec 10: Reference Library & Utilities (Opus expands to a full plan)

**Import, don't reinvent:** Sign registry table + `contracts/models.ts` signSchema (seeded in spec-05), `kb.search` for "related rules with citations", quiz engine SIGN mode for "Quiz me on this group", feature flags from school.config.

**Key decisions already made**

- Signs catalog: group by `SignClass`, bilingual search over `name` Json (Postgres `ILIKE` on both locales is fine at registry scale — no index gymnastics needed), sign detail = SVG + meaning + related rules (`kb.search(sign name, limit 3)` cached per sign).
- Road-markings catalog mirrors the sign pattern (add markings to the sign manifest with their own SignClass MARKERING — table already supports it).
- Curriculum articles: DB-backed bilingual MDX-lite (store markdown per locale in a `CurriculumArticle` table — new small migration: slug unique, topicId, title Json, body Json, updatedById). Instructor-editable (spec-11 nav links to editor). Wrong-answer "Read more" links by topic slug.
- Trailer calculator: PURE typed function `src/server/services/trailer.ts` — inputs/outputs via a new `contracts/trailer.ts`; verdict ∈ {B, B96, BE, NOT_ALLOWED} with rule citations; ≥15 unit cases incl. boundary weights (3500kg combos). UI behind `featureFlags.trailerCalculator` with the mandated "guidance only" disclaimer (bilingual).
- Public demo quiz: separate anonymous path — a demo pool (masters tagged via a `isDemoPool` boolean… decision: use a dedicated Topic slug `demo` instead, no schema change), assembled with a fixed seed per IP-day, rate-limited (`keys.rateLimit`), results teaser + school contact CTA (from config), `noindex` meta on results.

**Pitfalls:** student panel viewport rule applies (390px); demo quiz must NEVER touch `authorize()`-protected services with a fake user — build a thin anonymous wrapper that only reads the demo topic; keep sign SVGs served statically with long cache headers.
