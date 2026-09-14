/**
 * Read-only parsers for the OOXML formats previewed in-app (`.docx`, `.xlsx`).
 *
 * Both formats are a ZIP of XML, so these read them with JSZip plus the
 * browser's native `DOMParser`. That avoids pulling a JavaScript XML parser
 * into the renderer to parse plugin-generated files, and it yields plain data
 * that the preview renders as React nodes rather than injected HTML.
 *
 * Only what a preview needs is extracted: text, heading level, bold/italic,
 * tables and cell values. Styling, images, charts and formulas are ignored.
 */
import JSZip from "jszip";

const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const SHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_RELS_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** Excel's epoch is 1899-12-30 because it treats 1900 as a leap year. */
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;
/** Built-in numFmtId values that render as a date or a time. */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

export interface DocxTextSpan {
  text: string;
  bold: boolean;
  italic: boolean;
}

export type DocxBlock =
  | { kind: "paragraph"; headingLevel: number | null; spans: DocxTextSpan[] }
  | { kind: "table"; rows: DocxTextSpan[][][] };

export interface XlsxSheet {
  name: string;
  rows: string[][];
}

/**
 * Extracts the previewable blocks from a `.docx` archive.
 *
 * @param data the raw document bytes.
 * @returns the body blocks in document order.
 */
export async function readDocxBlocks(data: ArrayBuffer | Blob): Promise<DocxBlock[]> {
  const zip = await JSZip.loadAsync(data);
  const documentXml = await zip.file("word/document.xml")?.async("string");
  if (!documentXml) throw new Error("Not a Word document: word/document.xml is missing");
  const body = descendants(parseXml(documentXml), WORD_NS, "body")[0];
  if (!body) return [];

  const blocks: DocxBlock[] = [];
  for (const node of Array.from(body.childNodes)) {
    if (node.nodeType !== 1) continue;
    const element = node as Element;
    if (element.namespaceURI !== WORD_NS) continue;
    if (element.localName === "p") {
      const spans = readDocxParagraphSpans(element);
      blocks.push({ kind: "paragraph", headingLevel: readDocxHeadingLevel(element), spans });
      continue;
    }
    if (element.localName === "tbl") {
      // Direct children only, so a nested table's rows are not hoisted into the outer table.
      const rows = directChildren(element, WORD_NS, "tr").map((row) => (
        directChildren(row, WORD_NS, "tc").map((cell) => (
          directChildren(cell, WORD_NS, "p").flatMap((paragraph) => readDocxParagraphSpans(paragraph))
        ))
      ));
      if (rows.length) blocks.push({ kind: "table", rows });
    }
  }
  return blocks;
}

/**
 * Extracts every worksheet's cell values from an `.xlsx` archive.
 *
 * @param data the raw workbook bytes.
 * @returns one entry per worksheet, in workbook order.
 */
export async function readXlsxSheets(data: ArrayBuffer | Blob): Promise<XlsxSheet[]> {
  const zip = await JSZip.loadAsync(data);
  const workbookXml = await zip.file("xl/workbook.xml")?.async("string");
  if (!workbookXml) throw new Error("Not an Excel workbook: xl/workbook.xml is missing");

  const sharedStrings = await readSharedStrings(zip);
  const dateStyles = await readDateCellStyles(zip);
  const targetsByRelId = await readWorkbookRelationships(zip);

  const sheets: XlsxSheet[] = [];
  for (const sheet of descendants(parseXml(workbookXml), SHEET_NS, "sheet")) {
    const relId = namespacedAttribute(sheet, OFFICE_RELS_NS, "id", "r");
    const target = relId ? targetsByRelId.get(relId) : undefined;
    const sheetXml = target ? await zip.file(target)?.async("string") : undefined;
    if (!sheetXml) continue;
    sheets.push({
      name: sheet.getAttribute("name") ?? `Sheet${sheets.length + 1}`,
      rows: readSheetRows(parseXml(sheetXml), sharedStrings, dateStyles)
    });
  }
  return sheets;
}

/** Renders the runs of one `w:p` into styled spans, keeping tabs and line breaks. */
function readDocxParagraphSpans(paragraph: Element): DocxTextSpan[] {
  const spans: DocxTextSpan[] = [];
  // Descendants, not direct children: runs also live inside `w:hyperlink` and revision marks.
  for (const run of descendants(paragraph, WORD_NS, "r")) {
    const properties = directChildren(run, WORD_NS, "rPr")[0];
    const bold = Boolean(properties && isToggleOn(directChildren(properties, WORD_NS, "b")[0]));
    const italic = Boolean(properties && isToggleOn(directChildren(properties, WORD_NS, "i")[0]));
    let text = "";
    for (const node of Array.from(run.childNodes)) {
      if (node.nodeType !== 1) continue;
      const element = node as Element;
      if (element.namespaceURI !== WORD_NS) continue;
      if (element.localName === "t") text += element.textContent ?? "";
      else if (element.localName === "tab") text += "\t";
      else if (element.localName === "br" || element.localName === "cr") text += "\n";
    }
    if (text) spans.push({ text, bold, italic });
  }
  return spans;
}

