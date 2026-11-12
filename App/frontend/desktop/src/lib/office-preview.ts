/**
 * Read-only parsers for the OOXML formats previewed in-app (`.docx`, `.xlsx`).
 *
 * Both formats are a ZIP of XML, so these read them with JSZip plus the
 * browser's native `DOMParser`. That avoids pulling a JavaScript XML parser
 * into the renderer to parse plugin-generated files, and it yields plain data
 * that the preview renders as React nodes rather than injected HTML.
 *
 * Only what a preview needs is extracted: text, heading level, bold/italic,
 * paragraph indent, spacing and alignment, tables (including merged cells and
 * column widths), embedded images, and drawing canvases (positioned boxes,
 * arrows and connectors). Charts and formulas are ignored.
 */
import JSZip from "jszip";
import { readXlsxLayout, readXlsxStyles, XLSX_MAX_COLUMNS, XLSX_MAX_ROWS, type XlsxLayout } from "./xlsx-layout.js";

const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const SHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_RELS_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const VML_NS = "urn:schemas-microsoft-com:vml";
const OFFICE_VML_NS = "urn:schemas-microsoft-com:office:office";
/** English Metric Units per point. Drawing extents are stored in EMUs. */
const EMU_PER_PT = 12_700;
const DRAWING_ANCESTORS = new Set(["drawing", "pict", "txbxContent", "textbox"]);

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

export interface DocxTableCell {
  content: DocxBlock[];
  colSpan: number;
  rowSpan: number;
}

/** Paragraph box metrics taken from `w:pPr` and the document styles. Lengths are twips unless noted. */
export interface DocxParagraphFormat {
  align?: "left" | "center" | "right" | "justify";
  /** Left indent. */
  indentLeft?: number;
  /** Right indent. */
  indentRight?: number;
  /** Left indent in hundredths of a character. Used instead of `indentLeft` when set. */
  indentLeftChars?: number;
  /** Right indent in hundredths of a character. Used instead of `indentRight` when set. */
  indentRightChars?: number;
  /** First-line indent. Negative when the paragraph uses a hanging indent. */
  firstLine?: number;
  /** First-line indent in hundredths of a character. Negative when hanging. Used instead of `firstLine` when set. */
  firstLineChars?: number;
  /** Space before the paragraph. */
  before?: number;
  /** Space after the paragraph. */
  after?: number;
  /** Space before, in hundredths of a line. Used instead of `before` when set. */
  beforeLines?: number;
  /** Space after, in hundredths of a line. Used instead of `after` when set. */
  afterLines?: number;
  /**
   * Line spacing. With `lineRule: "auto"` this is in 240ths of a line
   * (240 is single spacing). Otherwise it is twips.
   */
  line?: number;
  lineRule?: "auto" | "exact" | "atLeast";
}

/** One shape on a drawing canvas. Positions are percentages of that canvas. */
export interface DocxDrawingShape {
  left: number;
  top: number;
  width: number;
  height: number;
  role: "box" | "round" | "diamond" | "label" | "arrow-h" | "arrow-v" | "line" | "elbow";
  text: string;
  startArrow: boolean;
  endArrow: boolean;
  flipX: boolean;
  flipY: boolean;
  /** Clockwise degrees. */
  rotation: number;
  /** Bend position of an elbow connector, as a fraction of its box. */
  adj: number;
}

export type DocxBlock =
  | { kind: "paragraph"; headingLevel: number | null; spans: DocxTextSpan[]; format?: DocxParagraphFormat }
  | { kind: "table"; columnWidths: number[]; rows: DocxTableCell[][] }
  | { kind: "image"; src: string; widthPt: number; heightPt: number }
  | { kind: "drawing"; widthPt: number; heightPt: number; shapes: DocxDrawingShape[] };

export interface XlsxSheet {
  name: string;
  rows: string[][];
  layout?: XlsxLayout;
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
  const styles = await readDocxStyles(zip);
  const images = await readDocxImages(zip);
  return body ? readDocxFlow(body, styles, images) : [];
}

interface DocxStyleDefinition {
  basedOn: string | null;
  format: DocxParagraphFormat;
}

interface DocxStyleSheet {
  defaults: DocxParagraphFormat;
  styles: Map<string, DocxStyleDefinition>;
}

