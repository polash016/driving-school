-- Sign provenance (sign registry seeded from the theory book).
--
-- `provisional` marks a row that still carries extracted graphics, an internal placeholder code
-- and AI-drafted text rather than the official Statens vegvesen asset pack; `sourceNote` records
-- where it came from. Together they are what /admin/signs filters on so a human can work through
-- them. Neither is ever shown to a student.
--
-- NOTE: `prisma migrate dev` also proposed dropping the HNSW indexes and the GENERATED tsvector
-- defaults on KbChunk/MasterItem, because Prisma cannot express either. Those statements were
-- stripped by hand — see prisma/migrations.test.ts, which fails the build if they are ever
-- committed. Do the same for every future migration.
ALTER TABLE "Sign"
  ADD COLUMN "provisional" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "sourceNote" TEXT;
