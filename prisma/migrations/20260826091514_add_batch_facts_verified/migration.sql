-- Whether a human had confirmed the source image's context sheet BEFORE this batch ran (spec-06).
--
-- Snapshotted on the batch rather than read from the image at display time: confirming the sheet
-- afterwards must not retroactively make these questions look as though they were built on
-- verified ground. The review queue shows it, because a reviewer looking at a `false` is checking
-- the FACTS as well as the wording.
--
-- NOTE: `prisma migrate dev` also proposed dropping the HNSW indexes and the GENERATED tsvector
-- defaults on KbChunk/MasterItem, because Prisma cannot express either. Those statements were
-- stripped by hand — see prisma/migrations.test.ts, which fails the build if they are committed.
ALTER TABLE "GenerationBatch"
  ADD COLUMN "factsVerified" BOOLEAN NOT NULL DEFAULT false;