/** Reads paragraphs and tables, descending into content controls and revisions. */
function readDocxFlow(container: Element, styles: DocxStyleSheet, images: ReadonlyMap<string, string>): DocxBlock[] {
  const blocks: DocxBlock[] = [];
  for (const element of wordChildren(container)) {
    if (element.localName === "p") {
      blocks.push(...readDocxParagraph(element, styles, images));
    } else if (element.localName === "tbl") {
      const table = readDocxTable(element, styles, images);
      if (table.rows.length) blocks.push(table);
    } else if (element.localName === "sdt") {
      const content = directChildren(element, WORD_NS, "sdtContent")[0];
      if (content) blocks.push(...readDocxFlow(content, styles, images));
    } else if (element.localName === "ins" || element.localName === "moveTo") {
      blocks.push(...readDocxFlow(element, styles, images));
    }
  }
  return blocks;
}

function readDocxTable(table: Element, styles: DocxStyleSheet, images: ReadonlyMap<string, string>): Extract<DocxBlock, { kind: "table" }> {
  const grid = directChildren(table, WORD_NS, "tblGrid")[0];
  const columnWidths = directChildren(grid ?? null, WORD_NS, "gridCol").map((column) => {
    const width = Number(namespacedAttribute(column, WORD_NS, "w", "w"));
    return Number.isFinite(width) && width > 0 ? width : 0;
  });
  const rows = directChildren(table, WORD_NS, "tr").map((row) => (
    directChildren(row, WORD_NS, "tc").map((cell) => readDocxCell(cell, styles, images))
  ));
  collapseVerticalMerges(rows);
  return { kind: "table", columnWidths, rows };
}

interface DocxTableCellDraft extends DocxTableCell {
  verticalMerge?: "restart" | "continue";
}

function readDocxCell(cell: Element, styles: DocxStyleSheet, images: ReadonlyMap<string, string>): DocxTableCellDraft {
  const properties = directChildren(cell, WORD_NS, "tcPr")[0];
  const spanElement = directChildren(properties ?? null, WORD_NS, "gridSpan")[0];
  const spanValue = spanElement ? Number(namespacedAttribute(spanElement, WORD_NS, "val", "w")) : Number.NaN;
  const mergeElement = directChildren(properties ?? null, WORD_NS, "vMerge")[0];
  const mergeValue = mergeElement ? (namespacedAttribute(mergeElement, WORD_NS, "val", "w") ?? "continue") : null;
  return {
    content: readDocxFlow(cell, styles, images),
    colSpan: Number.isInteger(spanValue) && spanValue > 1 ? spanValue : 1,
    rowSpan: 1,
    ...(mergeValue === "restart" || mergeValue === "continue" ? { verticalMerge: mergeValue } : {})
  };
}

/** Folds `w:vMerge` continuations into the `rowSpan` of the cell that started the merge. */
function collapseVerticalMerges(rows: DocxTableCellDraft[][]): void {
  const open: Array<DocxTableCellDraft | null> = [];
  for (const row of rows) {
    let column = 0;
    const kept: DocxTableCellDraft[] = [];
    for (const cell of row) {
      const merge = cell.verticalMerge;
      delete cell.verticalMerge;
      if (merge === "continue" && open[column]) {
        open[column]!.rowSpan += 1;
        column += cell.colSpan;
        continue;
      }
      for (let offset = 0; offset < cell.colSpan; offset += 1) {
        open[column + offset] = merge === "restart" ? cell : null;
      }
      kept.push(cell);
      column += cell.colSpan;
    }
    row.splice(0, row.length, ...kept);
  }
}

/** Direct children in the WordprocessingML namespace, whatever their local name. */
function wordChildren(parent: Element): Element[] {
  return Array.from(parent.childNodes).filter((node): node is Element => (
    node.nodeType === 1 && (node as Element).namespaceURI === WORD_NS
  ));
}

const EMPTY_DOCX_STYLES: DocxStyleSheet = { defaults: {}, styles: new Map() };

