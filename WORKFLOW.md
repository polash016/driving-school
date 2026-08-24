# TeoriPro — Spec-Driven Development Workflow (Claude Code)

`CLAUDE.md` defines **what must always be true** (engineering mandates, stack, conventions).
This file defines **how work happens**: one spec at a time, through a fixed lifecycle, with a
written plan before any code and written evidence before anything is called done.

**Claude: read this file and the status board (`specs/README.md`) at the start of every working session.**

---

## 1. File map — where instructions live

| Path | What it is | Rule |
|---|---|---|
| `CLAUDE.md` | Project system prompt: mandates, stack, conventions. | Auto-loaded every session. Wins over every other file — conflicts must be raised, not silently resolved. |
| `WORKFLOW.md` | This file: the process. | Read at session start, before touching a spec. |
| `specs/README.md` | Spec index, build order, **status board**. | Single source of truth for "where are we". Updated at every phase change. |
| `specs/spec-XX-*.md` | The contract for one unit of work: scope + acceptance checklist. | Work ONLY from the current spec. Specs are never edited silently — propose the change, get approval, log it in `DECISIONS.md`. |
| `specs/assets/` | Reference images — including the student homepage reference. | View every image a spec references BEFORE planning that spec. |
| `specs/plans/spec-XX-plan.md` | The approved implementation plan for spec XX. | Written in Phase A, approved by the developer, then followed. Deviations require approval + a `DECISIONS.md` entry. |
| `specs/notes/spec-XX-notes.md` | Verification evidence for spec XX. | Written in Phase C: each checklist item → PASS/FAIL → concrete evidence. |
| `DECISIONS.md` | Append-only log of approved deviations & architecture decisions. | Every approved deviation from a spec or plan gets an entry the moment it is approved. |

---

## 2. Spec lifecycle

```
⬜ Not started → 📝 Planned → 🔨 In progress → 🔍 Verifying → ✅ Done
```

- A spec is **📝 Planned** only after the developer has explicitly approved the plan.
- A spec is **✅ Done** only when every acceptance-checklist item is PASS **with evidence** in its notes file.
- The next spec does not start until the current one is ✅ Done (or the developer explicitly parks it with a `DECISIONS.md` entry).

---

## 3. The loop (per spec)

### Phase A — Plan (no code is written in this phase)
1. Read the **entire** spec file. View every image/asset it references (for UI specs: the homepage reference image — see §6).
2. Re-read the relevant `CLAUDE.md` mandates; scan `DECISIONS.md` for constraints inherited from earlier specs.
3. Enter **plan mode** and produce a plan covering:
   - Files to create/modify.
   - Prisma schema changes — every new index listed with the query it serves.
   - API contracts: Zod input **and** output schemas.
   - i18n keys to add (`en` + `nb`) — no user-facing string outside the i18n layer.
   - Caching strategy where relevant: Redis keys, TTL, explicit invalidation triggers.
   - UI states: loading (skeleton), empty, error, offline, mobile — per mandate 3.
   - Test plan: which unit/e2e tests prove which acceptance-checklist items.
   - Open questions / risks.
4. Present the plan and **wait for explicit approval**. On approval: save it to `specs/plans/spec-XX-plan.md`, set status board to 📝 Planned.

### Phase B — Implement
- Follow the approved plan. Tests are written alongside code — TDD for service/engine logic (the quiz engine is the product; test it exhaustively).
- All `CLAUDE.md` mandates in force at all times: config-driven values, i18n everywhere, explicit `select`, indexes stated, correct answers never sent to the client pre-submission, a11y built in.
- Need to deviate from plan or spec? **Stop** → explain → get approval → append to `DECISIONS.md` → update the plan file → continue.
- Status board: 🔨 In progress.

### Phase C — Verify
- Set status 🔍 Verifying. Run the spec's acceptance checklist top to bottom.
- Each item is reported **PASS/FAIL with evidence**: actual test output, command output, grep result, query plan, or screenshot — never a bare assertion of success.
- Write the results into `specs/notes/spec-XX-notes.md`. Fix every FAIL and re-verify until the checklist is fully green.
- No feature ships with TODOs in user-facing paths.

### Phase D — Close
- Status board → ✅ Done. Commit: `spec-XX: <summary>` (the repo is a git repo from Spec 01 onward; one spec per branch/commit series).
- **Every 3rd completed spec**: run a compliance review session — *"Review the code from the last 3 specs against CLAUDE.md mandates 1–4. Report violations with file:line and fix them."* (`/code-review` helps here.)
- `/clear` (or start a fresh session) before the next spec — one spec per session; long context degrades output quality.

---

## 4. Prompts the developer uses

Keep prompts short — the process detail lives in this file, not in the prompt:

| Intent | Prompt |
|---|---|
| Start a spec | `Plan spec-XX per WORKFLOW.md Phase A.` |
| Approve & build | `Plan approved. Implement spec-XX per specs/plans/spec-XX-plan.md.` |
| Verify | `Verify spec-XX per WORKFLOW.md Phase C.` |
| Resume anywhere | `Read WORKFLOW.md and specs/README.md, then continue from where the status board says we are.` |
| Periodic review | `Compliance review of the last 3 completed specs per WORKFLOW.md Phase D.` |

---

## 5. Session & model rules

- **One spec per session.** A session starting mid-project reads: this file → status board → current spec → its plan (if any).
- **Model routing:** the architecture-heavy specs — 02 (database), 05 (AI knowledge base), 06 (image pipeline), 07 (quiz engine), 12 (security) — deserve the strongest available model with deep reasoning for Phase A; switch with `/model`. Implementation of an already-approved plan can run on a faster model.
- Never `prisma db push` against anything but local dev; every migration reversible.
- Verification claims require executed evidence — run the command, paste the output, then claim the result.

---

## 6. Student UI — reference-image rule (IMPORTANT)

The student homepage — and the visual tone of the entire student panel — is built **around** the
reference screenshot: **`specs/assets/reference-teorimester-homepage.png`**.

- **KEEP the reference's content and vertical structure:** header with logo + language switcher → quick-start tiles → headline pass stats → "How I'm doing" per-topic progress → "My previous tests" history → account/footer links + log out.
- **The design must be distinctly cleaner, more modern, and more user-friendly than the reference** — token-driven surfaces, generous whitespace, 12–16px radii, subtle elevation, purposeful color, smooth 60fps micro-interactions. It is a structural reference, **never a pixel-copy**; the reference's flat gray cards, harsh shadows, and walls of identical buttons are exactly what we improve on (full modernization requirements: `specs/spec-09-dashboard.md`).
- Mobile-first at **390px** design target; desktop renders as centered `max-w-md`. Applies to all student-facing specs (08, 09, 10).
- **View the image before planning any student-facing UI spec.**

---

## 7. Build order

```
00 CLAUDE.md (done)
01 Foundation → 02 Database → 03 Auth → 04 Question Bank → 05 AI Knowledge Base
→ 06 Image Pipeline → 07 Quiz Engine → 08 Exam UI → 09 Dashboard
→ 10 Reference Library → 11 Admin UI → 12 Security/Anti-cheat
→ 13 Performance/PWA/A11y → 14 Deployment
```

Numeric order **is** dependency order — do not reorder without an approved `DECISIONS.md` entry.
