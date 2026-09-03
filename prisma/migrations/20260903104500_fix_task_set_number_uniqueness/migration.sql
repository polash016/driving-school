-- spec-16 correction: task set numbers are unique WITHIN A BUILD, not within a licence class.
--
-- The original constraint made number preservation impossible. A rebuild deliberately re-issues
-- the numbers of the slices it preserves — that is the whole point, so a student's passed #7 does
-- not silently become different material — which means a DRAFT #7 must be able to coexist with
-- the PUBLISHED #7 it is going to replace, and with every ARCHIVED #7 before it. The old
-- constraint rejected the second one, so a second build could never be created.
--
-- HAND-WRITTEN (DECISIONS 2026-08-26): Prisma's own diff for this change also proposed dropping
-- both pgvector HNSW indexes and both generated-column defaults. Those statements are omitted.

-- DropIndex
DROP INDEX "TaskSet_licenseClassId_number_key";

-- CreateIndex
CREATE UNIQUE INDEX "TaskSet_buildId_number_key" ON "TaskSet"("buildId", "number");

-- The invariant that actually matters, and that Prisma cannot express: at most one PUBLISHED set
-- may carry a given number within a licence class. Without it, a bug in publish() could leave two
-- live #7s and a student's grid would show the same number twice.
CREATE UNIQUE INDEX "TaskSet_published_number_key"
  ON "TaskSet" ("licenseClassId", "number")
  WHERE "status" = 'PUBLISHED';
