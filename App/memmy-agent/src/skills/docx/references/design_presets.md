# Design Presets

Use this reference for new DOCX creation and major rewrites that do not have a selected template or supplied design reference. Existing-document edits should preserve the source document's style unless the user asks for a redesign.

## Required workflow

1. Pick exactly one preset or archetype alias before drafting, based on the document's audience and content.
2. Resolve it into a concrete token map with exact values for every preset-controlled property: page geometry, margins, header/footer distance, body spacing, heading spacing, line spacing, list marker alignment, list text indent, hanging indent, table widths, table indents, cell margins, colors, and fills.
3. Apply the tokens through Word styles, real numbering definitions, explicit table geometry, callout styles, headers, and footers.
4. Treat any deviation as a named override and reuse that override consistently.
5. Before rendering, audit the DOCX against the selected token map, including direct inspection of styles, numbering definitions, section properties, and table XML when needed.

Do not combine presets in one document unless the user explicitly asks for a mixed style system. Do not rely on Word defaults, inherited built-in style values, or approximate visual matches. If a value appears in the selected preset, encode that exact value in the DOCX.

## Exactness requirement

Preset compliance means the generated DOCX carries the selected preset's actual numbers:

- Paragraph styles must encode the preset's font, size, color, `before`, `after`, and line spacing values. For OOXML, this means values such as `w:before`, `w:after`, and `w:line` are present where the preset controls them.
- Lists must use numbering definitions whose marker alignment, text indent, hanging indent, tab stop, paragraph spacing, and line spacing match the preset. Built-in styles such as `List Bullet` or `List Number` are acceptable only after their numbering definitions have been set or patched to the preset values.
- Tables must use fixed DXA geometry. `tblW`, `tblGrid/gridCol`, and every `tcW` must agree with the preset or a named table-pattern override. `tblInd` must match the start cell margin token so the visible outer border aligns with surrounding paragraph text.
- Table-adjacent citation text must use the selected preset's `table_citation_text` component token instead of inheriting body or caption defaults.
- Page setup must encode the preset's page size, margins, usable width, and header/footer distances in section properties.
- Named overrides are allowed only when the document needs a specific exception. Record the override and apply it consistently; do not let ad-hoc direct formatting drift across similar elements.

## Shared base tokens

All presets inherit these values unless they override them.

| Token | Value |
|---|---|
| Page size | US Letter, 8.5 x 11 in, portrait |
| Margins | 1.0 in top/right/bottom/left |
| Header/footer distance | 0.492 in |
| Usable width | 6.5 in / 9360 DXA |
| Base body style | `Normal` |
| Default base font | Calibri |
| Default base size | 11 pt |
| Heading 1 | 16 pt, `#2E74B5` |
| Heading 2 | 13 pt, `#2E74B5` |
| Heading 3 | 12 pt, `#1F4D78` |
| Table width | 6.5 in / 9360 DXA |
| Table indent | 120 DXA / 0.083 in, matching default start cell margin |
| Table geometry | fixed DXA `tblW`, `tblInd`, `tblGrid`, and matching `tcW` |
| Table default visual | thin single grid, white body cells, restrained optional header/callout fill |
| Header/footer style | quiet running label/header rule and muted right-aligned page number for multi-page polished docs |

## OOXML conversion cheatsheet

| Design value | OOXML value |
|---|---|
| 1.0 in | 1440 DXA |
| 6.5 in content/table width | 9360 DXA |
| 0.083 in table indent / cell start margin | 120 DXA |
| 0.5 in list text indent | 720 DXA |
| 0.38 in list text indent | about 540 DXA |
| 0.25 in marker alignment | 360 DXA |
| 0.18 in marker alignment | about 260 DXA |
| 0.19 in hanging indent | about 270 DXA |
| 10 pt before | `w:before="200"` |
| 8 pt after | `w:after="160"` |
| 7 pt after | `w:after="140"` |
| 6 pt after | `w:after="120"` |
| 5 pt after | `w:after="100"` |
| 4 pt before | `w:before="80"` |
| 4 pt after | `w:after="80"` |
| 3 pt after | `w:after="60"` |
| 1.333 line spacing | `w:line="320" w:lineRule="auto"` |
| 1.25 line spacing | `w:line="300" w:lineRule="auto"` |
| 1.208 line spacing | `w:line="290" w:lineRule="auto"` |
| 1.167 line spacing | `w:line="280" w:lineRule="auto"` |

## Preset token schema

Use this shape mentally or in builder code. Fill every value before writing content.

