Use the Office plugin tools discovered through MCP (`office_status`, `office_import`,
`office_create`, `office_inspect`, `office_edit`, `office_convert`, `office_render`,
`office_review_page`, `office_deliver`; the Host adds its own tool prefix). Do not bypass the plugin with
shell commands or modify input files in place. No account or official model is required.

1. Call `office_status` to check dependencies. Report missing runtimes accurately.
2. For uploads, call `office_import` with the actual Host-provided upload path;
   do not fabricate paths. For new files, call `office_create` with structured content.
   DOCX/PDF use title and paragraphs; PPTX uses slides with title/body/notes;
   XLSX uses named sheets of rows, including `{formula: "SUM(B2:B4)"}` cells.
   For advanced work use `office_execute`: provide an async JavaScript function
   body with preloaded `docx`, `ExcelJS`, `PptxGenJS`, `JSZip`, `PDFLib`, `DOMParser`,
   `XMLSerializer`, `fs` (promises), `path`, and `workspace`. Write outputs with
   `path.join(workspace, name)` and return `{files:["report.docx"]}`. For templates
   pass sourceTaskId and selected inputFiles; they are copied into a fresh task.
   Code has no network, subprocess, native-addon or external filesystem access.
   Read the original format references for OOXML edits and preservation rules.
   All generated files still require rendering, page review and delivery.
3. Keep taskId and file from the result. Call `office_inspect` before editing.
   DOCX/PPTX exact replacements can match text split across formatting runs.
   XLSX cell edits preserve untouched package parts. Never replace formulas with
   constants. PDF is read, recreated, or produced by conversion; direct PDF text
   editing, macros, encrypted files and unsafe preservation are unsupported.
   Do not claim unsupported tasks succeeded.
4. After formula changes, call `office_convert` to XLSX only with the user's
   acceptance of possible LibreOffice object/format changes (`allowLossy: true`).
   Without that acceptance, retain formulas but report uncached results and do not
   deliver a workbook that has not been recalculated.
   CSV/TSV conversion requires explicit UTF-8 encoding, BOM presence, delimiter,
   double-quote convention, LF/CRLF newline and rejection of malformed rows.
   All imported fields remain text, preserving leading zeros and preventing
   accidental evaluation of formula-looking CSV fields.
5. Call `office_render` on the exact final file. It renders actual Office pages,
   returns page numbers and a revision token. Call `office_review_page` for EVERY
   page; it returns an inline PNG through MCP and a hosted preview with role `setup`.
   Inspect every returned page image; check
   overflow, overlap, missing glyphs, tables, charts, margins and page breaks.
   A successful conversion or structural check alone is not visual approval.
6. Fix defects and render again. Only then call `office_deliver`, passing the
   exact revision, all reviewed page numbers and concrete review notes. Source
   mutations invalidate review. Return the final Host-provided preview/download
   links and workspace path. Internal QA images are not final deliverables.

Do not invent an `office_*` tool if the plugin is disabled or uninstalled.
Report that Office must be installed. Use the lightest suitable file layout;
retain source files, notes, formulas, charts and metadata when editing.
