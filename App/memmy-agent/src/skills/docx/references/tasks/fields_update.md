# Task: Fields + update behavior (TOC / page # / refs)

## Goal
Avoid "looks wrong" renders that are actually **stale Word fields**.

Common fields:
- `PAGE` — current page number
- `NUMPAGES` — total page count
- `TOC` — table of contents
- `REF` / `PAGEREF` — cross references (often "see page X")

## When this matters
- PDF/PNG render shows placeholders (e.g., TOC looks empty, refs show wrong page, page numbers all “1”).
- The doc was modified programmatically (Node OOXML / OOXML patch) and then exported without a field refresh.
- LibreOffice vs Word disagree.

## What to do
### 1) Scan for fields
Run a quick field inventory:

```bash
node scripts/fields_report.mjs /mnt/data/input.docx
```

If you see `TOC`, `REF`, `PAGEREF`, `NUMPAGES`, or `PAGE`, plan for a field refresh step.

### 2) Render and inspect

```bash
node scripts/render_docx.mjs /mnt/data/input.docx --output_dir /mnt/data/out
```

Inspect all `page-*.png` at 100% zoom.

### 3) If anything is wrong: update fields in a GUI editor
**Fast checklist (Word):**
1. Open the DOCX in **Microsoft Word**
2. `Ctrl+A` (select all)
3. `F9` (Update Fields)
4. Save
5. Re-render with `render_docx.mjs`

LibreOffice (GUI) can also update fields, but Word is the reference implementation.

## Deterministic rendering workaround (when you can't update fields)
If your goal is **stable PNG regression testing** (not perfect Word semantics), you can
*materialize* some field results into literal text so headless renders won't omit them:

```bash
# Replace REF/PAGEREF blocks with their currently cached visible text
node scripts/flatten_ref_fields.mjs input.docx --out ref_flattened.docx

# Materialize SEQ/REF results (e.g., caption numbers / cross-refs)
node scripts/fields_materialize.mjs ref_flattened.docx --out fields_materialized.docx
```

Notes:
- This does **not** refresh TOC/PAGE/NUMPAGES; those still typically require Word/LO GUI.
- Always render and visually verify after materialization.

## Render → PNG review checklist (fields)
- Page numbers increment correctly (footer/header)
- Total page count (`NUMPAGES`) matches the rendered page count
- TOC entries exist, have correct indentation, and page numbers match headings
- Cross references (`REF`/`PAGEREF`) resolve (no "Error! Reference source not found.")
- No placeholder text like “(TOC will populate...)” remains
