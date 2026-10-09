# Deck workflow

Copy an input deck into a unique temporary directory before inspection or
editing. Identify whether the task is creation, extraction, template filling,
editing, merge/split, or conversion. Set the layout before adding a slide;
keep layout, theme, master, media, chart, notes, comment, relationship, and
hidden-slide parts connected.

Use `clone_slide.mjs <package-or-directory> <slide.xml> --output <deck>` for
copying a slide and `prune_orphans.mjs <directory>` after the final order is
known. Validate with `check_deck.mjs <path> --json`, render with
`render_with_office.mjs --headless --convert-to pdf <path> --output-dir <dir>`,
then make a review grid with `make_contact_sheet.mjs --input <path>
--output-dir <dir> --prefix <unique-prefix>`. A failed conversion, missing
payload, malformed XML, missing relationship, or unresolved placeholder stops
the workflow.

Never overwrite the source. Write repairs to a temporary copy and atomically
replace the requested output only after the package reopens and the structural
and visual checks pass.
