# Spec 05 — AI Knowledge Base (RAG) & Structured Facts

## Objective

The legal ground truth every AI generation cites. No KB citation → no question.

## In scope

- Ingestion pipeline (script + admin upload): chunk legal source texts (Vegtrafikkloven, Trafikkreglene, Skiltforskriften, Forskrift om bruk av kjøretøy, temaliste, curriculum notes) into KbChunk with source metadata (law, section ref, url, effectiveDate); embed via AI gateway into pgvector; hybrid search (vector + keyword) service `kb.search(query, topicFilter)`.
- **Structured facts table**: key facts as typed rows (e.g., `bac_limit=0.2‰`, `speed_default_urban=50`, `tread_depth_winter=3mm`, source ref, effectiveFrom). Facts service with typed getters. Question templates reference fact keys, never literals.
- Sign registry: every skiltforskriften sign (code, official SVG asset path, bilingual name+meaning, signClass) seeded — this powers the sign test and image-detection mapping.
- Admin KB screen: list sources, re-ingest, view chunks, edit facts (with audit log), "affected items" lookup: given a fact/chunk, list MasterItems citing it (powers law-change re-review).

## Acceptance checklist

- [ ] `kb.search("vikeplikt høyreregel")` returns the right Trafikkreglene chunks (golden-set test with 10 queries).
- [ ] Changing a fact flags all citing MasterItems as NEEDS_REVIEW automatically (test).
- [ ] Sign registry complete for all sign classes; each sign renders its SVG in both locales.

---

## Amendment — 2026-08-24 (approved; see DECISIONS.md · spec-05 · AI provider registry)

**This spec's first deliverable, before the KB itself**: nothing here can run without a working AI
provider, and the school must be able to supply its own keys without a redeploy.

### Added scope

- **`AiProvider`** (kind `GOOGLE | ANTHROPIC | OPENAI_COMPATIBLE`, label, base URL, encrypted API key,
  active, priority) and **`AiRoute`** (task → provider + model id + ordered fallbacks) for the tasks
  `vision`, `generation`, `validation`, `embedding`, `image`. The OpenAI-compatible adapter covers
  DeepSeek, OpenRouter, Groq, Mistral, Ollama and the existing OmniRoute endpoint by base URL.
- **Gateway refactor** keeping the `aiJson` / `aiEmbed` surface unchanged: resolve provider + model per
  task from the DB (cached `tp:ai:routes`, 5 min, invalidated on save), dispatch to
  `src/server/ai/providers/*`, fall back down the chain on quota/5xx. Env keys remain the fallback so CI
  and dev need no database.
- **Admin screen `/admin/ai`**: add / rotate / delete keys (write-only — the UI shows `sk-…4f2a` and
  never the value), per-task routing, _Test connection_ (one cheap call reporting latency and model id),
  daily spend meter against the configured budget. Every mutation audit-logged.
- Keys are encrypted at rest with the AES-256-GCM helpers from spec-03
  (`src/server/services/auth/crypto.ts`), keyed from `AUTH_SECRET`.

### Added acceptance checklist

- [ ] A key added through the UI is never returned by any response: grep the rendered HTML, the RSC
      payload and every JSON boundary for the plaintext → no hit (test, not inspection).
- [ ] _Test connection_ succeeds against a live provider; forcing the primary to 429 makes the next
      route in the chain answer, and the fallback is logged with both model ids.
- [ ] Every AI call resolves its model from the DB route with env used only when no route exists (test).
