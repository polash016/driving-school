# Spec 05 — AI providers & knowledge base · verification evidence

**Status: part 1 of 2 complete.** The AI provider registry and key vault are implemented and
verified (2026-08-25). The knowledge base itself — ingestion, hybrid search, facts, sign registry —
is the remaining half; see `specs/plans/spec-05-plan.md` for its two blocking dependencies.

```
pnpm test    # 226 passed (27 files)
pnpm exec tsc --noEmit && pnpm exec eslint && pnpm build     # all clean
```

## Part 1 — AI provider registry & key vault

### ✅ Keys are encrypted at rest and never leave the server

`providers.integration.test.ts › key vault`: after adding a provider through the service, the
plaintext key appears in **none** of: the returned summary, the provider list, the database column
(`v1.…` AES-256-GCM ciphertext, same helpers as the spec-03 TOTP secrets), or the audit rows.

Driven through the real UI on a running server, adding a provider and a route while recording every
response body:

```
provider row visible: true
key hint shown: DeepSeek (test) OpenAI-compatible · …2b7c
PLAINTEXT KEY VISIBLE ON PAGE: false
responses containing the plaintext key: 0 of 35
```

### ✅ Per-task routing with an ordered fallback chain

`resolveRoutes` returns active routes cheapest-priority first and drops routes whose provider is
deactivated (asserted by flipping `isActive` and re-resolving). Deleting a provider removes its
routes with it. The gateway walks the chain: a **retryable** failure (429 quota, 5xx) moves to the
next route; a **non-retryable** one (401 bad key, 400 bad request, 404 unknown model) stops
immediately — trying three providers with the same malformed prompt would just burn three quotas.
Classification is unit-tested, including that provider error bodies are truncated so a key echoed
back by a provider cannot end up in the logs.

### ✅ Three adapters, one gateway surface

`aiJson` / `aiEmbed` are unchanged for every existing caller; underneath, `adapterFor(kind)`
dispatches to Google (native `contents`/`parts`, key as query parameter), Anthropic (native
`x-api-key`, system prompt as a top-level field), or the OpenAI-compatible adapter, which covers
DeepSeek, OpenRouter, Groq, Mistral, Ollama and the existing OmniRoute endpoint by base URL.
Anthropic exposes no embedding endpoint, so `adapterFor("ANTHROPIC").embed` is undefined and the
chain falls through to a route that has one — asserted.

Env (`OMNIROUTE_*`) remains the fallback when no provider is configured, so CI, tests and a fresh
clone still work with no database configuration.

### Notes

- `.strict()` on the route contract caught a sloppy spread that would have leaked the whole nested
  provider relation (including the encrypted key) into an admin payload. The contract did its job.
- The admin screen is ADMIN-only and the key field is write-only: it is sent once and never
  rendered back, only a four-character hint.

## Part 2 — knowledge base and generation (verified 2026-08-25 against a live Gemini key)

### The developer's key: checked, and two routes were wrong

Probing every configured route with a real call found the problem immediately:

| Task                             | Model                   | Result                                           |
| -------------------------------- | ----------------------- | ------------------------------------------------ |
| VISION / GENERATION / VALIDATION | `gemini-3.5-flash-lite` | OK                                               |
| EMBEDDING                        | `gemini-3.5-flash-lite` | **404 — not supported for embedContent**         |
| IMAGE                            | `gemini-3.5-flash-lite` | answers as a chat model; cannot produce an image |

Asking the account which models it actually has (`ListModels`) rather than guessing: embeddings are
`gemini-embedding-001` / `gemini-embedding-2`; **no Imagen (`predict`) models are available**, so
image generation would have to go through a `gemini-*-flash-image` model — not implemented until
spec-06.

**Dimension trap, caught before it could corrupt anything:** `gemini-embedding-001` returns **3072**
dimensions by default, and `KbChunk.embedding` is `vector(1536)`. It honours
`outputDimensionality`, so the Google adapter now always requests 1536 and **throws on any other
size** rather than writing a vector the column cannot hold. Measured: default 3072, requested 1536.

### ✅ Ingestion produces citable chunks

`pnpm kb:ingest trafikkreglene <lovdata url>` — Norwegian statutes and regulations are outside
copyright (åndsverkloven § 14), so the text is free to use; the CLI strips everything a publisher
adds around it.

The first run silently produced garbage: 43 chunks, each **only a heading**, every section
duplicated. The cause was the table of contents — a naive pass over `<h2>` elements ingests every
heading twice, once with no body. Segmenting on the real `PARAGRAF_n` anchors fixed it: **21
sections, average 1236 characters, real rule text**.

```
§ 7. Vikeplikt
1. Trafikant som det skal vikes for, må ikke hindres eller forstyrres…
2. Kjørende har vikeplikt for kjøretøy som kommer fra høyre…
```

