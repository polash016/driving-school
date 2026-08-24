-- Hybrid search support for KbChunk (spec-05): vector ANN + keyword full-text.
-- These are raw SQL because Prisma cannot express HNSW indexes or generated tsvector columns.

-- ANN index for kb.search vector leg (cosine distance)
CREATE INDEX "KbChunk_embedding_hnsw_idx" ON "KbChunk"
  USING hnsw ("embedding" vector_cosine_ops);

-- Keyword leg: generated tsvector (norwegian stemming — source texts are Norwegian law) + GIN
ALTER TABLE "KbChunk"
  ADD COLUMN "textSearch" tsvector
  GENERATED ALWAYS AS (to_tsvector('norwegian', "text")) STORED;

CREATE INDEX "KbChunk_textSearch_idx" ON "KbChunk" USING GIN ("textSearch");
