# Verification — Spec 02: Database Schema

Executed by Fable, 2026-08-24. Prisma 6.19 (pinned; Prisma 7 avoided for ecosystem stability — new generator/config system, prisma-markdown incompatible), PostgreSQL 16 + pgvector via `docker-compose.dev.yml` (host port 5544), 24 models / 13 enums.

## Acceptance checklist

### ✅ `prisma migrate dev` clean; seed runs; ERD generated and committed
- Two migrations applied from scratch: `init` (full schema) + `kb_hybrid_search` (raw SQL: HNSW index on `KbChunk.embedding`, generated `textSearch` tsvector column with norwegian stemming + GIN — verified in `psql \d`).
- Seed (`prisma/seed.ts`, idempotent — ran twice, stable counts): 1 license class (B 45/90/38 from school config), **32 topics** (7 official temaliste main areas matching the reference homepage categories + starter subtopics, bilingual), 1 default B blueprint (distribution sums to 45 — enforced in seed; imageRatio 0.4).
- ERD: `docs/erd.md` via `prisma-markdown` generator (mermaid; no puppeteer dependency), regenerated on every `prisma generate`, committed.

### ✅ EXPLAIN shows index usage for the hottest queries (measured at volume)
Synthetic volume: 10 000 MasterItems, 30 000 ItemVariants, 2 000 ExamAttempts, 6 400 TopicMastery rows, 200 users (SQL `generate_series`, cleaned up after).

| Hot query | Index used (EXPLAIN ANALYZE) | Exec time |
|---|---|---|
| Attempt resume `(userId, status)` | `ExamAttempt_userId_status_idx` (Index Scan) | 0.013 ms |
| Item sampling `(topicId, status, type)` | `MasterItem_topicId_status_type_idx` (Bitmap Index Scan) | 0.061 ms |
| Variant dedupe `contentHash` | `ItemVariant_contentHash_key` (Index Scan) | 0.015 ms |
| Mastery lookup `(userId, topicId)` | `TopicMastery_userId_topicId_key` (Bitmap Index Scan) | 0.021 ms |
| Attempt history `(userId, startedAt DESC)` | `ExamAttempt_userId_startedAt_idx` | 0.034 ms |
| Variant pool `(masterItemId, isActive)` (bonus) | `ItemVariant_masterItemId_isActive_idx` | 0.015 ms |

### ✅ Zod schemas for models used at API boundaries
- `src/server/contracts/common.ts` (locale, bilingual text, pagination, id) + `models.ts` (all enums + curriculum/content/exam/progress/KB/user schemas). Client-facing quiz DTOs (anti-leak) land in `contracts/quiz.ts` (F3/F4).
- Guard test `contracts.test.ts`: every contract enum verified value-for-value against the generated Prisma enum (13 enums). All tests green (20/20 total), lint + build clean.

## Design notes
- Every index in `schema.prisma` carries a comment naming its query; requirements (enums over strings, `deletedAt` on content tables, timestamps everywhere) hold — sole documented exception: `AuditLog.action` is String (open set by design).
- Config snapshots on ExamAttempt (questionCount/timeLimit/passMark) freeze official rules at start.
- `ItemVariant` is an immutable bilingual snapshot; per-serve option order lives in `ExamAttemptQuestion.optionOrder`.
- `MasterItemCitation` (factKey/kbChunkId indexes) powers spec-05's "affected items" re-review without JSON scanning.
- Auth.js adapter tables intentionally deferred to spec-03's migration (adapter-shaped).
