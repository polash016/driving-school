-- spec-23: three translatable entities for the Learn section.
--
-- Kept in its own migration: Postgres refuses to USE a freshly added enum value inside the same
-- transaction that added it, and the tables migration that follows references them.
--
-- Reversal: recreate the type without these three values (only valid while no Translation row
-- carries them — the tables migration's DROPs come first on the way down).
--
-- Prisma also proposed dropping the two HNSW indexes and the generated-column defaults; those
-- four statements were removed by hand, as prisma/migrations.test.ts requires.

ALTER TYPE "TranslatableEntity" ADD VALUE 'LEARN_BOOK';
ALTER TYPE "TranslatableEntity" ADD VALUE 'LEARN_DOCUMENT';
ALTER TYPE "TranslatableEntity" ADD VALUE 'LEARN_SECTION';
