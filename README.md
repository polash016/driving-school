# TeoriPro

AI-powered quiz & mock-exam platform for Norwegian driving schools (teoriprøven prep, class B first). Single-instance deployment per school; bilingual (EN + NB).

- **How we work:** [WORKFLOW.md](WORKFLOW.md) (spec-driven; status board in [specs/README.md](specs/README.md))
- **Architecture:** [docs/architecture.md](docs/architecture.md) · ERD: [docs/erd.md](docs/erd.md)
- **AI-session handoff:** [docs/handoff-opus.md](docs/handoff-opus.md)
- **Mandates:** [CLAUDE.md](CLAUDE.md) · Decisions log: [DECISIONS.md](DECISIONS.md)

## Quick start

```bash
docker compose -f docker-compose.dev.yml up -d   # postgres(pgvector) :5544, redis :6399
pnpm install
pnpm exec prisma migrate deploy && pnpm exec prisma db seed
pnpm dev
```

Tests: `pnpm test` (Vitest, incl. engine integration via `TEST_DATABASE_URL`) · `pnpm e2e` (Playwright, mobile-390px + axe).
