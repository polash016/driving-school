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
