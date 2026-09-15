# OOXML: Hyperlinks, headers/footers, and fields (page numbers)

This file covers the common "small but annoying" features that often require OOXML or low-level Node OOXML work.

## Hyperlinks
### Reality
`Node OOXML` can create external hyperlink relationships but does not provide a high-level hyperlink API. The easiest path is to build the `<w:hyperlink>` element manually.

### Pattern (external hyperlink)
1) Create a relationship to the URL (Type = `RT.HYPERLINK`)
2) Insert a `<w:hyperlink r:id="...">` containing a run with a `<w:t>`

Minimal Node OOXML sketch:
```node
const relationshipId = addExternalRelationship(documentRelationships,
  "https://example.com");
const hyperlink = createElement(document, "w:hyperlink", {
  "r:id": relationshipId,
});
const run = createElement(document, "w:r");
const properties = createElement(document, "w:rPr");
append(properties, createElement(document, "w:color", { "w:val": "0000FF" }));
append(properties, createElement(document, "w:u", { "w:val": "single" }));
append(run, properties);
append(run, createTextElement(document, "w:t", "link text"));
append(hyperlink, run);
append(firstParagraph, hyperlink);
```

## Headers and footers
### Right-aligned date header
Most of the time Node OOXML is enough:
```node
const headerParagraph = firstHeaderParagraph(headerPart);
setParagraphAlignment(headerParagraph, "right");
setParagraphText(headerParagraph, "Date: 01/05/2026");
```

### Footer left/center/right zones
A common reliable trick is a 1x3 table (remember: width required in headers/footers):
```node
const table = createTable(document, { rows: 1, columns: 3, widthInches: 6.5 });
setParagraphAlignment(tableCellParagraph(table, 0, 0), "left");
setParagraphAlignment(tableCellParagraph(table, 0, 1), "center");
setParagraphAlignment(tableCellParagraph(table, 0, 2), "right");
```

## Page number field
### Reality
A PAGE field is a Word field code. Some renderers may show placeholder values in PDF unless fields are updated.

### Pattern
Insert a field with `w:fldChar` begin/separate/end and an `w:instrText` of `PAGE`.

See `scripts/docx_ooxml_patch.mjs` for helpers that add a centered page number field to the footer and add an external hyperlink.

### Helper limitations (intentional)
The `--hyperlink-first` helper is pragmatic: it replaces the first paragraph with a single linked run. It does not preserve per-run formatting. It does preserve leading/trailing spaces via `xml:space="preserve"` when needed.
