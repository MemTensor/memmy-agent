#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import ExcelJS from "exceljs";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
function parseXml(text) {
  return new DOMParser().parseFromString(text, "application/xml");
}
function xmlBytes(doc) {
  let value = new XMLSerializer().serializeToString(doc);
  if (!value.startsWith("<?xml"))
    value = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + value;
  return Buffer.from(value);
}
function create(doc, name) {
  return doc.createElementNS(W_NS, `w:${name}`);
}
function appendText(doc, parent, value, bold = false) {
  const run = create(doc, "r");
  if (bold) {
    const props = create(doc, "rPr");
    props.appendChild(create(doc, "b"));
    run.appendChild(props);
  }
  const text = create(doc, "t");
  text.appendChild(doc.createTextNode(value));
  if (/^\s|\s$/.test(value)) text.setAttribute("xml:space", "preserve");
  run.appendChild(text);
  parent.appendChild(run);
}
function emptyDocument() {
  const doc = parseXml(
    `<?xml version="1.0"?><w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}"><w:body/></w:document>`,
  );
  const body = doc.documentElement.getElementsByTagNameNS(W_NS, "body")[0];
  const section = create(doc, "sectPr");
  const size = create(doc, "pgSz");
  size.setAttribute("w:w", "12240");
  size.setAttribute("w:h", "15840");
  const margin = create(doc, "pgMar");
  for (const [name, value] of [
    ["top", "1440"],
    ["right", "1440"],
    ["bottom", "1440"],
    ["left", "1440"],
  ])
    margin.setAttribute(`w:${name}`, value);
  section.appendChild(size);
  section.appendChild(margin);
  body.appendChild(section);
  return doc;
}
function paragraph(doc, text, bold = false) {
  const p = create(doc, "p");
  appendText(doc, p, text, bold);
  return p;
}
function formatValue(cell) {
  const value = cell.value;
  if (value == null || value === "") return "";
  if (typeof value === "boolean" || typeof value === "number") {
    if (typeof value === "number" && cell.numFmt?.includes("%"))
      return `${(value * 100).toFixed(2)}%`;
    if (typeof value === "number" && cell.numFmt?.includes("$"))
      return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && "result" in value) return String(value.result ?? "");
  return String(value);
}
function usedBounds(sheet) {
  let maxRow = 0,
    maxCol = 0;
  sheet.eachRow({ includeEmpty: true }, (row, rowNumber) =>
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      if (formatValue(cell).trim()) {
        maxRow = Math.max(maxRow, rowNumber);
        maxCol = Math.max(maxCol, colNumber);
      }
    }),
  );
  return [maxRow, maxCol];
}
async function main() {
  const invocationArgs = process.argv.slice(2);
  if (invocationArgs.includes("--help") || invocationArgs.includes("-h")) {
    process.stdout.write(
      [
        "usage: xlsx_to_docx_table.mjs [-h] [--out OUT] [--sheet SHEET]",
        "                             [--header_rows HEADER_ROWS] [--title TITLE]",
        "                             xlsx [out_docx]",
        "",
        "Convert an XLSX sheet to a DOCX table",
        "",
        "positional arguments:",
        "  xlsx",
        "  out_docx",
        "",
        "options:",
        "  -h, --help            show this help message and exit",
        "  --out OUT             Output DOCX path (alias)",
        "  --sheet SHEET         Sheet name (default: active)",
        "  --header_rows HEADER_ROWS",
        "                        How many top rows to bold",
        "  --title TITLE         Optional title paragraph above the table",
        "",
      ].join("\n"),
    );
    return;
  }
  if (invocationArgs.length === 0) {
    process.stderr.write(
      [
        "usage: xlsx_to_docx_table.mjs [-h] [--out OUT] [--sheet SHEET]",
        "                             [--header_rows HEADER_ROWS] [--title TITLE]",
        "                             xlsx [out_docx]",
        "xlsx_to_docx_table.mjs: error: the following arguments are required: xlsx",
        "",
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }
  const args = process.argv.slice(2);
  const input = args[0];
  let output = null,
    positionalOutput = null,
    sheetName = null,
    headerRows = 1,
    title = null;
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === "--out") output = args[++i];
    else if (args[i] === "--sheet") sheetName = args[++i];
    else if (args[i] === "--header_rows") headerRows = Number(args[++i]);
    else if (args[i] === "--title") title = args[++i];
    else if (!args[i].startsWith("--") && !positionalOutput) positionalOutput = args[i];
    else {
      console.error(`unknown argument: ${args[i]}`);
      process.exitCode = 2;
      return;
    }
  }
  output ||= positionalOutput;
  if (!input || !output) {
    console.error("usage: xlsx_to_docx_table.mjs input.xlsx [out.docx] --out out.docx");
    process.exitCode = 2;
    return;
  }
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(input);
  const sheet = sheetName ? workbook.getWorksheet(sheetName) : workbook.worksheets[0];
  if (!sheet) throw new Error(`Worksheet not found: ${sheetName}`);
  const [rows, cols] = usedBounds(sheet);
  if (!rows || !cols) throw new Error("Sheet appears empty");
  const data = [];
  const maxLengths = Array(cols).fill(0);
  for (let rowIndex = 1; rowIndex <= rows; rowIndex += 1) {
    const values = [];
    for (let colIndex = 1; colIndex <= cols; colIndex += 1) {
      const value = formatValue(sheet.getCell(rowIndex, colIndex));
      values.push(value);
      maxLengths[colIndex - 1] = Math.max(maxLengths[colIndex - 1], value.length);
    }
    data.push(values);
  }
  const document = emptyDocument();
  const body = document.documentElement.getElementsByTagNameNS(W_NS, "body")[0];
  const section = body.lastChild;
  if (title) body.insertBefore(paragraph(document, title), section);
  const table = create(document, "tbl");
  const props = create(document, "tblPr");
  const width = create(document, "tblW");
  width.setAttribute("w:type", "auto");
  width.setAttribute("w:w", "0");
  props.appendChild(width);
  const layout = create(document, "tblLayout");
  layout.setAttribute("w:type", "fixed");
  props.appendChild(layout);
  table.appendChild(props);
  const grid = create(document, "tblGrid");
  const widths = maxLengths.map((length) =>
    Math.round(Math.max(0.8, Math.min(3, 0.12 * Math.max(length, 4))) * 1440),
  );
  for (const value of widths) {
    const col = create(document, "gridCol");
    col.setAttribute("w:w", String(value));
    grid.appendChild(col);
  }
  table.appendChild(grid);
  for (let r = 0; r < data.length; r += 1) {
    const row = create(document, "tr");
    if (r < headerRows) {
      const trPr = create(document, "trPr");
      trPr.appendChild(create(document, "tblHeader"));
      row.appendChild(trPr);
    }
    for (let c = 0; c < data[r].length; c += 1) {
      const cell = create(document, "tc");
      const cellProps = create(document, "tcPr");
      const cellWidth = create(document, "tcW");
      cellWidth.setAttribute("w:type", "dxa");
      cellWidth.setAttribute("w:w", String(widths[c]));
      cellProps.appendChild(cellWidth);
      cell.appendChild(cellProps);
      const p = create(document, "p");
      const alignment = sheet.getCell(r + 1, c + 1).alignment?.horizontal;
      if (alignment && ["left", "center", "right"].includes(alignment)) {
        const pPr = create(document, "pPr");
        const jc = create(document, "jc");
        jc.setAttribute("w:val", alignment);
        pPr.appendChild(jc);
        p.appendChild(pPr);
      }
      appendText(document, p, data[r][c], r < headerRows);
      cell.appendChild(p);
      row.appendChild(cell);
    }
    table.appendChild(row);
  }
  body.insertBefore(table, section);
  const zip = new JSZip();
  const types = `<?xml version="1.0"?><Types xmlns="${CT_NS}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;
  const rels = `<?xml version="1.0"?><Relationships xmlns="${REL_NS}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  const styles = `<?xml version="1.0"?><w:styles xmlns:w="${W_NS}"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`;
  zip.file("[Content_Types].xml", types, { binary: true, createFolders: false });
  zip.file("_rels/.rels", rels, { binary: true, createFolders: false });
  zip.file("word/document.xml", xmlBytes(document), { binary: true, createFolders: false });
  zip.file("word/styles.xml", styles, { binary: true, createFolders: false });
  await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
  await fs.writeFile(
    output,
    await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
  );
  console.log(
    `[OK] Wrote ${output} (rows=${rows}, cols=${cols}, sheet='${String(sheet.name).replaceAll("'", "\\'")}')`,
  );
}
main().catch((error) => {
  console.error(`[ERROR] ${error.message}`);
  process.exitCode = 2;
});