/** Loads document defaults and paragraph styles, including `w:basedOn` links. */
async function readDocxStyles(zip: JSZip): Promise<DocxStyleSheet> {
  const xml = await zip.file("word/styles.xml")?.async("string");
  if (!xml) return EMPTY_DOCX_STYLES;
  const document = parseXml(xml);
  const defaults = directChildren(
    directChildren(descendants(document, WORD_NS, "docDefaults")[0] ?? null, WORD_NS, "pPrDefault")[0] ?? null,
    WORD_NS,
    "pPr"
  )[0];
  const styles = new Map<string, DocxStyleDefinition>();
  for (const style of descendants(document, WORD_NS, "style")) {
    const styleId = namespacedAttribute(style, WORD_NS, "styleId", "w");
    if (!styleId) continue;
    const basedOnElement = directChildren(style, WORD_NS, "basedOn")[0];
    styles.set(styleId, {
      basedOn: basedOnElement ? namespacedAttribute(basedOnElement, WORD_NS, "val", "w") : null,
      format: readDocxParagraphProperties(directChildren(style, WORD_NS, "pPr")[0])
    });
  }
  return {
    defaults: readDocxParagraphProperties(defaults),
    styles
  };
}

/**
 * Merges document defaults, the paragraph style chain, and direct `w:pPr`.
 *
 * @returns the properties the paragraph actually sets; returns undefined when nothing is set.
 */
function resolveDocxParagraphFormat(paragraph: Element, styles: DocxStyleSheet): DocxParagraphFormat | undefined {
  const properties = directChildren(paragraph, WORD_NS, "pPr")[0];
  const styleElement = directChildren(properties ?? null, WORD_NS, "pStyle")[0];
  const styleId = styleElement ? namespacedAttribute(styleElement, WORD_NS, "val", "w") : null;
  const chain: DocxParagraphFormat[] = [];
  const seen = new Set<string>();
  let current = styleId;
  while (current && !seen.has(current)) {
    seen.add(current);
    const style = styles.styles.get(current);
    if (!style) break;
    chain.push(style.format);
    current = style.basedOn;
  }
  const format: DocxParagraphFormat = {
    ...styles.defaults,
    ...chain.reverse().reduce<DocxParagraphFormat>((merged, item) => ({ ...merged, ...item }), {}),
    ...readDocxParagraphProperties(properties)
  };
  return Object.keys(format).length ? format : undefined;
}

/** Reads indent, spacing and alignment from one `w:pPr`. Absent attributes are left unset so a style can inherit them. */
function readDocxParagraphProperties(properties: Element | undefined): DocxParagraphFormat {
  if (!properties) return {};
  const format: DocxParagraphFormat = {};
  const indent = directChildren(properties, WORD_NS, "ind")[0];
  const spacing = directChildren(properties, WORD_NS, "spacing")[0];
  const justification = directChildren(properties, WORD_NS, "jc")[0];
  const alignment = justification
    ? readDocxAlignment(namespacedAttribute(justification, WORD_NS, "val", "w"))
    : null;
  if (alignment) format.align = alignment;
  assignLength(format, "indentLeft", readOptionalTwip(indent, "left") ?? readOptionalTwip(indent, "start"));
  assignLength(format, "indentRight", readOptionalTwip(indent, "right") ?? readOptionalTwip(indent, "end"));
  assignLength(format, "indentLeftChars", readOptionalTwip(indent, "leftChars") ?? readOptionalTwip(indent, "startChars"));
  assignLength(format, "indentRightChars", readOptionalTwip(indent, "rightChars") ?? readOptionalTwip(indent, "endChars"));
  const firstLine = readOptionalTwip(indent, "firstLine");
  const hanging = readOptionalTwip(indent, "hanging");
  assignLength(format, "firstLine", firstLine ?? (hanging == null ? null : -hanging));
  const firstLineChars = readOptionalTwip(indent, "firstLineChars");
  const hangingChars = readOptionalTwip(indent, "hangingChars");
  assignLength(format, "firstLineChars", firstLineChars ?? (hangingChars == null ? null : -hangingChars));
  assignLength(format, "before", readOptionalTwip(spacing, "before"));
  assignLength(format, "after", readOptionalTwip(spacing, "after"));
  assignLength(format, "beforeLines", readOptionalTwip(spacing, "beforeLines"));
  assignLength(format, "afterLines", readOptionalTwip(spacing, "afterLines"));
  assignLength(format, "line", readOptionalTwip(spacing, "line"));
  const lineRule = spacing ? namespacedAttribute(spacing, WORD_NS, "lineRule", "w") : null;
  if (lineRule === "auto" || lineRule === "exact" || lineRule === "atLeast") format.lineRule = lineRule;
  return format;
}