Re-ingesting a source replaces its chunks and flags every approved question citing the old ones as
NEEDS_REVIEW — the law-change safety mechanism, exercised by the second run (43 replaced).

### ✅ Hybrid search retrieves the right rule

Reciprocal Rank Fusion over a vector leg (pgvector cosine) and a keyword leg (norwegian tsvector),
`score = Σ 1/(60 + rank)` — no weight to tune and immune to the two legs' incomparable score
scales, which is the usual way naive hybrid search goes wrong. Fusion is unit-tested on its own;
against the real corpus:

| Query                                        | Top hits                                     |
| -------------------------------------------- | -------------------------------------------- |
| `vikeplikt høyreregel`                       | **§ 7** (Vikeplikt), § 9, § 11               |
| `who must yield when turning left` (English) | **§ 7**, § 6, § 12                           |
| `fartsgrense tettbygd strøk`                 | **§ 13**, § 4, § 16                          |
| `§ 7`                                        | **§ 7** (both legs agree — double the score) |

A failed embedding degrades to keyword-only rather than failing the search.

### ✅ Generation produces legally grounded questions

`pnpm ai:generate right-of-way 5` → **5 asked, 5 returned, 5 passed the quality gate, 0 rejected.**

Two defects surfaced on the way, both mine:

- The Google adapter sent a system instruction with no user turn; Gemini rejects that
  ("contents is not specified"). A system-only prompt now becomes the user turn.
- The prompt never described its output shape, so the model answered with a bare array. The shape
  is now specified explicitly **and** both envelopes are accepted — rejecting a good batch over its
  envelope would be silly.

Sample output, unedited:

> **You are driving out onto a road from a private property (gårdsveg) that is not open for public
> traffic. What is your duty towards traffic on the road?** → _You have vikeplikt for traffic on the
> road_ — cites `trafikkreglene § 7`, explanation quotes § 7 no. 4.

Bilingual, one defensible answer, cited, and it went through the **same quality gate a human-written
question faces** — the model gets no easier standard. Everything lands as a DRAFT in a set and still
needs two reviewers before a student can see it.

Available from the UI at **/admin/sets → Generate questions with AI**, or `pnpm ai:generate <topic> [n]`.

### Still outstanding in spec-05

- **Facts table** (typed getters for speed limits, BAC, tread depth) and the affected-items lookup.
- **Sign registry** — needs the SVG assets; see below.
- Only Trafikkreglene is ingested. Vegtrafikkloven, Skiltforskriften and Forskrift om bruk av
  kjøretøy are one `pnpm kb:ingest` each, and generation quality scales directly with what is in
  there.

---

## Student quiz: two defects found by using it (2026-08-25)

The student panel shipped, and both entry points failed for the developer. Neither was visible from
the test suite, which is the point worth recording.

### The licence-class filter hid most of the question bank

`PrismaVariantSource.candidatesByTopic` read `licenseClassId: null` as _"questions that have no
licence class"_ rather than _"no class in play, do not filter"_. Practice and topic drills pass
`null`, so every question tagged class B — **12 of 17 in the developer's database, and nearly all
of a real bank** — was silently excluded.

Measured before and after, over the seven root topics:

```
before  traffic-participants=0 right-of-way=5 the-vehicle=0 speed-positioning=0
        signs-markings=0 responsibility=0 laws-rules=0        → most topics unusable
after   traffic-participants=2 right-of-way=7 the-vehicle=2 speed-positioning=2
        signs-markings=1 responsibility=2 laws-rules=1        → matches the unfiltered pool
```

A plain practice quiz went from 5 questions to 10; topic drills went from _"no questions
available"_ to working on every topic. Regression test added in
`attempt-service.integration.test.ts`: a class-tagged question must appear in a practice pool.

### The mock exam tile looked disabled but was not

It was rendered at 50% opacity with an explanatory label — and still submitted, producing
`pool cannot fill exam blueprint` on a generic error page. It is now genuinely `disabled`, with the
count in its tooltip.

Behind that, `startQuizAction` no longer lets engine errors reach the error boundary: a thin pool
is a normal state for a new school, so it returns a message that says what is missing
(`quiz.errors.noQuestions`, `quiz.errors.examPoolTooSmall`) instead of "Something went wrong".

### Verified against the running app

|                                                            |                                 |
| ---------------------------------------------------------- | ------------------------------- |
| Practice, returning student (had already seen 5 questions) | Question 1 of 10                |
| Topic drill — The vehicle / Laws / Signs                   | 2, 1 and 1 questions, all start |
| Mock exam tile at 17 approved                              | genuinely disabled              |
| Pre-submission page renders leaking an answer              | **0**                           |

