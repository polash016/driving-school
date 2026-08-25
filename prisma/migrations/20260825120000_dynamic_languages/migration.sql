-- Spec-15: languages become runtime data.
--
-- Translations are an OVERLAY, deliberately not an edit to the existing { en, nb } content JSON:
-- `ItemVariant.content` is frozen by `tp_item_variant_immutable`, and its `contentHash` is both
-- unique and the per-student seen-window key. Nothing in this migration touches those columns,
-- the calibrated `stemEmbedding`, or the generated `searchText` — which is why adding a language
-- cannot disturb a single exam already sat.
--
-- NOTE: generated-column / HNSW drop statements removed on purpose (prisma/migrations.test.ts).

-- CreateEnum
CREATE TYPE "TextDirection" AS ENUM ('LTR', 'RTL');

-- CreateEnum
CREATE TYPE "TranslationStatus" AS ENUM ('MACHINE', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "TranslationEntity" AS ENUM ('UI_MESSAGE', 'ITEM_STEM', 'ITEM_OPTION', 'ITEM_EXPLANATION', 'TOPIC_NAME', 'TOPIC_DESCRIPTION', 'LICENSE_CLASS_NAME', 'SIGN_NAME', 'SIGN_MEANING', 'KB_SOURCE_NAME');

-- AlterEnum
ALTER TYPE "AiTask" ADD VALUE 'TRANSLATION';

-- AlterTable
ALTER TABLE "ExamAttempt" ADD COLUMN     "locale" TEXT NOT NULL DEFAULT 'en';

-- AlterTable: enum → text, IN PLACE.
-- Prisma proposes DROP COLUMN + ADD COLUMN here, which would silently reset every student who
-- chose Norwegian back to English. `USING …::text` preserves the value verbatim.
ALTER TABLE "Profile" ALTER COLUMN "preferredLocale" DROP DEFAULT;
ALTER TABLE "Profile" ALTER COLUMN "preferredLocale" TYPE TEXT USING "preferredLocale"::TEXT;
ALTER TABLE "Profile" ALTER COLUMN "preferredLocale" SET DEFAULT 'en';

-- DropEnum: locales are an open set now (spec-15) and no longer belong in a Postgres enum.
-- Reversal: CREATE TYPE "Locale" AS ENUM ('en','nb'); ALTER TABLE "Profile"
--   ALTER COLUMN "preferredLocale" TYPE "Locale" USING "preferredLocale"::"Locale";
-- (only reversible while every stored value is still 'en' or 'nb').
DROP TYPE "Locale";

-- CreateTable
CREATE TABLE "Language" (
    "code" TEXT NOT NULL,
    "englishName" TEXT NOT NULL,
    "nativeName" TEXT NOT NULL,
    "shortLabel" TEXT NOT NULL,
    "urlPrefix" TEXT NOT NULL,
    "direction" "TextDirection" NOT NULL DEFAULT 'LTR',
    "isBuiltIn" BOOLEAN NOT NULL DEFAULT false,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT true,
    "studentVisible" BOOLEAN NOT NULL DEFAULT false,
    "fallbackCode" TEXT NOT NULL DEFAULT 'en',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Language_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "Translation" (
    "id" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "entity" "TranslationEntity" NOT NULL,
    "entityId" TEXT NOT NULL,
    "field" TEXT NOT NULL DEFAULT '',
    "value" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "status" "TranslationStatus" NOT NULL DEFAULT 'MACHINE',
    "modelVersion" TEXT,
    "promptVersion" TEXT,
    "qaScore" DOUBLE PRECISION,
    "qaFlags" TEXT[],
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Translation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TranslationMemory" (
    "sourceHash" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TranslationMemory_pkey" PRIMARY KEY ("sourceHash","locale")
);

-- CreateTable
CREATE TABLE "TranslationTerm" (
    "id" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TranslationTerm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TranslationBatch" (
    "id" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "status" "BatchStatus" NOT NULL DEFAULT 'PENDING',
    "requested" INTEGER NOT NULL DEFAULT 0,
    "completed" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "flagged" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "heartbeatAt" TIMESTAMP(3),
    "createdById" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "TranslationBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Language_urlPrefix_key" ON "Language"("urlPrefix");

-- CreateIndex
CREATE INDEX "Language_studentVisible_sortOrder_idx" ON "Language"("studentVisible", "sortOrder");

-- CreateIndex
CREATE INDEX "Translation_locale_entity_entityId_idx" ON "Translation"("locale", "entity", "entityId");

-- CreateIndex
CREATE INDEX "Translation_locale_status_entity_idx" ON "Translation"("locale", "status", "entity");

-- CreateIndex
CREATE UNIQUE INDEX "Translation_locale_entity_entityId_field_key" ON "Translation"("locale", "entity", "entityId", "field");

-- CreateIndex
CREATE UNIQUE INDEX "TranslationTerm_locale_source_key" ON "TranslationTerm"("locale", "source");

-- CreateIndex
CREATE INDEX "TranslationBatch_locale_startedAt_idx" ON "TranslationBatch"("locale", "startedAt" DESC);

-- AddForeignKey
ALTER TABLE "Translation" ADD CONSTRAINT "Translation_locale_fkey" FOREIGN KEY ("locale") REFERENCES "Language"("code") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Translation" ADD CONSTRAINT "Translation_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed the built-ins. Their strings live on disk and in the { en, nb } columns; these rows exist
-- so the admin screen can list them and so the registry has a source of truth to fall back FROM.
-- `nb → /no` is the one URL prefix that differs from its code, grandfathered from spec-01.
INSERT INTO "Language" ("code","englishName","nativeName","shortLabel","urlPrefix","direction",
                        "isBuiltIn","requiresApproval","studentVisible","fallbackCode","sortOrder","updatedAt")
VALUES
  ('en','English','English','EN','/en','LTR',true,false,true,'en',0,CURRENT_TIMESTAMP),
  ('nb','Norwegian Bokmål','Norsk bokmål','NO','/no','LTR',true,false,true,'en',1,CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;