```yaml
document_style_preset:
  preset_name: "<resolved preset or alias>"
  page:
    size: Letter
    orientation: portrait
    margins: {top: 1.0in, right: 1.0in, bottom: 1.0in, left: 1.0in}
    header: 0.492in
    footer: 0.492in
    content_width: {in: 6.5, dxa: 9360}
  typography:
    base_font: "<font>"
    base_size: 11pt
    body: {alignment: left, before: 0pt, after: "<pt>", line_spacing: "<single|multiple>"}
  title:
    size: "<pt>"
    color: "<hex>"
    before: "<pt>"
    after: "<pt>"
  headings:
    h1: {size: 16pt, color: "#2E74B5", before: "<pt>", after: "<pt>"}
    h2: {size: 13pt, color: "#2E74B5", before: "<pt>", after: "<pt>"}
    h3: {size: 12pt, color: "#1F4D78", before: "<pt>", after: "<pt>"}
  lists:
    bullet_level_0: {marker: "•", marker_aligned_at: "<in>", text_indent_at: "<in>", hanging: "<in>", after: "<pt>", line_spacing: "<single|multiple>"}
    decimal_level_0: {marker: "%1.", marker_aligned_at: "<in>", text_indent_at: "<in>", hanging: "<in>", after: "<pt>", line_spacing: "<single|multiple>"}
  tables:
    width_dxa: 9360
    indent_dxa: 120
    border_style: single_grid
    header_fill: "<hex|none>"
    cell_margins_dxa: {top: 80, bottom: 80, start: 120, end: 120}
  table_citation_text:
    use: "source/citation text immediately above or below a table"
    paragraph: {before: 4pt, after: 4pt}
  colors:
    heading_blue: "#2E74B5"
    heading_dark_blue: "#1F4D78"
    ink_blue: "#0B2545"
    table_fill_blue_gray: "#E8EEF5"
    table_fill_light_gray: "#F2F4F7"
    callout_fill: "#F4F6F9"
    positive_dark_blue: "#1F3A5F"
    caution_gold: "#7A5A00"
    risk_red: "#9B1C1C"
```

## Base presets

### `standard_business_brief`

Use for formal memos, RFI responses, decision memos, board memos, and executive briefs.

```yaml
preset_name: standard_business_brief
typography:
  base_font: Calibri
  body: {size: 11pt, alignment: left, before: 0pt, after: 6pt, line_spacing: 1.10}
headings:
  h1: {size: 16pt, color: "#2E74B5", before: 16pt, after: 8pt}
  h2: {size: 13pt, color: "#2E74B5", before: 12pt, after: 6pt}
  h3: {size: 12pt, color: "#1F4D78", before: 8pt, after: 4pt}
lists:
  bullet_level_0: {marker_aligned_at: 0.25in, text_indent_at: 0.5in, hanging: 0.25in, after: 8pt, line_spacing: 1.167}
  decimal_level_0: {marker_aligned_at: 0.25in, text_indent_at: 0.5in, hanging: 0.25in, after: 8pt, line_spacing: 1.167}
tables:
  width_dxa: 9360
  indent_dxa: 120
  cell_margins_dxa: {top: 80, bottom: 80, start: 120, end: 120}
  border_style: single_grid
  header_fill: "#F2F4F7"
table_citation_text:
  use: "source/citation text immediately above or below a table"
  paragraph: {before: 4pt, after: 4pt}
```

### `compact_reference_guide`

Use for launch guides, negotiation briefs, checklists, and dense operator references.

```yaml
preset_name: compact_reference_guide
typography:
  base_font: Calibri
  body: {size: 11pt, alignment: left, before: 0pt, after: 6pt, line_spacing: 1.25}
headings:
  h1: {size: 16pt, color: "#2E74B5", before: 18pt, after: 10pt}
  h2: {size: 13pt, color: "#2E74B5", before: 14pt, after: 7pt}
  h3: {size: 12pt, color: "#1F4D78", before: 10pt, after: 5pt}
lists:
  bullet_level_0: {marker_aligned_at: 0.187in, text_indent_at: 0.375in, hanging: 0.188in, after: 4pt, line_spacing: 1.25}
  decimal_level_0: {marker_aligned_at: 0.187in, text_indent_at: 0.375in, hanging: 0.188in, after: 4pt, line_spacing: 1.25}
tables:
  width_dxa: 9360
  indent_dxa: 120
  cell_margins_dxa: {top: 80, bottom: 80, start: 120, end: 120}
  border_style: single_grid
  header_fill: "#E8EEF5"
  compact_label_detail_widths: [1.181in, 5.319in]
  standard_label_detail_widths: [1.875in, 4.625in]
table_citation_text:
  use: "source/citation text immediately above or below a table"
  paragraph: {before: 4pt, after: 4pt}
```

