---
name: xlsx
description: Create, inspect, edit, recalculate, validate, render, and deliver Excel workbooks while preserving formulas, formatting, drawings, links, macros, and metadata.
---

# Workbook workflow

Trigger for `.xlsx`, `.xlsm`, `.xltx`, `.csv`, and `.tsv` workbooks or requests
to create, read, edit, clean, format, calculate, chart, or convert them. Do
not use it for ordinary documents, web pages, databases, or live external
spreadsheet APIs.

1. Copy an existing workbook to a unique temporary directory and inspect it
   with `scripts/inspect_workbook.mjs --input <file> --json` before editing.
2. Preserve formulas, cached values, styles, merges, tables, filters,
   validations, conditional formatting, charts, images, shapes, comments,
   hidden sheets, links, macros, and metadata. Only modify the requested
   cells or objects.
3. After adding or changing formulas run
   `scripts/recalculate_workbook.mjs --input <file> --output <file>
   --json`. A completed recalculation with formula errors is reported as
   `errors_found`; a conversion or process failure is a separate failure.
4. Run `scripts/check_workbook.mjs <file> --json`; use `--allow-lossy` only
   when the caller explicitly accepts the listed loss. The checker does not
   use PPTX or XSD data.
5. Render with `scripts/render_with_office.mjs <file> --output-dir <dir>` and
   inspect every sheet/page. Reopen the output and verify formulas, cached
   values, objects, and that the original hash is unchanged.

CSV/TSV input requires an explicit encoding, BOM, delimiter, quote, newline,
and malformed-row policy. Never replace formulas with constants unless a
static export was requested. External links, macros, unsupported extensions,
and objects that cannot be safely preserved fail closed.

All commands are standalone Node CLIs. They write stable JSON with `--json`,
diagnostics to stderr, and non-zero status for invalid input, missing Office,
timeout, or unsafe preservation. The bundled renderer is resolved through
`MEMMY_OFFICE_RENDERING_ROOT`, the legacy DOCX override during migration, the
packaged Office payload, and the source payload; it never silently falls back
to a system PATH installation.

See `references/workbook-workflow.md`, `references/formula-recalculation.md`,
and `references/layout-and-preservation.md` for the full SOP.
