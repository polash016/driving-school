-- Spec-04: the admin question table sorts by most-recently-edited; nothing indexed that.
-- NOTE: generated-column / HNSW drop statements removed on purpose (migrations.test.ts).

-- CreateIndex
CREATE INDEX "MasterItem_status_updatedAt_idx" ON "MasterItem"("status", "updatedAt" DESC);
