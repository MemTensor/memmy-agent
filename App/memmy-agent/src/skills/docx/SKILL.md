---
name: docx
description: Create, read, edit, review, redline, comment on, merge, audit, render, and verify .docx Word documents, including layout-sensitive and OOXML-level work.
---

# DOCX Skill

Use this skill when a task involves a Word `.docx` document and correctness
depends on document structure, formatting, tracked changes, comments, fields,
tables, forms, or rendered layout.

## Core workflow

1. Identify the operation: read/review, create/edit, template following,
   redlining/comments, conversion, or final verification.
2. Keep the source document unchanged for review and template-distillation
   work. Write outputs and intermediate files to a task-specific writable
   directory.
3. Use `Node OOXML` for ordinary paragraphs, runs, styles, tables,
   headers/footers, and page setup. Use the bundled helpers under `scripts/`
   for deterministic audits and OOXML operations.
4. After every meaningful create or edit batch, render the document with
   `render_docx.mjs`, inspect every generated page image, and iterate until the
   layout is clean.
5. Deliver only the requested final document. Keep rendered PNGs, temporary
   PDFs, audit JSON, and diff images as internal QA artifacts unless requested.

## Route to the relevant guide

Read only the supporting guide needed for the current operation:

- Existing-document reading or review: [references/tasks/read_review.md](references/tasks/read_review.md)
- Creating or editing a document: [references/tasks/create_edit.md](references/tasks/create_edit.md)
- Render and visual verification: [references/tasks/verify_render.md](references/tasks/verify_render.md)
- Accessibility and document structure: [references/tasks/accessibility_a11y.md](references/tasks/accessibility_a11y.md)
- Styles and formatting cleanup: [references/tasks/style_lint_normalize.md](references/tasks/style_lint_normalize.md)
- Templates and style packs: [references/tasks/templates_style_packs.md](references/tasks/templates_style_packs.md)
- Template distillation and creation: [references/template-distill.md](references/template-distill.md) and
  [references/template-create.md](references/template-create.md)
- Tables and spreadsheet-to-document conversion: [references/tasks/tables_spreadsheets.md](references/tasks/tables_spreadsheets.md)
- Forms/content controls: [references/tasks/forms_content_controls.md](references/tasks/forms_content_controls.md)
- Captions and cross-references: [references/tasks/captions_crossrefs.md](references/tasks/captions_crossrefs.md)
- Fields and field display text: [references/tasks/fields_update.md](references/tasks/fields_update.md)
- Navigation and table of contents: [references/tasks/navigation_internal_links.md](references/tasks/navigation_internal_links.md) and
  [references/tasks/toc_workflow.md](references/tasks/toc_workflow.md)
- Tracked changes: [references/tasks/clean_tracked_changes.md](references/tasks/clean_tracked_changes.md) and
  [references/ooxml/tracked_changes.md](references/ooxml/tracked_changes.md)
- Comments: [references/tasks/comments_manage.md](references/tasks/comments_manage.md) and
  [references/ooxml/comments.md](references/ooxml/comments.md)
- Hyperlinks, fields, headers, and page numbers: [references/ooxml/hyperlinks_and_fields.md](references/ooxml/hyperlinks_and_fields.md)
- Package relationships and content types: [references/ooxml/rels_and_content_types.md](references/ooxml/rels_and_content_types.md)
- Redaction, privacy, protection, watermarks, footnotes, merging, or sections:
  use the matching file under `references/tasks/`.

## Rendering and visual QA

The canonical renderer converts DOCX to PDF internally and rasterizes each page
to `page-<N>.png`:

```bash
node scripts/render_docx.mjs input.docx --output_dir /path/to/qa
```

Use `--emit_pdf` only when an intermediate PDF is useful for diagnosis. Use
`--verbose` when LibreOffice conversion needs debugging. Inspect every page at
full resolution for clipped or overlapping text, missing glyphs, broken tables,
unexpected page breaks, and header/footer drift. Text extraction or XML checks
alone cannot prove visual correctness.

If LibreOffice is unavailable, complete structural checks with the relevant
audits and state that visual QA could not be performed. If conversion fails for
another reason, diagnose the renderer/profile problem before judging the DOCX.

For repeated comparisons, use `scripts/render_and_diff.mjs`. For a quick
structural pass, use the audits for sections, headings, images, fields,
footnotes, comments, tables, styles, watermarks, accessibility, or content
controls as applicable.

## New documents and major rewrites

When no supplied template controls the design, choose exactly one preset from
[references/design_presets.md](references/design_presets.md):

- `standard_business_brief` for formal memos and executive briefs
- `compact_reference_guide` for checklists, launch guides, and dense references
- `narrative_proposal` for proposals and longer persuasive documents
- an archetype alias defined by the reference when it is a closer fit

Resolve the preset into explicit page, margin, typography, spacing, list,
table, color, header, and footer tokens before drafting. Use real Word styles,
numbering definitions, and fixed DXA table geometry; do not depend on inherited
defaults or visual approximations. Read [references/header_templates.md](references/header_templates.md)
when a new first-page header, cover, or title block is needed.

Use the lightest form factor that matches the content: prose for explanation,
bullets for unordered considerations, numbered steps for procedures, checklists
for acceptance criteria, callouts for warnings, and tables only for genuinely
tabular data. Avoid using tables as layout containers or turning cells into
long prose blocks.

## Editing, redlining, and OOXML

For an existing document, preserve the original structure and make the smallest
local change that satisfies the request. Do not rewrite unrelated paragraphs or
styles. Real tracked changes and Word comments require OOXML patching; use the
corresponding helpers and perform another render plus structural check after
any package-level change.

Use `scripts/privacy_scrub.mjs` before publication when personal metadata or
`rsid` values should be removed. Use `scripts/redact_docx.mjs` for explicit
redaction/anonymization requests and verify the result structurally and
visually. Use `scripts/set_protection.mjs` only when the requested output needs
editing restrictions.

## File and command conventions

- Refer to inputs and outputs by absolute paths when reporting results.
- Keep temporary work in a unique writable directory; never modify a retained
  reference document during inspection.
- Prefer the bundled Node/MJS helpers and the renderer bundled with the
  application. Check the renderer bundle before relying on an optional
  operation.
- Do not claim a render or audit passed unless its output was actually checked.
- Keep citation text human-readable; do not place internal tool tokens in the
  document.

## Bundled resources

The package includes the canonical renderer, OOXML notes, task playbooks,
design references, examples, and reusable scripts. `references/manifest.txt` lists the
bundled paths. Scripts are intended to be run from a writable working
directory, while this skill directory remains the source of reusable helpers.