/**
 * Reads the outline level of a paragraph style.
 *
 * @param paragraph the `w:p` element.
 * @returns the heading level 1-6; returns null for body text.
 */
function readDocxHeadingLevel(paragraph: Element): number | null {
  const properties = directChildren(paragraph, WORD_NS, "pPr")[0];
  const style = properties && directChildren(properties, WORD_NS, "pStyle")[0];
  const value = style ? namespacedAttribute(style, WORD_NS, "val", "w") : null;
  if (!value) return null;
  const match = /^heading\s*(\d+)$/i.exec(value.trim());
  if (!match) return /^title$/i.test(value.trim()) ? 1 : null;
  return Math.min(6, Math.max(1, Number(match[1])));
}

/**
 * Resolves an OOXML toggle property.
 *
 * A present element means on unless it carries `w:val="0"` or `"false"`.
 *
 * @param element the toggle element, when present.
 * @returns whether the property is enabled.
 */
function isToggleOn(element: Element | undefined): boolean {
  if (!element) return false;
  const value = namespacedAttribute(element, WORD_NS, "val", "w");
  return value === null || !(value === "0" || value.toLowerCase() === "false" || value.toLowerCase() === "off");
}

/** Reads the workbook's shared string table, which holds most text cells. */
async function readSharedStrings(zip: JSZip): Promise<string[]> {
  const xml = await zip.file("xl/sharedStrings.xml")?.async("string");
  if (!xml) return [];
  return descendants(parseXml(xml), SHEET_NS, "si").map((entry) => (
    // Rich-text entries split their text across several `t` elements.
    descendants(entry, SHEET_NS, "t").map((part) => part.textContent ?? "").join("")
  ));
}

