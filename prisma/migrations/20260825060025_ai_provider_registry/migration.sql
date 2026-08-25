-- Spec-05: AI provider registry and per-task routing with ordered fallbacks.
-- NOTE: generated-column / HNSW drop statements removed on purpose (migrations.test.ts).

-- CreateEnum
CREATE TYPE "AiProviderKind" AS ENUM ('GOOGLE', 'ANTHROPIC', 'OPENAI_COMPATIBLE');

-- CreateEnum
CREATE TYPE "AiTask" AS ENUM ('VISION', 'GENERATION', 'VALIDATION', 'EMBEDDING', 'IMAGE');

-- CreateTable
CREATE TABLE "AiProvider" (
    "id" TEXT NOT NULL,
    "kind" "AiProviderKind" NOT NULL,
    "label" TEXT NOT NULL,
    "baseUrl" TEXT,
    "encryptedApiKey" TEXT NOT NULL,
    "keyHint" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastCheckedAt" TIMESTAMP(3),
    "lastCheckOk" BOOLEAN,
    "lastCheckError" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiRoute" (
    "id" TEXT NOT NULL,
    "task" "AiTask" NOT NULL,
    "providerId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiRoute_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiProvider_isActive_idx" ON "AiProvider"("isActive");

-- CreateIndex
CREATE INDEX "AiRoute_task_isActive_priority_idx" ON "AiRoute"("task", "isActive", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "AiRoute_task_providerId_model_key" ON "AiRoute"("task", "providerId", "model");

-- AddForeignKey
ALTER TABLE "AiProvider" ADD CONSTRAINT "AiProvider_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiRoute" ADD CONSTRAINT "AiRoute_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "AiProvider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
