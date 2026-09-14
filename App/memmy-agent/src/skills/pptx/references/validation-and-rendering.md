# Validation and rendering

`check_deck.mjs` runs the OOXML package, slide, theme, chart, and skill-local
schema checks. It accepts a ZIP deck or an unpacked directory, emits stable
JSON with `ok`, `errors`, `warnings`, and `checks`, and exits non-zero when a
required check fails. `--baseline` only suppresses issues already present in a
template; relationship, content-type, chart, and XML errors remain fatal.
`--auto-repair` writes a temporary copy and is limited to deterministic ID,
whitespace, and orphan-relationship repairs.

Rendering is Office → PDF → Poppler PNG. Delete stale PDF/PNG files first and
use a unique output prefix. Review page dimensions, text overflow, overlap,
alignment, margins, contrast, chart labels, hidden-page markers, and
placeholders. A contact sheet is split into groups of at most 12 pages and is
never written into the skill directory. Reopen the final deck after rendering;
an unchanged source hash is part of the report.
