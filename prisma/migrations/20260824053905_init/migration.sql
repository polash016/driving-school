-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'INSTRUCTOR', 'STUDENT');

-- CreateEnum
CREATE TYPE "Locale" AS ENUM ('en', 'nb');

-- CreateEnum
CREATE TYPE "QuizMode" AS ENUM ('PRACTICE', 'EXAM');

-- CreateEnum
CREATE TYPE "ItemType" AS ENUM ('TEXT', 'IMAGE', 'SIGN');

-- CreateEnum
CREATE TYPE "ItemStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'APPROVED', 'NEEDS_REVIEW', 'RETIRED');

-- CreateEnum
CREATE TYPE "Provenance" AS ENUM ('AI', 'HUMAN');

-- CreateEnum
CREATE TYPE "VariantSource" AS ENUM ('TEMPLATE', 'AI_VARIATION');

-- CreateEnum
CREATE TYPE "AttemptMode" AS ENUM ('PRACTICE', 'EXAM', 'TOPIC', 'SIGN');

-- CreateEnum
CREATE TYPE "AttemptStatus" AS ENUM ('IN_PROGRESS', 'SUBMITTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ImageStatus" AS ENUM ('UPLOADED', 'ANALYZING', 'NEEDS_HUMAN_ID', 'GENERATING', 'IN_REVIEW', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "SignClass" AS ENUM ('FARE', 'VIKEPLIKT_OG_FORKJORS', 'FORBUD', 'PABUD', 'OPPLYSNING', 'SERVICE', 'VEGVISNING', 'UNDERSKILT', 'MARKERING');

-- CreateEnum
CREATE TYPE "CitationType" AS ENUM ('KB_CHUNK', 'FACT');

-- CreateEnum
CREATE TYPE "KbSourceKind" AS ENUM ('LAW', 'REGULATION', 'CURRICULUM', 'TEMALISTE', 'NOTE');

-- CreateEnum
CREATE TYPE "FactType" AS ENUM ('NUMBER', 'STRING', 'BOOLEAN');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "role" "Role" NOT NULL DEFAULT 'STUDENT',
    "emailVerifiedAt" TIMESTAMP(3),
    "totpSecret" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Profile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "phone" TEXT,
    "preferredLocale" "Locale" NOT NULL DEFAULT 'en',
    "preferredQuizMode" "QuizMode" NOT NULL DEFAULT 'PRACTICE',
    "avatarUrl" TEXT,
    "instructorNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentGroup" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "StudentGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupMembership" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InviteLink" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'STUDENT',
    "groupId" TEXT,
    "maxUses" INTEGER,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "InviteLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LicenseClass" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" JSONB NOT NULL,
    "questionCount" INTEGER NOT NULL,
    "timeLimitMin" INTEGER NOT NULL,
    "passMark" INTEGER NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LicenseClass_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Topic" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "parentId" TEXT,
    "name" JSONB NOT NULL,
    "description" JSONB,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Topic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sign" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "signClass" "SignClass" NOT NULL,
    "svgPath" TEXT NOT NULL,
    "name" JSONB NOT NULL,
    "meaning" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Sign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MasterItem" (
    "id" TEXT NOT NULL,
    "type" "ItemType" NOT NULL,
    "status" "ItemStatus" NOT NULL DEFAULT 'DRAFT',
    "topicId" TEXT NOT NULL,
    "licenseClassId" TEXT,
    "difficulty" INTEGER NOT NULL DEFAULT 3,
    "content" JSONB NOT NULL,
    "parameterSlots" JSONB,
    "legalCitations" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdBy" "Provenance" NOT NULL,
    "modelVersion" TEXT,
    "promptVersion" TEXT,
    "sourceImageId" TEXT,
    "createdById" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "MasterItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MasterItemCitation" (
    "id" TEXT NOT NULL,
    "masterItemId" TEXT NOT NULL,
    "citationType" "CitationType" NOT NULL,
    "kbChunkId" TEXT,
    "factKey" TEXT,
    "quote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MasterItemCitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemVariant" (
    "id" TEXT NOT NULL,
    "masterItemId" TEXT NOT NULL,
    "masterVersion" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "correctOptionKey" TEXT NOT NULL,
    "explanation" JSONB NOT NULL,
    "source" "VariantSource" NOT NULL,
    "validatorReport" JSONB,
    "modelVersion" TEXT,
    "promptVersion" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ItemVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImageAsset" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "status" "ImageStatus" NOT NULL DEFAULT 'UPLOADED',
    "perceptualHash" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "exifStripped" BOOLEAN NOT NULL DEFAULT false,
    "blurApplied" BOOLEAN NOT NULL DEFAULT false,
    "aiContextSheet" JSONB,
    "contextVerifiedAt" TIMESTAMP(3),
    "licenseAttestation" JSONB,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ImageAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImageDetection" (
    "id" TEXT NOT NULL,
    "imageAssetId" TEXT NOT NULL,
    "signCode" TEXT,
    "label" TEXT,
    "bbox" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "humanVerified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImageDetection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamBlueprint" (
    "id" TEXT NOT NULL,
    "licenseClassId" TEXT NOT NULL,
    "name" JSONB,
    "topicDistribution" JSONB NOT NULL,
    "imageRatio" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExamBlueprint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamAttempt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mode" "AttemptMode" NOT NULL,
    "status" "AttemptStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "licenseClassId" TEXT,
    "blueprintId" TEXT,
    "seed" TEXT NOT NULL,
    "questionCountSnapshot" INTEGER NOT NULL,
    "timeLimitSecSnapshot" INTEGER,
    "passMarkSnapshot" INTEGER,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "correctCount" INTEGER,
    "passed" BOOLEAN,
    "topicBreakdown" JSONB,
    "focusLossCount" INTEGER NOT NULL DEFAULT 0,
    "anomalyFlagged" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExamAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamAttemptQuestion" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "topicId" TEXT NOT NULL,
    "optionOrder" JSONB NOT NULL,
    "answeredOptionKey" TEXT,
    "isCorrect" BOOLEAN,
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "answeredAt" TIMESTAMP(3),
    "timeSpentMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExamAttemptQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TopicMastery" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "totalAnswered" INTEGER NOT NULL DEFAULT 0,
    "totalCorrect" INTEGER NOT NULL DEFAULT 0,
    "rollingScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "recentOutcomes" JSONB,
    "lastAnsweredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TopicMastery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReadinessSnapshot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "breakdown" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReadinessSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MistakeCard" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "masterItemId" TEXT NOT NULL,
    "easeFactor" DOUBLE PRECISION NOT NULL DEFAULT 2.5,
    "intervalDays" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "repetitions" INTEGER NOT NULL DEFAULT 0,
    "lapses" INTEGER NOT NULL DEFAULT 0,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "suspended" BOOLEAN NOT NULL DEFAULT false,
    "lastReviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MistakeCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HomeworkAssignment" (
    "id" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "groupId" TEXT,
    "userId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "config" JSONB NOT NULL,
    "deadline" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "HomeworkAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HomeworkCompletion" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "attemptId" TEXT,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HomeworkCompletion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KbSource" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "kind" "KbSourceKind" NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT,
    "effectiveDate" TIMESTAMP(3),
    "version" TEXT,
    "lastIngestedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "KbSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KbChunk" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "embedding" vector(1536),
    "tokenCount" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KbChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Fact" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "valueType" "FactType" NOT NULL,
    "unit" TEXT,
    "description" TEXT,
    "sourceRef" JSONB NOT NULL,
    "effectiveFrom" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Fact_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "meta" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_role_isActive_idx" ON "User"("role", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Profile_userId_key" ON "Profile"("userId");

-- CreateIndex
CREATE INDEX "GroupMembership_userId_idx" ON "GroupMembership"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "GroupMembership_groupId_userId_key" ON "GroupMembership"("groupId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "InviteLink_token_key" ON "InviteLink"("token");

-- CreateIndex
CREATE UNIQUE INDEX "LicenseClass_code_key" ON "LicenseClass"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Topic_slug_key" ON "Topic"("slug");

-- CreateIndex
CREATE INDEX "Topic_parentId_idx" ON "Topic"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "Sign_code_key" ON "Sign"("code");

-- CreateIndex
CREATE INDEX "Sign_signClass_idx" ON "Sign"("signClass");

-- CreateIndex
CREATE INDEX "MasterItem_topicId_status_type_idx" ON "MasterItem"("topicId", "status", "type");

-- CreateIndex
CREATE INDEX "MasterItem_status_createdAt_idx" ON "MasterItem"("status", "createdAt");

-- CreateIndex
CREATE INDEX "MasterItem_sourceImageId_idx" ON "MasterItem"("sourceImageId");

-- CreateIndex
CREATE INDEX "MasterItemCitation_masterItemId_idx" ON "MasterItemCitation"("masterItemId");

-- CreateIndex
CREATE INDEX "MasterItemCitation_factKey_idx" ON "MasterItemCitation"("factKey");

-- CreateIndex
CREATE INDEX "MasterItemCitation_kbChunkId_idx" ON "MasterItemCitation"("kbChunkId");

-- CreateIndex
CREATE UNIQUE INDEX "ItemVariant_contentHash_key" ON "ItemVariant"("contentHash");

-- CreateIndex
CREATE INDEX "ItemVariant_masterItemId_isActive_idx" ON "ItemVariant"("masterItemId", "isActive");

-- CreateIndex
CREATE INDEX "ImageAsset_perceptualHash_idx" ON "ImageAsset"("perceptualHash");

-- CreateIndex
CREATE INDEX "ImageAsset_status_createdAt_idx" ON "ImageAsset"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ImageDetection_imageAssetId_idx" ON "ImageDetection"("imageAssetId");

-- CreateIndex
CREATE INDEX "ExamBlueprint_licenseClassId_isActive_idx" ON "ExamBlueprint"("licenseClassId", "isActive");

-- CreateIndex
CREATE INDEX "ExamAttempt_userId_status_idx" ON "ExamAttempt"("userId", "status");

-- CreateIndex
CREATE INDEX "ExamAttempt_userId_startedAt_idx" ON "ExamAttempt"("userId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "ExamAttempt_status_expiresAt_idx" ON "ExamAttempt"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "ExamAttemptQuestion_variantId_idx" ON "ExamAttemptQuestion"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "ExamAttemptQuestion_attemptId_position_key" ON "ExamAttemptQuestion"("attemptId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "ExamAttemptQuestion_attemptId_variantId_key" ON "ExamAttemptQuestion"("attemptId", "variantId");

-- CreateIndex
CREATE INDEX "TopicMastery_userId_idx" ON "TopicMastery"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TopicMastery_userId_topicId_key" ON "TopicMastery"("userId", "topicId");

-- CreateIndex
CREATE INDEX "ReadinessSnapshot_userId_createdAt_idx" ON "ReadinessSnapshot"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "MistakeCard_userId_dueAt_idx" ON "MistakeCard"("userId", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "MistakeCard_userId_masterItemId_key" ON "MistakeCard"("userId", "masterItemId");

-- CreateIndex
CREATE INDEX "HomeworkAssignment_groupId_deadline_idx" ON "HomeworkAssignment"("groupId", "deadline");

-- CreateIndex
CREATE INDEX "HomeworkAssignment_userId_deadline_idx" ON "HomeworkAssignment"("userId", "deadline");

-- CreateIndex
CREATE INDEX "HomeworkCompletion_userId_idx" ON "HomeworkCompletion"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "HomeworkCompletion_assignmentId_userId_key" ON "HomeworkCompletion"("assignmentId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "KbSource_code_key" ON "KbSource"("code");

-- CreateIndex
CREATE INDEX "KbChunk_sourceId_idx" ON "KbChunk"("sourceId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditLog_actorId_createdAt_idx" ON "AuditLog"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- AddForeignKey
ALTER TABLE "Profile" ADD CONSTRAINT "Profile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentGroup" ADD CONSTRAINT "StudentGroup_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupMembership" ADD CONSTRAINT "GroupMembership_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "StudentGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupMembership" ADD CONSTRAINT "GroupMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InviteLink" ADD CONSTRAINT "InviteLink_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "StudentGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InviteLink" ADD CONSTRAINT "InviteLink_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Topic" ADD CONSTRAINT "Topic_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Topic"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MasterItem" ADD CONSTRAINT "MasterItem_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MasterItem" ADD CONSTRAINT "MasterItem_licenseClassId_fkey" FOREIGN KEY ("licenseClassId") REFERENCES "LicenseClass"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MasterItem" ADD CONSTRAINT "MasterItem_sourceImageId_fkey" FOREIGN KEY ("sourceImageId") REFERENCES "ImageAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MasterItem" ADD CONSTRAINT "MasterItem_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MasterItem" ADD CONSTRAINT "MasterItem_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MasterItemCitation" ADD CONSTRAINT "MasterItemCitation_masterItemId_fkey" FOREIGN KEY ("masterItemId") REFERENCES "MasterItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MasterItemCitation" ADD CONSTRAINT "MasterItemCitation_kbChunkId_fkey" FOREIGN KEY ("kbChunkId") REFERENCES "KbChunk"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MasterItemCitation" ADD CONSTRAINT "MasterItemCitation_factKey_fkey" FOREIGN KEY ("factKey") REFERENCES "Fact"("key") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemVariant" ADD CONSTRAINT "ItemVariant_masterItemId_fkey" FOREIGN KEY ("masterItemId") REFERENCES "MasterItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageAsset" ADD CONSTRAINT "ImageAsset_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageDetection" ADD CONSTRAINT "ImageDetection_imageAssetId_fkey" FOREIGN KEY ("imageAssetId") REFERENCES "ImageAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageDetection" ADD CONSTRAINT "ImageDetection_signCode_fkey" FOREIGN KEY ("signCode") REFERENCES "Sign"("code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamBlueprint" ADD CONSTRAINT "ExamBlueprint_licenseClassId_fkey" FOREIGN KEY ("licenseClassId") REFERENCES "LicenseClass"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamAttempt" ADD CONSTRAINT "ExamAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamAttempt" ADD CONSTRAINT "ExamAttempt_licenseClassId_fkey" FOREIGN KEY ("licenseClassId") REFERENCES "LicenseClass"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamAttempt" ADD CONSTRAINT "ExamAttempt_blueprintId_fkey" FOREIGN KEY ("blueprintId") REFERENCES "ExamBlueprint"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamAttemptQuestion" ADD CONSTRAINT "ExamAttemptQuestion_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ExamAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamAttemptQuestion" ADD CONSTRAINT "ExamAttemptQuestion_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ItemVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamAttemptQuestion" ADD CONSTRAINT "ExamAttemptQuestion_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TopicMastery" ADD CONSTRAINT "TopicMastery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TopicMastery" ADD CONSTRAINT "TopicMastery_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReadinessSnapshot" ADD CONSTRAINT "ReadinessSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MistakeCard" ADD CONSTRAINT "MistakeCard_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MistakeCard" ADD CONSTRAINT "MistakeCard_masterItemId_fkey" FOREIGN KEY ("masterItemId") REFERENCES "MasterItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HomeworkAssignment" ADD CONSTRAINT "HomeworkAssignment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HomeworkAssignment" ADD CONSTRAINT "HomeworkAssignment_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "StudentGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HomeworkCompletion" ADD CONSTRAINT "HomeworkCompletion_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "HomeworkAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HomeworkCompletion" ADD CONSTRAINT "HomeworkCompletion_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ExamAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HomeworkCompletion" ADD CONSTRAINT "HomeworkCompletion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KbChunk" ADD CONSTRAINT "KbChunk_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "KbSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Setting" ADD CONSTRAINT "Setting_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