Totals: **239 unit/integration**, **22 e2e**, all green.

---

## Amendment verification — 2026-08-25 · uniqueness, difficulty, and learning from rejection

The complaint was concrete: _"the ai is generating one question multiple time"_, plus a request for
a real difficulty spread, alternates that different students may each get, and no repeated question
or repeated rule inside one exam.

### The defect, measured before touching anything

```
81 questions in the bank        34 were repeats of another question (42%)
difficulty spread               level 1: 21   level 2: 45   level 3: 3   level 4–5: 0
```

The existing guard was `stemFingerprint()` — an exact match on the normalised stem. It caught
nothing here (the model re-words itself) and it never ran _within_ a generation batch at all.

### What now stands between the model and the question bank

| Check                                  | Where                                              | Effect                              |
| -------------------------------------- | -------------------------------------------------- | ----------------------------------- |
| Same question, twice in one run        | `generation/theory.ts`, cosine ≥ 0.94 vs the batch | rejected `DUPLICATE_IN_BATCH`       |
| Same question as one already written   | `classifyAgainstPool`, incl. retired               | rejected `DUPLICATE_OF_EXISTING`    |
| Same rule, different words             | 0.85–0.94                                          | **kept**, shares a `conceptGroupId` |
| Two phrasings of one rule in one paper | `assembly.ts` `usedConceptGroups`                  | never served together               |
| A paper drifting easy                  | `DIFFICULTY_TARGET` 30/40/30                       | balanced whole-paper                |

Thresholds were calibrated on this bank, not guessed — the evidence is in `DECISIONS.md`
(2026-08-25 · spec-04/05). Grouping is complete linkage after single linkage was seen chaining
"yield to the right" into "turning left yields to oncoming" — nine questions, two different rules.

### Cleanup of what was already there

```
$ pnpm qb:dedupe --apply
Embedded 81 question(s).
Round 1: 34 repeat pairs …   Round 2: 1 …   Round 3: nothing above the repeat threshold.
0 repeat pair(s) remaining.

# end state, from the database:
#   34 questions retired with reason DUPLICATE — 25 of them deleted,
#    9 kept (a student had already sat them), retired so they are never served again.
```

Rounds are required because removing one half of a pair changes who everyone's nearest neighbour
is. A question a student has actually sat is retired but **not** deleted — `deleteItem` refuses it,
and that refusal is the point: an exam record must keep pointing at the question that was asked.

### Generation after the change

```
$ pnpm ai:generate right-of-way 8
asked for 8, model returned 8, 4 passed the quality gate, 4 rejected
  rejected [DUPLICATE_OF_EXISTING] You approach an intersection with no traffic signs …
  rejected [DUPLICATE_OF_EXISTING] You are driving a car and intend to turn right into a side street …
```

Across 14 runs the guard rejected the model's repeats every time — it is especially fond of one
bus-leaving-a-bus-stop question. New drafts came out at levels 1–5 as **9 / 9 / 28 / 19 / 1**
against the old 21 / 45 / 3 / 0 / 0.

### Real papers, assembled from the live bank

```
$ pnpm qb:audit 5
Class B: 45 questions, pass at 38.
Readiness: 67 distinct concepts available, 45 required.
  paper 1: 45/45 questions · repeated question 0 · repeated rule 0 · easy 18 / medium 18 / hard 9
  paper 2: 45/45 · 0 · 0 · easy 17 / medium 19 / hard 9
  paper 3: 45/45 · 0 · 0 · easy 18 / medium 18 / hard 9
  paper 4: 45/45 · 0 · 0 · easy 18 / medium 19 / hard 8
  paper 5: 45/45 · 0 · 0 · easy 17 / medium 17 / hard 11
15 of 25 grouped rule(s) were asked in different words across these papers —
two students meet the same rule, not the same sentence.
All papers clean.
```

That last line is the other half of the request: alternates are kept precisely so different
students can meet one rule through different phrasings, while no single paper ever contains two of
them.

Readiness and `rebalanceToAvailability` now count **distinct concepts, not rows** — counting rows
reported a bank as ready and then assembled short.

### Learning from rejection

Every refusal is kept in `GenerationRejection` and handed back to the next run for that topic:

```
$ buildRejectionLessons(db, <right-of-way>)

LEARN FROM THESE REJECTIONS — real questions that were refused for this school.
Do not write anything resembling them, and do not repeat the mistake they were rejected for:
1. "You are driving on a road with a speed limit of 50 km/h and intend to drive past a bus
   stopped at a bus stop. …" — rejected because it repeated a question already in the bank.
   Reviewer: "Same question as cmt8bbxe40003kkw5rpoy0sx4 (cosine 0.984)."
2. "You are driving on a road with a speed limit of 50 km/h. A bus gives a signal that it is
   about to leave a bus stop. …" — rejected because that question had already been written.
…
topReasons: [{"code":"DUPLICATE_OF_EXISTING","count":4},{"code":"DUPLICATE","count":1}]
```

