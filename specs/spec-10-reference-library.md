# Spec 10 — Reference Library & Utilities

## In scope

- Signs catalog: all signs from registry grouped by class, search (bilingual names), sign detail (SVG, meaning, related rules with citations), "Quiz me on this group" → Spec-07 sign mode.
- Road-markings catalog: same pattern.
- Curriculum articles: MDX or DB-backed bilingual pages per topic, editable by instructor, linked from wrong-answer "Read more".
- Trailer calculator (feature-flagged): inputs (car curb weight, max towing capacity braked/unbraked, max total weight, trailer weights) → verdict card: allowed with B / needs B96 / needs BE, with rule citations; pure typed function + exhaustive unit tests; clearly marked "guidance, verify with Statens vegvesen".
- Free public demo quiz (no auth): N questions from a demo pool, results teaser + school contact CTA; rate-limited per IP; noindex on result pages.

## Acceptance checklist

- [ ] Every registry sign reachable via search in both languages.
- [ ] Trailer calculator: 15+ unit-test cases incl. boundary weights, matches B/B96/BE rules.
- [ ] Demo quiz works logged-out, cannot touch real student pool stats.