/**
 * Converts a Word line-spacing value into a CSS line-height that cannot collapse lines.
 *
 * `auto` values are 240ths of a line. A value such as 14 is not a usable multiple:
 * applying it as `14/240` paints every following line on top of the previous one.
 * Exact spacing tighter than the text is raised to at least one line.
 *
 * @param line the `w:line` value.
 * @param lineRule the `w:lineRule` value.
 * @returns a CSS line-height, or undefined when the document does not set one.
 */
export function docxLineHeightCss(line: number, lineRule: DocxParagraphFormat["lineRule"]): number | string | undefined {
  if (!(line > 0)) return undefined;
  if (!lineRule || lineRule === "auto") return Math.max(line / 240, 1);
  return `max(${line / 20}pt, 1.15em)`;
}

function assignLength(
  target: DocxParagraphFormat,
  key: "indentLeft" | "indentRight" | "indentLeftChars" | "indentRightChars" | "firstLine" | "firstLineChars" | "before" | "after" | "beforeLines" | "afterLines" | "line",
  value: number | null
): void {
  if (value != null) target[key] = value;
}

function readDocxAlignment(value: string | null): DocxParagraphFormat["align"] | null {
  if (value === "center") return "center";
  if (value === "right" || value === "end") return "right";
  if (value === "both" || value === "distribute" || value === "thaiDistribute") return "justify";
  if (value === "left" || value === "start") return "left";
  return null;
}

