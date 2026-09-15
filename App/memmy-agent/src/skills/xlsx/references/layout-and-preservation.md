# Layout and preservation

Preserve fonts, fills, borders, alignment, number formats, row heights,
column widths, merges, tables, filters, conditional formatting, validations,
freeze panes, charts, images, shapes, comments, sheet visibility, hyperlinks,
macros, external links, and custom metadata. Keep drawings as native OOXML
objects rather than screenshots. Check relationship targets and reopen after
each write. Cross-platform visual differences must include the Office and
font versions in the QA report.

`check_workbook.mjs` runs the OOXML, formula, layout, and drawing checkers. It
does not perform XSD validation and does not read the PPTX skill's schema
directory.
