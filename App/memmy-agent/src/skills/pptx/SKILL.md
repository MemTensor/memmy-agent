---
name: pptx
description: Create, inspect, edit, validate, render, and deliver PowerPoint presentations and templates while preserving OOXML structure and user metadata.
---

# PPTX workflow

Use this skill whenever the input or requested output is a `.pptx` or `.potx`
presentation, slide deck, template, slide layout, speaker notes, comments, or
slide conversion. It is not a replacement for ordinary document or image
editing.

## Decide the operation

- For a new deck, create one `pptxgenjs` presentation, set its layout before
  adding slides, and keep charts and tables editable.
- For an existing deck, copy it to a private temporary directory first. Use
  `scripts/inspect`-style OOXML inspection through the checkers, then edit only
  requested parts with `jszip` and XML parsing.
- To duplicate a slide use `scripts/clone_slide.mjs`; do not copy one XML file
  by hand. To remove unused parts use `scripts/prune_orphans.mjs` only after
  the final slide order is established.
- For `.ppt` input, convert a temporary copy with
  `scripts/render_with_office.mjs --headless --convert-to pptx` when the
  bundled Office payload supports it. Conversion failure is a hard failure.

## Required quality sequence

1. Work in a unique temporary directory and leave the source unchanged.
2. Make all slide additions, deletions, and ordering changes.
3. Fill content while preserving theme, notes, comments, media, charts,
   embedded objects, hidden slides, and user metadata.
4. Run `scripts/check_deck.mjs <deck-or-directory> --json`; pass
   `--baseline <template>` only for a template baseline. Use `--auto-repair`
   only for the safe ID/relationship repairs reported by the checker.
5. Render with `scripts/render_with_office.mjs --headless --convert-to pdf
   <deck> --output-dir <dir>` and inspect every page. Create a grid with
   `scripts/make_contact_sheet.mjs --input <deck> --output-dir <dir>
   --prefix <unique-name>` when a compact review is useful.
6. Reopen the output with the checker and confirm page count, notes, media,
   charts, hidden slides, and metadata before delivery.

## Design and content checks

Set a deliberate 16:9 or standard layout before adding slides. Use six-digit
hex colors without alpha in the color field, native bullets, speaker notes,
and editable charts. Keep text left aligned, provide at least 0.5 inch safe
margins, and avoid overflow, overlap, low contrast, placeholder text, and
decorative edge bars. Typical sizes are 36–44 pt titles, 20–24 pt section
titles, 14–16 pt body, and 10–12 pt notes. Font choice and any cross-platform
rendering difference must be recorded in the QA report.

The final scan is case-insensitive for `xxx`, `lorem`, `ipsum`, `TODO`,
`[insert`, and template phrases such as “this … slide/page … layout”. Any
match blocks delivery.

## Script contracts

Every script is a standalone Node CLI with `--help`, stable JSON on
`--json`, non-zero status for missing or invalid inputs, and no shell command
fallback. The renderer resolves the bundled Office payload through
`MEMMY_OFFICE_RENDERING_ROOT`, the legacy `MEMMY_DOCX_RENDERING_ROOT` during
migration, the packaged `dist/extra-dependencies/office-rendering`, and then
the source directory. It never silently uses a system PATH installation.

See `references/deck-workflow.md`, `references/ooxml-editing.md`, and
`references/validation-and-rendering.md` for the detailed decision tree and
failure semantics.
