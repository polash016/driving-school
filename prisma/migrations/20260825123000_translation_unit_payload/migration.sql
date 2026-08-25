-- Spec-15, corrective: the translation UNIT is the row, not the field.
--
-- The first cut stored one row per translated field. For exam content that is the wrong grain:
-- fallback has to be all-or-nothing per question, because an Arabic stem with English options is
-- worse for a graded assessment than plain English throughout. One row per unit also gives one
-- source hash, one QA report and one approve action per question — which is what a reviewer acts
-- on. (UI messages keep per-key granularity by being their own units.)
--
-- Also adds NEEDS_REVIEW (a QA-flagged translation is never served under ANY policy), the
-- master → variant distinction (the master is reviewed, the variant is served), and the run/job
-- pair that stands in for the job queue this stack does not have.
--
-- Safe as a drop-and-recreate: these tables were created hours ago and hold no rows. `Language`
-- and its seeded en/nb rows are deliberately left alone.
--
-- NOTE: generated-column / HNSW drop statements removed on purpose (prisma/migrations.test.ts).

-- DropTable
DROP TABLE "Translation";
DROP TABLE "TranslationMemory";
DROP TABLE "TranslationTerm";
DROP TABLE "TranslationBatch";

-- DropEnum
DROP TYPE "TranslationStatus";
DROP TYPE "TranslationEntity";

-- CreateEnum
CREATE TYPE "TranslationStatus" AS ENUM ('MACHINE', 'NEEDS_REVIEW', 'APPROVED', 'REJECTED');
CREATE TYPE "TranslatableEntity" AS ENUM ('UI_MESSAGE', 'MASTER_ITEM', 'ITEM_VARIANT', 'TOPIC', 'LICENSE_CLASS', 'SIGN', 'EXAM_BLUEPRINT', 'KB_SOURCE', 'FACT');
CREATE TYPE "TranslationRunKind" AS ENUM ('FULL', 'SYNC', 'SINGLE_ENTITY');
CREATE TYPE "TranslationRunStatus" AS ENUM ('PENDING', 'RUNNING', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED');
CREATE TYPE "TranslationJobState" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'FAILED', 'SKIPPED');

-- AlterTable: language-level translation policy.
ALTER TABLE "Language"
  ADD COLUMN "minApprovers"    INTEGER          NOT NULL DEFAULT 1,
  ADD COLUMN "qaSampleRate"    DOUBLE PRECISION NOT NULL DEFAULT 1,
  ADD COLUMN "glossary"        JSONB,
  ADD COLUMN "glossaryVersion" INTEGER          NOT NULL DEFAULT 1,
  ADD COLUMN "styleNote"       TEXT,
  ADD COLUMN "lastSyncedAt"    TIMESTAMP(3);

