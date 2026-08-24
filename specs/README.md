# Specs — Index & Status Board

Single source of truth for project progress. **Update this table at every phase change**
(see `WORKFLOW.md` §2–3 for the lifecycle and who updates what).

Legend: ⬜ Not started · 📝 Planned (plan approved) · 🔨 In progress · 🔍 Verifying · ✅ Done

## Status board

| # | Spec | Key dependencies | Status | Plan | Notes |
|---|---|---|---|---|---|
| 00 | `CLAUDE.md` + workflow setup | — | ✅ Done | — | — |
| 01 | [Foundation, config, i18n, theming](spec-01-foundation.md) | — | ✅ Done (Fable) | [plan](plans/spec-01-plan.md) | [notes](notes/spec-01-notes.md) |
| 02 | [Database schema](spec-02-database.md) | 01 | ⬜ Not started | — | — |
| 03 | [Auth & roles](spec-03-auth.md) | 02 | ⬜ Not started | — | — |
| 04 | [Question bank CRUD & review](spec-04-question-bank.md) | 02, 03 | ⬜ Not started | — | — |
| 05 | [AI knowledge base (RAG) & facts](spec-05-ai-knowledge-base.md) | 02 | ⬜ Not started | — | — |
| 06 | [Image quiz AI pipeline](spec-06-image-pipeline.md) | 04, 05 | ⬜ Not started | — | — |
| 07 | [Dynamic quiz engine (CORE)](spec-07-quiz-engine.md) | 02, 04, 05 | ⬜ Not started | — | — |
| 08 | [Student exam & practice UI](spec-08-exam-ui.md) | 07 | ⬜ Not started | — | — |
| 09 | [Student dashboard / homepage](spec-09-dashboard.md) | 07, 08 | ⬜ Not started | — | — |
| 10 | [Reference library & utilities](spec-10-reference-library.md) | 05, 07 | ⬜ Not started | — | — |
| 11 | [Admin & instructor UI](spec-11-admin-ui.md) | 03, 04 | ⬜ Not started | — | — |
| 12 | [Security & anti-cheat](spec-12-security-anticheat.md) | 03, 07, 08 | ⬜ Not started | — | — |
| 13 | [Performance, PWA, a11y](spec-13-performance-pwa-a11y.md) | 08, 09, 10 | ⬜ Not started | — | — |
| 14 | [Deployment](spec-14-deployment.md) | all | ⬜ Not started | — | — |

When a plan is approved, link it in the **Plan** column (`plans/spec-XX-plan.md`).
When verification runs, link the evidence in the **Notes** column (`notes/spec-XX-notes.md`).

## Folder layout

```
specs/
  README.md              ← this status board
  spec-01…14-*.md        ← the spec contracts (scope + acceptance checklist)
  assets/                ← reference images (student homepage reference lives here)
  plans/                 ← approved implementation plans, one per spec
  notes/                 ← verification evidence, one per spec
```

## Resuming work

In a fresh session: `Read WORKFLOW.md and specs/README.md, then continue from where the status board says we are.`

## Student UI reference

The student homepage is built around `assets/reference-teorimester-homepage.png` —
same content and section order, but distinctly cleaner, more modern, and more
user-friendly design. See `WORKFLOW.md` §6 and `spec-09-dashboard.md`.
