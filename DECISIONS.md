# DECISIONS.md — Approved deviations & architecture decisions

Append-only. Every time the developer approves a deviation from a spec or an approved plan —
or an architecture decision is made that isn't captured in a spec — it gets an entry here
**at the moment of approval**. Claude scans this file during Phase A of every spec.

## Entry format

```markdown
## YYYY-MM-DD · spec-XX · <short title>
- **Decision:** what was decided / what deviates from the spec or plan.
- **Why:** the reason.
- **Impact:** files/specs affected; anything a later spec must know.
- **Approved by:** developer
```

---

## 2026-08-24 · spec-00 · Fable/Opus work split (approved master plan)
- **Decision:** Fable (scarce tokens) executes the highest-leverage foundation ahead of normal spec order: architecture blueprint (`docs/architecture.md`), spec-01 foundation, spec-02 schema, API contracts + AI gateway module, and the **core** of spec-07 (deterministic engine: expansion, assembly, anti-leak serializer, grading, attempt lifecycle — no live AI jobs, no UI). Spec-07 is split into *core (Fable)* / *integration (Opus)*. Fable also writes detailed plans for specs 03, 05, 06, 12 and briefs for 04, 08–11, 13, 14, plus `docs/handoff-opus.md`. Opus executes everything else in spec order 03 → 14.
- **Why:** Fable tokens are limited; Opus tokens are not. The schema, engine invariants (leak-proofing, uniqueness, grading), and architecture are the hardest-to-redo parts.
- **Impact:** Status board shows 01, 02 done by Fable and 07 split. Per-spec plan approval for Fable-executed specs was granted via the approved master plan (plan files still written as records).
- **Approved by:** developer

## 2026-08-24 · spec-00 · Workflow & instruction structure adopted
- **Decision:** Spec-driven workflow formalized in `WORKFLOW.md`; progress tracked in `specs/README.md` status board; approved plans stored in `specs/plans/`; verification evidence in `specs/notes/`; deviations logged here.
- **Why:** Keeps every session resumable, keeps plans and evidence auditable, and keeps specs as stable contracts.
- **Impact:** All specs 01–14 follow the Phase A–D loop. Spec-09's notes path standardized to `specs/notes/spec-09-notes.md`.
- **Approved by:** developer
