# Task: Create / edit a DOCX

## Default tool: Node OOXML
Use `Node OOXML` for:
- paragraphs/runs
- built-in heading styles (Heading 1 / Heading 2)
- tables (structure + cell text + basic formatting)
- simple headers/footers and margins

For a new document, choose and resolve a design preset before drafting. Set
title, heading, body, list, table, header, and footer styles explicitly rather
than relying on renderer defaults. See `references/design_presets.md`.

## Practical Node OOXML gotchas

### 1) Header/footer tables require a width
When adding tables to headers/footers, `add_table` requires an explicit width:

```node
const table = createTable(document, { rows: 1, columns: 3, widthInches: 6.5 });
setParagraphAlignment(tableCellParagraph(table, 0, 0), "left");
setParagraphAlignment(tableCellParagraph(table, 0, 1), "center");
setParagraphAlignment(tableCellParagraph(table, 0, 2), "right");
```

### 2) Fonts can require setting both `run.font.name` and `w:rFonts`
Some renderers/Word builds don’t respect only `run.font.name`:

```node
setRunFont(run, "Gill Sans");
setRunFontAttribute(run, "w:ascii", "Gill Sans");
setRunFontAttribute(run, "w:hAnsi", "Gill Sans");
```

### 3) “Clear header paragraph” isn’t always one call
If you need to replace an existing header paragraph, remove runs (or replace the paragraph XML). Avoid assuming a `clear()` method exists.

### 4) Tracked changes and comments are not first-class
If the user requests *real* tracked changes or *real* Word comments, plan for OOXML patching (see `references/ooxml/`).

## After every meaningful batch of edits: render and review
Use the loop from `references/tasks/verify_render.md` (DOCX → PNG) to avoid shipping layout defects. (Internally the renderer uses a PDF step; `--emit_pdf` can persist it if needed.)

## Output hygiene
Keep `/mnt/data` clean: deliverables only unless the user asks for intermediate render artifacts.