63 refusals are on the ledger so far — 34 from reviewers (the dedupe cleanup runs as a reviewer,
with its cosine in the note) and 29 from the duplicate check during generation.

The review queue now takes an optional note _before_ the reason buttons, and it is quoted verbatim.
`transitionItemInput` separates `reason` (the enum code) from `note` (the words) — previously the
code was written into `reviewNote` and the reviewer's own wording had nowhere to go.

### Topic column was blank for most questions

`/admin/questions` loaded root topics only, while 58 of the questions are tagged to a subtopic
(`roundabouts`, `right-hand-rule`, …) — so their topic cell fell through to "—". The page now loads
the whole tree, the filter lists children indented under their root, and filtering by a root matches
its **subtree** (a recursive CTE) instead of only questions tagged to the root itself.

Totals: **261 unit/integration** green, `tsc` and `eslint` clean.

---

## Amendment verification — 2026-08-25 · answers are final, and a test can be resumed

### An answer could be improved after the answer was shown

Answers were already written per question, but `answer()` overwrote an existing one, and the runner
cleared its reveal state on navigation. So in practice mode: answer, read the correct answer, press
Back, change the answer. Every practice score was a formality.

Three layers now:

| Layer                           | Behaviour                                                         |
| ------------------------------- | ----------------------------------------------------------------- |
| `attempt-service.answer`        | a _different_ answer to an answered question → `ConflictError`    |
| `tp_attempt_question_immutable` | the same refusal at the table, service bypassed                   |
| `quiz-runner.tsx`               | the card locks and says "Answer recorded — it cannot be changed." |

Re-sending the **same** answer stays idempotent — a retry or a double tap must not become an error.

Navigating back to an answered practice question re-shows its explanation through a new read,
`revealAnswered`, rather than by shipping answer keys with the page: it refuses EXAM mode and
refuses any question that has not been answered yet, so the anti-leak invariant is untouched.

```
✓ refuses a different answer to a question already answered
✓ the database refuses it too, even when the service is bypassed
✓ practice: the answer cannot be improved after the explanation is shown
✓ re-sending the SAME answer stays idempotent — a retry is not a change
✓ returns what was already shown, so navigating back is not a blank card
✓ refuses a question that has not been answered, and refuses EXAM mode outright
```

### Resume, and the record

```
✓ offers the unfinished test back, with how far the student got
✓ does not offer a timed test whose clock ran out while they were away
✓ offers nothing once the test is handed in, and the record shows it instead
✓ e2e: an answer cannot be changed once it is given, and the test resumes where it was left
```

The home page now leads with a Continue card (progress bar, time left, mode) when a test is
unfinished, then the last three tests with score, percentage and a pass/fail badge. Opening an
attempt that is no longer in progress redirects to its result instead of rendering an unanswerable
paper. The result page gained date, time used, percentage, wrong count, per-topic bars, and the
seal and guarantee badges.

Totals: **271 unit/integration**, **24 e2e**, all green.

---

## Amendment verification — 2026-08-25 · naming, the record, and category standing

**Renamed.** The configured run from the setup screen is now the **Test**; the quick ten-question
run is the **Mock exam**. Names come from an explicit `AttemptKind`, not from the engine's `mode` —
a configured test runs in TOPIC mode internally, and calling it "Topic practice" in the record was
simply wrong. The old `history.mode.*` keys are deleted rather than left in place, so a missed call
site fails the message-key test instead of quietly rendering the old word.

**The record is tests only.** `mode = EXAM`, or an attempt carrying a `setupSnapshot` — which only
the setup screen writes. Practice runs and topic drills are excluded; `onlyTests: false` still
returns everything.

```
✓ the record is tests only — a mock exam is practice, and practice is not the record
✓ a configured test IS the record, and is named a test whatever its engine mode
```

**Category standing** sits above the record. Aggregates over closed test attempts, counts only
questions actually answered, and lists every root category:

```
✓ tested categories carry their own counts:      3 answered, 1 correct   → 33%
✓ untested categories are listed, not omitted:   answered 0, percent null → "Not tested yet"
✓ percent is always correct/answered, never correct/total
```

Blanks are excluded on purpose: a blank scores zero on the test but is not evidence that a category
is weak, and the panel exists to point at weak categories. In-progress attempts are excluded too —
their answers are ungraded until submission, and grading them for this panel would put correctness
about a live exam in front of the student. The panel fills as soon as a test is handed in.

Totals: **273 unit/integration**, **24 e2e**, all green.
