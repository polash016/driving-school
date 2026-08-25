# Plan — Spec 02: Database Schema (Prisma + PostgreSQL)

**Status:** approved via master plan (DECISIONS.md 2026-08-24). Executed by Fable.

## Infra

- `docker-compose.dev.yml`: `pgvector/pgvector:pg16` on host port **5544** (host runs its own PG on 5432) + `redis:7` on **6399**. `.env` + `.env.example` with `DATABASE_URL`/`REDIS_URL`.
- Prisma 6 with `postgresqlExtensions` preview + `vector` extension; embeddings as `Unsupported("vector(1536)")` (raw-SQL access; HNSW + tsvector/GIN indexes added as raw SQL inside the migration for hybrid search).

## Model inventory (24 models — beyond the spec's minimum where later specs demonstrably need it)

Identity: User, Profile, StudentGroup, GroupMembership, InviteLink (spec-03 onboarding; Auth.js adapter tables come with spec-03's own migration).
Curriculum: LicenseClass, Topic (self-relation tree, bilingual Json names), Sign (registry table now, seeded in spec-05).
Content: MasterItem (+version, provenance, reviewer fields), MasterItemCitation (queryable fact/chunk links — powers "affected items" in spec-05), ItemVariant (bilingual rendered content, unique contentHash, correctOptionKey server-side), ImageAsset, ImageDetection (own table, not Json — spec-06 edits/filters detections).
Exam: ExamBlueprint, ExamAttempt (+ config snapshots: timeLimit/passMark/questionCount frozen at start), ExamAttemptQuestion (optionOrder Json per serve, denormalized topicId for fast per-topic grading).
Progress: TopicMastery, ReadinessSnapshot, MistakeCard (SM-2 fields — spec-09), HomeworkAssignment + HomeworkCompletion.
Platform: AuditLog, Setting, KbSource, KbChunk, Fact.

## Key decisions

- Variants are immutable bilingual snapshots → old attempts render old content; option order lives per-serve in ExamAttemptQuestion, never in the variant.
- MasterItem.licenseClassId nullable (null = all classes) instead of a join table — revisit if multi-class-specific items appear.
- Enums for all closed sets (Role, ItemType, ItemStatus incl. NEEDS_REVIEW, Provenance, VariantSource, AttemptMode, AttemptStatus, ImageStatus, SignClass, Locale, QuizMode); AuditLog.action stays String (open set, documented).
- Soft delete (`deletedAt`) on content tables; createdAt/updatedAt everywhere.

## Hot-path indexes (each commented in schema)

attempt resume `(userId, status)`; attempt history `(userId, startedAt desc)`; sampling `(topicId, status, type)`; variant dedupe `contentHash unique`; pool `(masterItemId, isActive)`; mastery `(userId, topicId) unique`; SM-2 due `(userId, dueAt)`; citations `(factKey)`, `(kbChunkId)`; audit `(entityType, entityId)`, `(actorId, createdAt)`; image dedupe `(perceptualHash)`.

## Seeds

LicenseClass from `schoolConfig.licenseClassSeeds`; bilingual temaliste tree (7 official B-class main topics matching the reference homepage categories + starter subtopics; content team extends via admin); default B blueprint (topic counts summing to 45, imageRatio 0.4).

## Verification

`prisma migrate dev` clean from scratch; seed idempotent; ERD committed (prisma-markdown generator — mermaid, no puppeteer); volume-fill script (SQL generate_series) then `EXPLAIN` on the 5 hottest queries documented in notes; Zod model schemas in `src/server/contracts/`.
