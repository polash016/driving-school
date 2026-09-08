# Specs — Index & Status Board

Single source of truth for project progress. **Update this table at every phase change**
(see `WORKFLOW.md` §2–3 for the lifecycle and who updates what).

Legend: ⬜ Not started · 📝 Planned (plan approved) · 🔨 In progress · 🔍 Verifying · ✅ Done

## Status board

| #   | Spec                                                                               | Key dependencies   | Status                                                                                                                   | Plan                                                                   | Notes                           |
| --- | ---------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------- |
| 00  | `CLAUDE.md` + workflow setup                                                       | —                  | ✅ Done                                                                                                                  | —                                                                      | —                               |
| 01  | [Foundation, config, i18n, theming](spec-01-foundation.md)                         | —                  | ✅ Done (Fable)                                                                                                          | [plan](plans/spec-01-plan.md)                                          | [notes](notes/spec-01-notes.md) |
| 02  | [Database schema](spec-02-database.md)                                             | 01                 | ✅ Done (Fable)                                                                                                          | [plan](plans/spec-02-plan.md)                                          | [notes](notes/spec-02-notes.md) |
| 03  | [Auth & roles](spec-03-auth.md)                                                    | 02                 | ✅ Done (Opus)                                                                                                           | [plan](plans/spec-03-plan.md)                                          | [notes](notes/spec-03-notes.md) |
| 04  | [Question bank CRUD & review](spec-04-question-bank.md) 📌                         | 02, 03             | ✅ Done (Opus)                                                                                                           | [plan](plans/spec-04-plan.md)                                          | [notes](notes/spec-04-notes.md) |
| 05  | [AI knowledge base (RAG) & facts](spec-05-ai-knowledge-base.md) 📌                 | 02                 | 🔨 In progress (Opus) — provider registry ✅, KB next                                                                    | [plan](plans/spec-05-plan.md)                                          | —                               |
| 06  | [Image quiz AI pipeline](spec-06-image-pipeline.md) 📌                             | 04, 05             | 🔨 In progress (Opus) — storage, upload, sign registry, mode-2 image→question pipeline ✅; composites + AI revision next | [plan](plans/spec-06-plan-signs-images.md)                             | [notes](notes/spec-06-notes.md) |
| 07  | [Dynamic quiz engine (CORE)](spec-07-quiz-engine.md)                               | 02, 04, 05         | 🔨 Core ✅ (Fable) / integration → Opus                                                                                  | [plan](plans/spec-07-plan.md)                                          | [notes](notes/spec-07-notes.md) |
| 08  | [Student exam & practice UI](spec-08-exam-ui.md)                                   | 07                 | ⬜ Brief ready — **tile block superseded by 16** (amendment 2026-09-03)                                                  | [brief](plans/spec-08-brief.md)                                        | —                               |
| 09  | [Student dashboard / homepage](spec-09-dashboard.md)                               | 07, 08             | ⬜ Brief ready — **homepage §2 superseded by 16** (amendment 2026-09-03)                                                 | [brief](plans/spec-09-brief.md)                                        | —                               |
| 10  | [Reference library & utilities](spec-10-reference-library.md)                      | 05, 07             | 🔨 Sign registry landed (287 signs) — catalogue UI still to build                                                        | [brief](plans/spec-10-brief.md)                                        | [notes](notes/spec-06-notes.md) |
| 11  | [Admin & instructor UI](spec-11-admin-ui.md)                                       | 03, 04             | ⬜ Brief ready                                                                                                           | [brief](plans/spec-11-brief.md)                                        | —                               |
| 12  | [Security & anti-cheat](spec-12-security-anticheat.md)                             | 03, 07, 08         | 📝 Planned                                                                                                               | [plan](plans/spec-12-plan.md)                                          | —                               |
| 13  | [Performance, PWA, a11y](spec-13-performance-pwa-a11y.md)                          | 08, 09, 10         | ⬜ Brief ready                                                                                                           | [brief](plans/spec-13-brief.md)                                        | —                               |
| 14  | [Deployment](spec-14-deployment.md)                                                | all                | ⬜ Brief ready                                                                                                           | [brief](plans/spec-14-brief.md)                                        | —                               |
| 15  | [Dynamic languages & AI translation](spec-15-dynamic-languages.md) 🌐              | 01, 04, 05, 07     | 🔨 In progress (Opus) — phase 1 ✅ (engine, pipeline, admin); RTL next                                                   | [plan](plans/spec-15-plan.md)                                          | [notes](notes/spec-15-notes.md) |
| 16  | [Task sets & student panel restructure](spec-16-task-sets.md) 🎯                   | 04, 05, 07, 08, 09 | ✅ Done (Opus) — deterministic partitioner; AI pass deferred                                                             | [plan](plans/spec-16-plan.md)                                          | [notes](notes/spec-16-notes.md) |
| 17  | [AI variant generator](spec-17-ai-variants.md) 📌                                  | 04, 05, 07, 16     | ⬜ Spec approved 2026-09-03 — build after 16                                                                             | —                                                                      | —                               |
| 18  | [Aurora visual language](spec-18-aurora-visual-language.md) ✨                     | 09, 16             | ✅ Done (Opus) — token-driven glass; a11y fallbacks verified                                                             | —                                                                      | [notes](notes/spec-18-notes.md) |
| 19  | [Unattended translation & publish readiness](spec-19-translation-automation.md) ⚙️ | 15                 | ✅ Done (Fable), deployed 2026-09-09 — 🔨 amendment A (throughput) in progress (Opus)                                    | [plan](plans/spec-19-plan.md) · [A](plans/spec-19a-throughput-plan.md) | [notes](notes/spec-19-notes.md) |