function readOptionalTwip(element: Element | undefined, localName: string): number | null {
  if (!element) return null;
  const raw = namespacedAttribute(element, WORD_NS, localName, "w");
  if (raw == null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
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
  const styles = await readXlsxStyles(zip);
  const targetsByRelId = await readWorkbookRelationships(zip);

  const sheets: XlsxSheet[] = [];
  for (const sheet of descendants(parseXml(workbookXml), SHEET_NS, "sheet")) {
    const relId = namespacedAttribute(sheet, OFFICE_RELS_NS, "id", "r");
    const target = relId ? targetsByRelId.get(relId) : undefined;
    const sheetXml = target ? await zip.file(target)?.async("string") : undefined;
    if (!sheetXml) continue;
    const document = parseXml(sheetXml);
    sheets.push({
      name: sheet.getAttribute("name") ?? `Sheet${sheets.length + 1}`,
      rows: readSheetRows(document, sharedStrings, dateStyles),
      layout: readXlsxLayout(document, styles)
    });
  }
  return sheets;
}

/**
 * Reads one paragraph, keeping drawings in place and leaving their text out of the prose.
 *
 * A diagram is stored twice: once as DrawingML and once as a VML fallback. The fallback
 * carries the box positions, so that is the copy the preview draws.
 */
function readDocxParagraph(paragraph: Element, styles: DocxStyleSheet, images: ReadonlyMap<string, string>): DocxBlock[] {
  const format = resolveDocxParagraphFormat(paragraph, styles);
  const headingLevel = readDocxHeadingLevel(paragraph);
  const blocks: DocxBlock[] = [];
  const spans: DocxTextSpan[] = [];
  let usedHeading = false;
  const flush = () => {
    if (!spans.length) return;
    blocks.push({
      kind: "paragraph",
      headingLevel: usedHeading ? null : headingLevel,
      spans: spans.splice(0, spans.length),
      ...(format ? { format } : {})
    });
    usedHeading = true;
  };
  for (const run of descendants(paragraph, WORD_NS, "r")) {
    if (runIsInsideDrawing(run, paragraph)) continue;
    const figures = readDocxRunFigures(run, images);
    if (figures.length) {
      flush();
      blocks.push(...figures);
      continue;
    }
    spans.push(...readDocxRunSpans(run));
  }
  flush();
  if (blocks.length) return blocks;
  return [{
    kind: "paragraph",
    headingLevel,
    spans: [],
    ...(format ? { format } : {})
  }];
}

/** A run inside a text box belongs to the diagram, not to the paragraph around it. */
function runIsInsideDrawing(run: Element, paragraph: Element): boolean {
  let parent = run.parentElement;
  while (parent && parent !== paragraph) {
    if (DRAWING_ANCESTORS.has(parent.localName ?? "")) return true;
    parent = parent.parentElement;
  }
  return false;
}

function readDocxRunSpans(run: Element): DocxTextSpan[] {
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
  return text ? [{ text, bold, italic }] : [];
}

function readDocxRunFigures(run: Element, images: ReadonlyMap<string, string>): DocxBlock[] {
  const alternates = elementsNamed(run, "AlternateContent");
  if (alternates.length) {
    const blocks: DocxBlock[] = [];
    for (const alternate of alternates) {
      const fallback = elementsNamed(alternate, "Fallback")[0];
      const groups = fallback ? topVmlGroups(fallback) : [];
      if (groups.length) {
        for (const group of groups) {
          const drawing = readVmlGroup(group);
          if (drawing) blocks.push(drawing);
        }
      } else {
        const choice = elementsNamed(alternate, "Choice")[0];
        blocks.push(...readDocxBlips(choice ?? alternate, images));
      }
    }
    return blocks;
  }
  const blocks: DocxBlock[] = [];
  for (const group of topVmlGroups(run)) {
    const drawing = readVmlGroup(group);
    if (drawing) blocks.push(drawing);
  }
  blocks.push(...readDocxBlips(run, images));
  return blocks;
}

/** Resolves `r:embed` images to data URLs. Vector-only parts such as EMF are skipped. */
async function readDocxImages(zip: JSZip): Promise<Map<string, string>> {
  const xml = await zip.file("word/_rels/document.xml.rels")?.async("string");
  const images = new Map<string, string>();
  if (!xml) return images;
  for (const relationship of descendants(parseXml(xml), RELS_NS, "Relationship")) {
    const id = relationship.getAttribute("Id");
    const type = relationship.getAttribute("Type") ?? "";
    const target = relationship.getAttribute("Target");
    if (!id || !target || !type.endsWith("/image")) continue;
    const mime = imageMime(target);
    if (!mime) continue;
    const path = target.startsWith("/") ? target.slice(1) : `word/${target.replace(/^\.\//, "")}`;
    const base64 = await zip.file(decodeXmlPath(path))?.async("base64");
    if (!base64) continue;
    images.set(id, `data:${mime};base64,${base64}`);
  }
  return images;
}

function imageMime(path: string): string | null {
  const extension = path.split(".").pop()?.toLowerCase();
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "gif") return "image/gif";
  if (extension === "webp") return "image/webp";
  if (extension === "bmp") return "image/bmp";
  return null;
}

function decodeXmlPath(path: string): string {
  return path.replace(/&amp;/g, "&");
}

function readDocxBlips(root: Element, images: ReadonlyMap<string, string>): DocxBlock[] {
  const blocks: DocxBlock[] = [];
  for (const blip of elementsNamed(root, "blip")) {
    const id = namespacedAttribute(blip, OFFICE_RELS_NS, "embed", "r");
    const src = id ? images.get(id) : undefined;
    if (!src) continue;
    const extent = nearestExtent(blip);
    const widthPt = extent ? Number(extent.getAttribute("cx")) / EMU_PER_PT : 0;
    const heightPt = extent ? Number(extent.getAttribute("cy")) / EMU_PER_PT : 0;
    blocks.push({
      kind: "image",
      src,
      widthPt: widthPt > 0 ? widthPt : 360,
      heightPt: heightPt > 0 ? heightPt : 240
    });
  }
  return blocks;
}

/** The display size lives on the wrapping `wp:extent`, not on the blip itself. */
function nearestExtent(blip: Element): Element | null {
  let parent = blip.parentElement;
  while (parent) {
    if (parent.localName === "inline" || parent.localName === "anchor") {
      const extent = Array.from(parent.childNodes).find((node): node is Element => (
        node.nodeType === 1 && (node as Element).localName === "extent"
      ));
      if (extent) return extent;
    }
    parent = parent.parentElement;
  }
  return null;
}