/** Maps workbook relationship ids to the zip path of each worksheet part. */
async function readWorkbookRelationships(zip: JSZip): Promise<Map<string, string>> {
  const xml = await zip.file("xl/_rels/workbook.xml.rels")?.async("string");
  const targets = new Map<string, string>();
  if (!xml) return targets;
  for (const relationship of descendants(parseXml(xml), RELS_NS, "Relationship")) {
    const id = relationship.getAttribute("Id");
    const target = relationship.getAttribute("Target");
    if (!id || !target) continue;
    targets.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`);
  }
  return targets;
}

/**
 * Collects the cell-format indexes that represent dates.
 *
 * Dates are stored as day serials, so without this a date cell previews as a
 * bare number like `45000`.
 *
 * @param zip the opened workbook archive.
 * @returns the `cellXfs` indexes whose number format is a date or time.
 */
async function readDateCellStyles(zip: JSZip): Promise<Set<number>> {
  const xml = await zip.file("xl/styles.xml")?.async("string");
  const dateStyles = new Set<number>();
  if (!xml) return dateStyles;
  const document = parseXml(xml);

  const dateCustomFormats = new Set<number>();
  for (const format of descendants(document, SHEET_NS, "numFmt")) {
    const id = Number(format.getAttribute("numFmtId"));
    const code = format.getAttribute("formatCode") ?? "";
    // Strip quoted literals and colour tags so their letters are not mistaken for date tokens.
    if (Number.isInteger(id) && /[dy]|m{2,}/.test(code.replace(/"[^"]*"|\[[^\]]*\]/g, ""))) {
      dateCustomFormats.add(id);
    }
  }

  const cellXfs = descendants(document, SHEET_NS, "cellXfs")[0];
  for (const [index, xf] of directChildren(cellXfs ?? null, SHEET_NS, "xf").entries()) {
    const numFmtId = Number(xf.getAttribute("numFmtId"));
    if (BUILTIN_DATE_FORMATS.has(numFmtId) || dateCustomFormats.has(numFmtId)) dateStyles.add(index);
  }
  return dateStyles;
}

/**
 * Reads a worksheet into a dense grid of display strings.
 *
 * Rows and cells are sparse in OOXML, so each is placed at the index implied by
 * its reference to keep columns aligned.
 *
 * @param document the parsed worksheet XML.
 * @param sharedStrings the workbook shared string table.
 * @param dateStyles the cell-format indexes that render as dates.
 * @returns the grid, trimmed of trailing blank rows.
 */
function readSheetRows(document: Document, sharedStrings: readonly string[], dateStyles: ReadonlySet<number>): string[][] {
  const grid: string[][] = [];
  let width = 0;

  for (const row of descendants(document, SHEET_NS, "row")) {
    const declaredIndex = Number(row.getAttribute("r"));
    const rowIndex = Number.isInteger(declaredIndex) && declaredIndex > 0 ? declaredIndex - 1 : grid.length;
    const cells: string[] = [];
    for (const [position, cell] of directChildren(row, SHEET_NS, "c").entries()) {
      const columnIndex = columnIndexFromReference(cell.getAttribute("r")) ?? position;
      cells[columnIndex] = readCellText(cell, sharedStrings, dateStyles);
    }
    width = Math.max(width, cells.length);
    grid[rowIndex] = cells;
  }

  let lastUsedRow = -1;
  for (const [index, cells] of grid.entries()) {
    if (cells?.some((value) => value)) lastUsedRow = index;
  }
  return grid.slice(0, lastUsedRow + 1).map((cells) => (
    Array.from({ length: width }, (_value, index) => cells?.[index] ?? "")
  ));
}

/**
 * Resolves one cell's display text.
 *
 * @param cell the `c` element.
 * @param sharedStrings the workbook shared string table.
 * @param dateStyles the cell-format indexes that render as dates.
 * @returns the display text; empty when the cell holds no value.
 */
function readCellText(cell: Element, sharedStrings: readonly string[], dateStyles: ReadonlySet<number>): string {
  const type = cell.getAttribute("t");
  if (type === "inlineStr") {
    const inline = directChildren(cell, SHEET_NS, "is")[0];
    return descendants(inline ?? null, SHEET_NS, "t").map((part) => part.textContent ?? "").join("");
  }

  // A formula cell carries its last computed value in `v`, which is what a preview should show.
  const raw = directChildren(cell, SHEET_NS, "v")[0]?.textContent ?? "";
  if (!raw) return "";
  if (type === "s") return sharedStrings[Number(raw)] ?? "";
  if (type === "str") return raw;
  if (type === "b") return raw === "1" ? "TRUE" : "FALSE";
  if (type === "e") return raw;

  const styleIndex = Number(cell.getAttribute("s"));
  if (Number.isInteger(styleIndex) && dateStyles.has(styleIndex)) {
    const serial = Number(raw);
    if (Number.isFinite(serial)) return formatExcelSerialDate(serial);
  }
  return raw;
}

/**
 * Converts an Excel day serial into a readable timestamp.
 *
 * @param serial the day serial, whose fraction is the time of day.
 * @returns an ISO-like date, with the time appended only when the cell carries one.
 */
function formatExcelSerialDate(serial: number): string {
  const date = new Date(EXCEL_EPOCH_MS + Math.round(serial * MS_PER_DAY));
  if (Number.isNaN(date.getTime())) return String(serial);
  const day = date.toISOString().slice(0, 10);
  const hasTime = Math.abs(serial % 1) > 1e-9;
  return hasTime ? `${day} ${date.toISOString().slice(11, 19)}` : day;
}

/**
 * Converts a cell reference such as `AB12` into a zero-based column index.
 *
 * @param reference the cell reference attribute.
 * @returns the column index; returns null when the reference is absent or malformed.
 */
function columnIndexFromReference(reference: string | null): number | null {
  const letters = /^([A-Z]+)/.exec(reference?.toUpperCase() ?? "")?.[1];
  if (!letters) return null;
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

/** Selects immediate children by namespace and local name, ignoring nested matches. */
function directChildren(parent: Element | null, namespace: string, localName: string): Element[] {
  if (!parent) return [];
  return Array.from(parent.childNodes).filter((node): node is Element => (
    node.nodeType === 1
    && (node as Element).namespaceURI === namespace
    && (node as Element).localName === localName
  ));
}

/**
 * Selects descendants by namespace and local name.
 *
 * This walks the tree rather than calling `getElementsByTagNameNS`, which is
 * unimplemented in the DOM used by the test environment.
 *
 * @param root the subtree root, which is itself never returned.
 * @param namespace the required namespace URI.
 * @param localName the required local name.
 * @returns the matching descendants in document order.
 */
function descendants(root: Element | Document | null, namespace: string, localName: string): Element[] {
  if (!root) return [];
  const matches: Element[] = [];
  const visit = (parent: Element | Document) => {
    for (const node of Array.from(parent.childNodes)) {
      if (node.nodeType !== 1) continue;
      const element = node as Element;
      if (element.namespaceURI === namespace && element.localName === localName) matches.push(element);
      visit(element);
    }
  };
  visit(root);
  return matches;
}

/**
 * Reads a namespaced attribute.
 *
 * The qualified-name fallback covers DOM implementations that do not resolve
 * `getAttributeNS` on a parsed document.
 *
 * @param element the owning element.
 * @param namespace the attribute namespace URI.
 * @param localName the attribute local name.
 * @param prefix the namespace prefix used by the OOXML part.
 * @returns the attribute value; returns null when absent.
 */
function namespacedAttribute(element: Element, namespace: string, localName: string, prefix: string): string | null {
  return element.getAttributeNS(namespace, localName) ?? element.getAttribute(`${prefix}:${localName}`);
}

/**
 * Parses an OOXML part with the browser's native XML parser.
 *
 * @param xml the part contents.
 * @returns the parsed document.
 */
function parseXml(xml: string): Document {
  const document = new DOMParser().parseFromString(xml, "application/xml");
  if (document.getElementsByTagName("parsererror").length) {
    throw new Error("Malformed Office XML");
  }
  return document;
}
