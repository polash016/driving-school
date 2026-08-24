# Spec 14 — Deployment & Per-School Instance Provisioning

## In scope
- Dockerfile (multi-stage, standalone Next output) + docker-compose (app, postgres, redis, worker) for a full instance.
- Environments: staging (existing onas server acceptable) + production (EU-region host for student data — GDPR); blue-green deploy script so live exams survive deploys (sticky sessions / drain: in-progress attempts unaffected — verify).
- Provisioning script `provision-school.sh`: creates DB, storage bucket, env file from template, seeds (license classes, topics, sign registry, KB, global question bank snapshot with version tag), applies school.config + theme, sets domain (Cloudflare API), runs smoke tests.
- Content sync tool: one-way push of updated global bank/KB versions from master to instances (dry-run diff → apply), preserving school-local items.
- Backups: nightly pg_dump + object storage sync, restore runbook tested. Uptime monitoring + Sentry + log shipping.
- RUNBOOK.md: deploy, rollback, restore, new-school checklist (target: new school live <1 day).

## Acceptance checklist
- [ ] Fresh VM → provision script → working branded instance, smoke tests green, in <30 min.
- [ ] Deploy during an active seeded exam → attempt unaffected (test).
- [ ] Restore drill from last night's backup documented with timing.
- [ ] Content sync dry-run shows correct diff; apply updates only intended items.
