# Flag SVGs

3:2 flags from [`country-flag-icons`](https://github.com/catamphetamine/country-flag-icons) (MIT),
copied in rather than imported: the switcher picks a file by country code at runtime, so a bundled
set would either ship every flag or pin the list at build time. Adding a language later means
dropping its SVG here — no code change.

Named by ISO 3166-1 alpha-2. A language with no file falls back to its short code, which is a
deliberate path, not a broken one: see `LANGUAGE_FLAG` in
`src/components/layout/language-switcher.tsx` for how a language maps to a country.