### `narrative_proposal`

Use for grant proposals, business proposals, and persuasive documents with longer prose.

```yaml
preset_name: narrative_proposal
typography:
  base_font: Calibri
  body: {size: 11pt, alignment: justified, before: 0pt, after: 8pt, line_spacing: 1.333}
headings:
  h1: {size: 16pt, color: "#2E74B5", before: 18pt, after: 10pt}
  h2: {size: 13pt, color: "#2E74B5", before: 12pt, after: 6pt}
  h3: {size: 12pt, color: "#1F4D78", before: 8pt, after: 4pt}
lists:
  bullet_level_0: {marker_aligned_at: 0.181in, text_indent_at: 0.375in, hanging: 0.194in, after: 4pt, line_spacing: 1.208}
  decimal_level_0: {marker_aligned_at: 0.181in, text_indent_at: 0.375in, hanging: 0.194in, after: 4pt, line_spacing: 1.208}
tables:
  width_dxa: 9360
  indent_dxa: 120
  cell_margins_dxa: {top: 80, bottom: 80, start: 120, end: 120}
  border_style: single_grid
  header_fill: "#F4F6F9"
table_citation_text:
  use: "source/citation text immediately above or below a table"
  paragraph: {before: 4pt, after: 4pt}
```

## Archetype aliases

Aliases inherit a base preset and override only the listed values.

| Alias | Base preset | Overrides |
|---|---|---|
| `rfi_response` | `standard_business_brief` | Body after 6pt; H1 before 16pt/after 8pt; H2 before 12pt/after 6pt; list marker 0.25in, text 0.5in; use 3-4 column full-width compliance matrices. |
| `decision_memo` | `standard_business_brief` | Base font Arial; body after 6pt; H1 before 12pt/after 6pt; H2 before 10pt/after 5pt; list marker 0.25in, text 0.5in. |
| `launch_messaging_guide` | `compact_reference_guide` | Body after 6pt, line 1.25; H1 before 18pt/after 10pt; H2 before 14pt/after 7pt; H3 before 10pt/after 5pt; table use can be heavy. |
| `contract_negotiation_brief` | `compact_reference_guide` | Body after 6pt; H1 before 14pt/after 8pt; H2 before 11pt/after 6pt; H3 before 8pt/after 4pt; prefer 1.181in/5.319in label-detail grids. |
| `neighborhood_business_proposal` | `narrative_proposal` | Body justified, after 8pt, line 1.333; H1 before 18pt/after 10pt; H2 before 12pt/after 6pt; H3 before 8pt/after 4pt; decimal lists may lead action sequences. |
| `grant_proposal` | `narrative_proposal` | Body left or justified by section, after 6pt, line 1.25 for compact prose; H1 before 16pt/after 8pt; H2 before 12pt/after 6pt; reserve tables for budget and evaluation. |

## Table patterns

Use full-width tables by default. Pick column widths by content and keep the total at 9360 DXA. Use `tblInd=120` DXA unless a named override intentionally changes table placement; this aligns the visible outer border with surrounding paragraph text instead of aligning only the first cell's text.

| Pattern | Widths | Use |
|---|---|---|
| One-column callout | 6.5 in | Message blocks, grouped examples, callouts. |
| Compact label-detail | 1.181 in, 5.319 in | Term/value, clause/position, compact reference rows. |
| Standard label-detail | 1.875 in, 4.625 in | Brief metadata, description tables, playbooks. |
| Two-up comparison | 3.25 in, 3.25 in | Option A/B, do/don't, before/after. |
| Three-column matrix | 1.5 in, 2.5 in, 2.5 in | Decision criteria, stakeholder impact, roadmap. |
| Four-column matrix | content-specific, sum 6.5 in | RFI compliance, budget, status, risk tables. |

Always run the table geometry helper or an equivalent audit after table generation.

## Preset audit

Before final render review, verify:

- Page size, margins, header/footer distance, and content width match the token map.
- Body and heading styles carry the selected font, size, color, spacing, and line spacing.
- Lists use real numbering definitions with the selected marker alignment, text indent, hanging indent, spacing, and line spacing.
- Tables use 9360 DXA unless intentionally compact, `tblInd` equals the start cell margin token, and `tblW`, `tblGrid`, and each `tcW` agree.
- Table-adjacent citation text above or below tables carries the selected preset's `table_citation_text` spacing.
- Callout/header/table fills use only the preset colors or a named override.
- Headers and footers are consistent across pages.
- There are no fake headings, fake bullets, manual numbering, percentage-width tables, fixed row heights that clip, or unexplained direct formatting drift.
