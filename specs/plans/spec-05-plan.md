# Plan — Spec 05: AI Knowledge Base (RAG) & Structured Facts (detailed, authored by Fable for Opus)

## Decisions (binding)
- Hybrid search = vector (pgvector HNSW, cosine) + keyword (`textSearch` tsvector, norwegian config, GIN) — **both already migrated** (spec-02 `kb_hybrid_search`). Fusion: Reciprocal Rank Fusion `score = Σ 1/(60 + rank)` over the two result lists — simple, tuning-free, testable.
- Embeddings via `aiEmbed()` from `src/server/ai/client.ts` (dimension 1536 = `KbChunk.embedding vector(1536)`), raw SQL for vector ops (`$queryRaw` with `embedding <=> $1::vector`).
- Chunking: by section (`§`) boundaries first, fallback sliding window ~800 tokens / 15% overlap; every chunk carries `ref` (section) — citations depend on this.
- Facts: typed getters `facts.getNumber(key)` etc. from the `Fact` table, snapshot-cached (`tp:kb:facts`, TTL 1h, invalidated on edit). Template expansion (quiz engine) consumes `Record<string,string>` from `facts.snapshot()`.
- Fact/chunk change → re-review: service updates `MasterItem.status = NEEDS_REVIEW` for all items via `MasterItemCitation` (indexes `(factKey)`, `(kbChunkId)` exist) + audit log entry. This is THE law-change safety mechanism.
- Sign registry seeding: `prisma/seed-signs.ts` from a JSON manifest (`prisma/data/signs.json`: code, class, bilingual name/meaning, svg path under `public/signs/`). Official SVGs: developer supplies the asset pack (Statens vegvesen skiltdatabase); seed validates every manifest entry has an existing file. Do NOT scrape at build time.

## Services & files
- `src/server/services/kb/{ingest.ts,search.ts,facts.ts,affected-items.ts}`; contracts already in `contracts/kb.ts` (import).
- Ingestion: script `pnpm kb:ingest <sourceCode> <file>` + admin upload path → BullMQ `ai-generation`-adjacent queue NOT needed; ingestion can run inline in a server action for small texts, queued for large (worker exists after spec-06; until then inline with progress).
- Admin KB screens (desktop-first): sources list + re-ingest, chunk browser, facts editor (with audit + "affected items" preview before saving), golden-query test page.

## Acceptance → tests
- Golden set: `src/server/services/kb/golden.test.ts` with 10 bilingual queries (e.g. "vikeplikt høyreregel" → Trafikkreglene § 7 chunks) — integration test against test DB with a small ingested corpus committed as fixture text.
- Fact change flags citing items: integration test (create item + citation → change fact → status NEEDS_REVIEW + audit row).
- Sign registry completeness: test asserts every `SignClass` enum value has ≥1 sign and every seeded sign's SVG file exists; sign detail renders in both locales (e2e).

## Pitfalls
- `kb.search` latency budget: p95 <150ms → embed the QUERY via gateway only when a Redis-cached embedding for the exact query string is absent (`tp:kb:qemb:<hash>`, TTL 24h); keyword leg always local.
- Never let generation cite a chunk that `isActive=false`.
- Facts service returns typed values but stores strings — parse at the getter, throw `ValidationError` on corrupt values.
