-- Question similarity: stem embeddings so the AI stops rewriting questions it has already
-- written, and concept groups so two phrasings of one rule never land in the same test.
-- NOTE: generated-column / HNSW drop statements removed on purpose (migrations.test.ts).



-- AlterTable
ALTER TABLE "MasterItem" ADD COLUMN     "conceptGroupId" TEXT,
ADD COLUMN     "stemEmbedding" vector(1536);

-- CreateIndex
CREATE INDEX "MasterItem_conceptGroupId_idx" ON "MasterItem"("conceptGroupId");

-- ANN index over question stems (cosine), the same shape the knowledge base uses.
CREATE INDEX "MasterItem_stemEmbedding_hnsw_idx" ON "MasterItem"
  USING hnsw ("stemEmbedding" vector_cosine_ops);