function readVmlGroup(group: Element): Extract<DocxBlock, { kind: "drawing" }> | null {
  const style = parseVmlStyle(group.getAttribute("style"));
  const widthPt = parseFloat(style.width ?? "");
  const heightPt = parseFloat(style.height ?? "");
  const coord = parseCoordSize(group.getAttribute("coordsize"));
  if (!(widthPt > 0) || !(heightPt > 0) || !coord) return null;
  const shapes: DocxDrawingShape[] = [];
  collectVmlShapes(group, coord.width, coord.height, 0, 0, 1, 1, shapes);
  return shapes.length ? { kind: "drawing", widthPt, heightPt, shapes } : null;
}

function parseCoordSize(raw: string | null): { width: number; height: number } | null {
  const [widthText, heightText] = (raw ?? "").split(",");
  const width = Number((widthText ?? "").trim());
  const height = Number((heightText ?? "").trim());
  if (!(width > 0) || !(height > 0)) return null;
  return { width, height };
}

/**
 * Flattens a VML group, including a group nested inside it, into one canvas.
 *
 * `ox`/`oy`/`sx`/`sy` are the current group's rectangle as fractions of that canvas.
 */
function collectVmlShapes(
  group: Element,
  coordW: number,
  coordH: number,
  ox: number,
  oy: number,
  sx: number,
  sy: number,
  shapes: DocxDrawingShape[]
): void {
  for (const child of Array.from(group.childNodes)) {
    if (child.nodeType !== 1) continue;
    const element = child as Element;
    if (element.namespaceURI !== VML_NS) continue;
    const box = vmlBox(element);
    if (!box || !(coordW > 0) || !(coordH > 0)) continue;
    const x = ox + (box.left / coordW) * sx;
    const y = oy + (box.top / coordH) * sy;
    const w = (box.width / coordW) * sx;
    const h = (box.height / coordH) * sy;
    if (element.localName === "group") {
      const childCoord = parseCoordSize(element.getAttribute("coordsize"));
      collectVmlShapes(
        element,
        childCoord?.width ?? box.width,
        childCoord?.height ?? box.height,
        x,
        y,
        w,
        h,
        shapes
      );
      continue;
    }
    const shape = readVmlShape(element, x, y, w, h);
    if (shape) shapes.push(shape);
  }
}

function readVmlShape(element: Element, x: number, y: number, w: number, h: number): DocxDrawingShape | null {
  if (!(w > 0) || !(h > 0)) return null;
  const filled = element.getAttribute("filled") !== "f";
  const stroked = element.getAttribute("stroked") !== "f";
  const text = vmlText(element);
  const spt = namespacedAttribute(element, OFFICE_VML_NS, "spt", "o");
  const role = vmlRole(element.localName ?? "", spt, text, stroked);
  if (!role) return null;
  if (!filled && !stroked && !text) return null;
  if (!text && w > 0.9 && h > 0.9 && x < 0.05 && y < 0.05) return null;
  const style = parseVmlStyle(element.getAttribute("style"));
  const flip = style.flip ?? "";
  const stroke = Array.from(element.childNodes).find((node): node is Element => (
    node.nodeType === 1 && (node as Element).namespaceURI === VML_NS && (node as Element).localName === "stroke"
  ));
  return {
    left: x * 100,
    top: y * 100,
    width: w * 100,
    height: h * 100,
    role,
    text,
    startArrow: isArrow(stroke?.getAttribute("startarrow")),
    endArrow: isArrow(stroke?.getAttribute("endarrow")),
    flipX: flip.split(/\s+/).includes("x"),
    flipY: flip.split(/\s+/).includes("y"),
    rotation: parseVmlRotation(style.rotation),
    adj: parseVmlAdj(element.getAttribute("adj"))
  };
}

function vmlRole(localName: string, spt: string | null, text: string, stroked: boolean): DocxDrawingShape["role"] | null {
  if (localName === "roundrect" || spt === "2") return "round";
  if (spt === "4" || spt === "110") return "diamond";
  if (spt === "69") return "arrow-h";
  if (spt === "70") return "arrow-v";
  if (spt === "32") return "line";
  if (spt === "34" || spt === "35") return "elbow";
  if (localName === "rect" || spt === "1" || spt === "202") return stroked || !text ? "box" : "label";
  if (text) return stroked ? "box" : "label";
  return null;
}

