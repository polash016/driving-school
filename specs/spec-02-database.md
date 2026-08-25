# Spec 02 — Database Schema (Prisma + PostgreSQL)

## Objective

Design the complete schema. This is the highest-leverage spec — think hard (use Fable), because everything depends on it.

## Entities (minimum)

- User (role: ADMIN | INSTRUCTOR | STUDENT), Profile, StudentGroup, GroupMembership.
- LicenseClass (code B/A/AM146…, questionCount, timeLimitMin, passMark) — seeded, config-driven.
- Topic (temaliste taxonomy, hierarchical, slug, bilingual names).
- MasterItem (question template): type TEXT|IMAGE|SIGN, topicId, difficulty, status DRAFT|IN_REVIEW|APPROVED|RETIRED, legalCitations JSON, parameterSlots JSON, bilingual content JSON, version, provenance (createdBy AI|HUMAN, modelVersion, promptVersion, sourceImageId?), reviewer fields.
- ItemVariant (generated variant): masterItemId, contentHash UNIQUE, bilingual rendered content, options[] with exactly one correct (stored server-side), validatorReport JSON.
- ImageAsset: url, perceptualHash, aiContextSheet JSON, detections[] (signCode, bbox, confidence, humanVerified), license attestation, blurredVariants.
- ExamBlueprint: licenseClassId, JSON of topic→count + imageRatio.
- ExamAttempt: userId, mode PRACTICE|EXAM|TOPIC|SIGN, blueprintId?, status IN_PROGRESS|SUBMITTED|EXPIRED, seed, startedAt, submittedAt, score, passed; ExamAttemptQuestion: attemptId, variantId, position, answeredOptionId?, isCorrect?, flagged, answeredAt.
- TopicMastery (userId, topicId, rolling stats), ReadinessSnapshot, HomeworkAssignment, AuditLog, KbChunk (for spec 05: source, ref, text, embedding vector via pgvector).

## Requirements

- Explicit indexes for every hot path: attempt resume (userId,status), item sampling (topicId,status,type), variant dedupe (contentHash), mastery lookup (userId,topicId). Document each index's purpose in schema comments.
- Enums over strings. `deletedAt` soft delete on content tables. `createdAt/updatedAt` everywhere.
- Seed script: license classes, full temaliste topic tree (bilingual), one demo blueprint for B.

## Acceptance checklist

- [ ] `prisma migrate dev` clean; seed runs; ERD generated (prisma-erd) and committed.
- [ ] For each of the 5 hottest queries, an EXPLAIN shows index usage (documented in specs/notes-02.md).
- [ ] Zod schemas generated/written for every model used at API boundaries.
