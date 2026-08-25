# Brief — Spec 14: Deployment & Per-School Provisioning (Opus expands to a full plan)

**Key decisions already made**

- Multi-stage Dockerfile on `next build` standalone output; docker-compose per instance: `app`, `worker` (same image, command `pnpm worker`), `postgres` (pgvector image, as in docker-compose.dev.yml), `redis`. Environments: staging + EU-region production (GDPR — student data never leaves the EU).
- Blue-green: two app containers behind the proxy; deploy = start green → health check (`/api/health`: DB+Redis ping) → switch → drain blue (in-flight requests only — in-progress ATTEMPTS live in Postgres, not process memory, so exams survive deploys by design; the acceptance test proves it: answer → deploy switch → answer continues).
- `provision-school.sh`: create DB + storage dir/bucket, render `.env` from template, run `prisma migrate deploy`, seed (license classes, topics, signs, KB snapshot, global question-bank snapshot with version tag), copy school.config.ts + theme.css from the school's config pack, set domain via Cloudflare API, run smoke tests (`e2e/shell.spec.ts` against the instance). Target <30 min proven by a timed drill.
- Content sync: `sync-content.ts` — one-way push of global bank/KB versions (export with version tag → dry-run diff by contentHash/id → apply), school-local items (createdBy school users) untouched.
- Backups: nightly `pg_dump` + storage rsync to object storage; restore runbook with a timed drill logged in notes. Monitoring: uptime ping + Sentry (`@sentry/nextjs`) + pino → log shipping.
- `RUNBOOK.md`: deploy, rollback (switch back to blue), restore, new-school checklist.

**Pitfalls:** never run `prisma migrate dev` anywhere but local (mandate); worker and app must share the same image tag (schema drift); `.env` secrets never in the image; test the deploy-during-exam scenario with a seeded IN_PROGRESS attempt.