-- CreateTable
CREATE TABLE "TranslationRun" (
    "id"               TEXT NOT NULL,
    "locale"           TEXT NOT NULL,
    "kind"             "TranslationRunKind" NOT NULL,
    "status"           "TranslationRunStatus" NOT NULL DEFAULT 'PENDING',
    "plannedUnits"     INTEGER NOT NULL DEFAULT 0,
    "translatedUnits"  INTEGER NOT NULL DEFAULT 0,
    "memoryHits"       INTEGER NOT NULL DEFAULT 0,
    "failedUnits"      INTEGER NOT NULL DEFAULT 0,
    "flaggedUnits"     INTEGER NOT NULL DEFAULT 0,
    "promptTokens"     INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "estimatedUsd"     DOUBLE PRECISION NOT NULL DEFAULT 0,
    "error"            TEXT,
    "leaseOwner"       TEXT,
    "leaseExpiresAt"   TIMESTAMP(3),
    "startedById"      TEXT,
    "startedAt"        TIMESTAMP(3),
    "finishedAt"       TIMESTAMP(3),
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TranslationRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TranslationJob" (
    "id"         TEXT NOT NULL,
    "runId"      TEXT NOT NULL,
    "entity"     "TranslatableEntity" NOT NULL,
    "entityId"   TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "state"      "TranslationJobState" NOT NULL DEFAULT 'QUEUED',
    "attempts"   INTEGER NOT NULL DEFAULT 0,
    "error"      TEXT,
    "startedAt"  TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "TranslationJob_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Translation" (
    "id"               TEXT NOT NULL,
    "locale"           TEXT NOT NULL,
    "entity"           "TranslatableEntity" NOT NULL,
    "entityId"         TEXT NOT NULL,
    "value"            JSONB NOT NULL,
    "status"           "TranslationStatus" NOT NULL DEFAULT 'MACHINE',
    "sourceHash"       TEXT NOT NULL,
    "sourceLocale"     TEXT NOT NULL DEFAULT 'en',
    "modelVersion"     TEXT,
    "promptVersion"    TEXT,
    "providerLabel"    TEXT,
    "promptTokens"     INTEGER,
    "completionTokens" INTEGER,
    "fromMemory"       BOOLEAN NOT NULL DEFAULT false,
    "qaReport"         JSONB,
    "semanticScore"    DOUBLE PRECISION,
    "qaFlags"          TEXT[],
    "reviewedById"     TEXT,
    "reviewedAt"       TIMESTAMP(3),
    "reviewNote"       TEXT,
    "runId"            TEXT,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Translation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TranslationMemory" (
    "id"              TEXT NOT NULL,
    "locale"          TEXT NOT NULL,
    "sourceHash"      TEXT NOT NULL,
    "contextKind"     "TranslatableEntity" NOT NULL,
    "value"           JSONB NOT NULL,
    "hits"            INTEGER NOT NULL DEFAULT 0,
    "modelVersion"    TEXT,
    "promptVersion"   TEXT,
    "glossaryVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt"      TIMESTAMP(3),

    CONSTRAINT "TranslationMemory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TranslationTerm" (
    "id"        TEXT NOT NULL,
    "locale"    TEXT NOT NULL,
    "source"    TEXT NOT NULL,
    "value"     TEXT NOT NULL,
    "note"      TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TranslationTerm_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TranslationRun_locale_status_createdAt_idx" ON "TranslationRun"("locale", "status", "createdAt" DESC);
CREATE INDEX "TranslationRun_status_leaseExpiresAt_idx" ON "TranslationRun"("status", "leaseExpiresAt");
CREATE INDEX "TranslationJob_runId_state_entity_idx" ON "TranslationJob"("runId", "state", "entity");
CREATE UNIQUE INDEX "TranslationJob_runId_entity_entityId_key" ON "TranslationJob"("runId", "entity", "entityId");
CREATE UNIQUE INDEX "Translation_locale_entity_entityId_key" ON "Translation"("locale", "entity", "entityId");
CREATE INDEX "Translation_locale_entity_status_idx" ON "Translation"("locale", "entity", "status");
CREATE INDEX "Translation_locale_status_createdAt_idx" ON "Translation"("locale", "status", "createdAt");
CREATE INDEX "Translation_entity_entityId_idx" ON "Translation"("entity", "entityId");
CREATE INDEX "Translation_locale_semanticScore_idx" ON "Translation"("locale", "semanticScore");
CREATE UNIQUE INDEX "TranslationMemory_locale_sourceHash_key" ON "TranslationMemory"("locale", "sourceHash");
CREATE INDEX "TranslationMemory_locale_lastUsedAt_idx" ON "TranslationMemory"("locale", "lastUsedAt");
CREATE UNIQUE INDEX "TranslationTerm_locale_source_key" ON "TranslationTerm"("locale", "source");

-- AddForeignKey
ALTER TABLE "TranslationRun" ADD CONSTRAINT "TranslationRun_locale_fkey" FOREIGN KEY ("locale") REFERENCES "Language"("code") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TranslationRun" ADD CONSTRAINT "TranslationRun_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TranslationJob" ADD CONSTRAINT "TranslationJob_runId_fkey" FOREIGN KEY ("runId") REFERENCES "TranslationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Translation" ADD CONSTRAINT "Translation_locale_fkey" FOREIGN KEY ("locale") REFERENCES "Language"("code") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Translation" ADD CONSTRAINT "Translation_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Translation" ADD CONSTRAINT "Translation_runId_fkey" FOREIGN KEY ("runId") REFERENCES "TranslationRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TranslationMemory" ADD CONSTRAINT "TranslationMemory_locale_fkey" FOREIGN KEY ("locale") REFERENCES "Language"("code") ON DELETE CASCADE ON UPDATE CASCADE;