**Handoff:** Fable phase complete — Opus sessions start at [docs/handoff-opus.md](../docs/handoff-opus.md) and execute 03 → 14.

📌 **The AI question factory runs across 04 → 05 → 06** (approved 2026-08-24). One loop: upload images —
or none at all — → AI drafts a legally grounded question set → curate it, fix questions with AI, add
more → students sit an image exam and a theory exam. Each of those three specs carries a dated
**amendment section** at the bottom of its file: question sets + accuracy dashboard (04), AI provider
registry + key vault (05), storage driver + composite AI images + AI revision loop (06). Rationale in
[DECISIONS.md](../DECISIONS.md). **The 05 and 06 plan files were written before those amendments — read
the spec amendment first and expand the plan in that spec's own Phase A session.**

🛑 **The sign registry is provisional** (2026-08-25). All 287 signs were extracted from
`traffic_rules/theory book.pdf` with AI-drafted meanings and placeholder codes, because the official
Statens vegvesen asset pack was not available. Every row is flagged `provisional` with its source.
Obtain the official pack and work through `/admin/signs?review=1` before launch — the schema and the
admin screen make that a data change, not a code change. See `DECISIONS.md` (2026-08-25).

🎯 **Specs 16 and 17 were approved 2026-09-03**, after the roadmap. The student panel drops from
four test entry points to three — **Task set / Practice / Sign test** — and a task set is a numbered
full mock exam drawn from **its own slice of the bank** (45 of ~68), so two students sitting #7 get
different papers and finishing every set provably means finishing the bank. The Theory Test and
Image Quiz tiles are removed: the official teoriprøven mixes text, image and sign questions in one
paper. Spec-17 adds AI-generated alternate phrasings of an approved question — sequenced after 16,
because 16 is leak-proof without it. Specs 08 and 09 carry amendments; rationale in
[DECISIONS.md](../DECISIONS.md).

⚙️ **Spec-19 was approved 2026-09-08**, after using spec-15 in anger. The engine works, but there
was no way to _finish_: the admin screen advances 25 units a click, and QA-flagged units are served
under no policy — so turning off "requires approval" does not help, bulk approve refuses flagged rows
by design, and the flagged pile can only be cleared one at a time. Spec-19 adds a background worker
and makes the machine repair its own QA failures rather than lowering the bar. Three phases, each
shippable alone.

🌐 **Spec-15 was requested after the original roadmap** (2026-08-25): the school must be able to add
a language — Arabic, Spanish, whatever its students speak — from the admin panel, have the AI
translate everything already in the bank, and have a speaker review it. Delivered in two phases:
the engine proven with Spanish, then Arabic with right-to-left layout.

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
