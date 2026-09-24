-- spec-23: Learn books, documents (articles/chapters), citations and reading progress.
-- Reversal: DROP TABLE LearnReadingProgress, LearnCitation, LearnDocument, LearnBook; DROP TYPE LearnDocKind, LearnStatus.
-- Prisma's proposed HNSW-index and generated-column drops were removed by hand (prisma/migrations.test.ts).

-- CreateEnum
CREATE TYPE "LearnStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "LearnDocKind" AS ENUM ('ARTICLE', 'CHAPTER');

-- CreateTable
CREATE TABLE "LearnBook" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" JSONB NOT NULL,
    "description" JSONB,
    "coverImageId" TEXT,
    "licenseClassId" TEXT,
    "status" "LearnStatus" NOT NULL DEFAULT 'DRAFT',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "publishedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "LearnBook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LearnDocument" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "kind" "LearnDocKind" NOT NULL,
    "bookId" TEXT,
    "chapterOrder" INTEGER,
    "topicId" TEXT NOT NULL,
    "licenseClassId" TEXT,
    "title" JSONB NOT NULL,
    "summary" JSONB,
    "body" JSONB NOT NULL,
    "heroImageId" TEXT,
    "status" "LearnStatus" NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "wordCount" JSONB NOT NULL,
    "citations" JSONB NOT NULL,
    "createdBy" "Provenance" NOT NULL DEFAULT 'HUMAN',
    "modelVersion" TEXT,
    "promptVersion" TEXT,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "LearnDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LearnCitation" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "kbChunkId" TEXT NOT NULL,
    "sourceCode" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LearnCitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LearnReadingProgress" (
    "userId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "positionPct" INTEGER NOT NULL DEFAULT 0,
    "readAt" TIMESTAMP(3),
    "readVersion" INTEGER,
    "lastOpenedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LearnReadingProgress_pkey" PRIMARY KEY ("userId","documentId")
);

-- CreateIndex
CREATE UNIQUE INDEX "LearnBook_slug_key" ON "LearnBook"("slug");

-- CreateIndex
CREATE INDEX "LearnBook_status_sortOrder_idx" ON "LearnBook"("status", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "LearnDocument_slug_key" ON "LearnDocument"("slug");

-- CreateIndex
CREATE INDEX "LearnDocument_bookId_chapterOrder_idx" ON "LearnDocument"("bookId", "chapterOrder");

-- CreateIndex
CREATE INDEX "LearnDocument_kind_status_publishedAt_idx" ON "LearnDocument"("kind", "status", "publishedAt" DESC);

-- CreateIndex
CREATE INDEX "LearnDocument_topicId_status_idx" ON "LearnDocument"("topicId", "status");

-- CreateIndex
CREATE INDEX "LearnCitation_documentId_idx" ON "LearnCitation"("documentId");

-- CreateIndex
CREATE INDEX "LearnCitation_kbChunkId_idx" ON "LearnCitation"("kbChunkId");

-- CreateIndex
CREATE INDEX "LearnReadingProgress_userId_lastOpenedAt_idx" ON "LearnReadingProgress"("userId", "lastOpenedAt" DESC);

-- CreateIndex
CREATE INDEX "LearnReadingProgress_documentId_idx" ON "LearnReadingProgress"("documentId");

-- AddForeignKey
ALTER TABLE "LearnBook" ADD CONSTRAINT "LearnBook_coverImageId_fkey" FOREIGN KEY ("coverImageId") REFERENCES "ImageAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearnBook" ADD CONSTRAINT "LearnBook_licenseClassId_fkey" FOREIGN KEY ("licenseClassId") REFERENCES "LicenseClass"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearnBook" ADD CONSTRAINT "LearnBook_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearnBook" ADD CONSTRAINT "LearnBook_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearnDocument" ADD CONSTRAINT "LearnDocument_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "LearnBook"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearnDocument" ADD CONSTRAINT "LearnDocument_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearnDocument" ADD CONSTRAINT "LearnDocument_licenseClassId_fkey" FOREIGN KEY ("licenseClassId") REFERENCES "LicenseClass"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearnDocument" ADD CONSTRAINT "LearnDocument_heroImageId_fkey" FOREIGN KEY ("heroImageId") REFERENCES "ImageAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearnDocument" ADD CONSTRAINT "LearnDocument_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearnDocument" ADD CONSTRAINT "LearnDocument_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearnCitation" ADD CONSTRAINT "LearnCitation_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "LearnDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearnCitation" ADD CONSTRAINT "LearnCitation_kbChunkId_fkey" FOREIGN KEY ("kbChunkId") REFERENCES "KbChunk"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearnReadingProgress" ADD CONSTRAINT "LearnReadingProgress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearnReadingProgress" ADD CONSTRAINT "LearnReadingProgress_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "LearnDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