function vmlText(element: Element): string {
  const lines: string[] = [];
  for (const textbox of elementsNamed(element, "textbox")) {
    if (textbox.parentElement !== element) continue;
    for (const paragraph of descendants(textbox, WORD_NS, "p")) {
      const line = descendants(paragraph, WORD_NS, "t").map((part) => part.textContent ?? "").join("");
      if (line) lines.push(line);
    }
  }
  return lines.join("\n");
}

function vmlBox(element: Element): { left: number; top: number; width: number; height: number } | null {
  const style = parseVmlStyle(element.getAttribute("style"));
  const left = Number(style.left ?? "");
  const top = Number(style.top ?? "");
  const width = Number(style.width ?? "");
  const height = Number(style.height ?? "");
  if (![left, top, width, height].every(Number.isFinite)) return null;
  return { left, top, width, height };
}

function parseVmlStyle(style: string | null): Record<string, string> {
  const result: Record<string, string> = {};
  if (!style) return result;
  for (const part of style.split(";")) {
    const index = part.indexOf(":");
    if (index <= 0) continue;
    result[part.slice(0, index).trim().toLowerCase()] = part.slice(index + 1).trim();
  }
  return result;
}

/** A trailing `f` means the angle is in 65536ths of a degree. */
function parseVmlRotation(raw: string | undefined): number {
  if (!raw) return 0;
  const fixed = /fd?$/.test(raw);
  const value = Number(fixed ? raw.replace(/fd?$/, "") : raw);
  if (!Number.isFinite(value)) return 0;
  return fixed ? value / 65536 : value;
}

/** Connector adjustments are in the shape coordinate space, usually 21600 across. */
function parseVmlAdj(raw: string | null): number {
  if (!raw) return 0.5;
  const value = Number(raw.split(",")[0]);
  if (!Number.isFinite(value)) return 0.5;
  return Math.abs(value) > 21600 ? value / 100000 : value / 21600;
}

function isArrow(value: string | null | undefined): boolean {
  return Boolean(value && value !== "none");
}

function topVmlGroups(root: Element): Element[] {
  return elementsNamed(root, "group").filter((group) => {
    if (group.namespaceURI !== VML_NS) return false;
    let parent = group.parentElement;
    while (parent && parent !== root) {
      if (parent.namespaceURI === VML_NS && parent.localName === "group") return false;
      parent = parent.parentElement;
    }
    return true;
  });
}

/** Descendants with this local name in any namespace. */
function elementsNamed(root: Element, localName: string): Element[] {
  const matches: Element[] = [];
  const visit = (parent: Element) => {
    for (const node of Array.from(parent.childNodes)) {
      if (node.nodeType !== 1) continue;
      const element = node as Element;
      if (element.localName === localName) matches.push(element);
      visit(element);
    }
  };
  visit(root);
  return matches;
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
    if (rowIndex >= XLSX_MAX_ROWS) continue;
    const cells: string[] = [];
    for (const [position, cell] of directChildren(row, SHEET_NS, "c").entries()) {
      const columnIndex = columnIndexFromReference(cell.getAttribute("r")) ?? position;
      if (columnIndex >= XLSX_MAX_COLUMNS) continue;
      cells[columnIndex] = readCellText(cell, sharedStrings, dateStyles);
    }
    width = Math.max(width, cells.length);
    grid[rowIndex] = cells;
  }

  let lastUsedRow = -1;
  for (const [index, cells] of grid.entries()) {
    if (cells?.some((value) => value)) lastUsedRow = index;
  }
  // Built by index, so a worksheet that skips row numbers leaves holes behind,
  // and `map` would copy them through: `Array.prototype.map` skips holes rather
  // than filling them. A caller that spreads the result then reads `undefined`
  // where it was promised a row. Rebuilt by index instead, which fills them.
  return Array.from({ length: lastUsedRow + 1 }, (_row, rowIndex) => (
    Array.from({ length: width }, (_value, index) => grid[rowIndex]?.[index] ?? "")
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
