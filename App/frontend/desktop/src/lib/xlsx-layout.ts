import type JSZip from "jszip";

const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
export const XLSX_MAX_COLUMNS = 256;
export const XLSX_MAX_ROWS = 50_000;

export interface XlsxCellStyle {
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: "bold";
  fontStyle?: "italic";
  textDecoration?: string;
  color?: string;
  backgroundColor?: string;
  textAlign?: "left" | "center" | "right" | "justify";
  verticalAlign?: "top" | "middle" | "bottom";
  whiteSpace: "pre" | "pre-wrap";
  borderTop?: string;
  borderRight?: string;
  borderBottom?: string;
  borderLeft?: string;
}

export interface XlsxMerge {
  row: number;
  column: number;
  endRow: number;
  endColumn: number;
}

export interface XlsxLayout {
  columnWidths: number[];
  rowCount: number;
  defaultRowHeight: number;
  rows: Map<number, { height: number; hidden: boolean; style?: number; cells: number[] }>;
  columnStyles: number[];
  merges: XlsxMerge[];
  styles: XlsxCellStyle[];
  truncated: boolean;
}

function children(parent: Element | null | undefined, name: string): Element[] {
  return parent ? Array.from(parent.children).filter((child) => child.namespaceURI === NS && child.localName === name) : [];
}

function number(value: string | null | undefined, fallback: number): number {
  const result = value == null || value === "" ? NaN : Number(value);
  return Number.isFinite(result) && result >= 0 ? result : fallback;
}

function enabled(element: Element | undefined): boolean {
  return !!element && element.getAttribute("val") !== "0" && element.getAttribute("val") !== "false";
}

// Excel's standard indexed palette. Workbooks may replace it with indexedColors.
const PALETTE = (
  "000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF " +
  "000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF " +
  "800000 008000 000080 808000 800080 008080 C0C0C0 808080 " +
  "9999FF 993366 FFFFCC CCFFFF 660066 FF8080 0066CC CCCCFF " +
  "000080 FF00FF FFFF00 00FFFF 800080 800000 008080 0000FF " +
  "00CCFF CCFFFF CCFFCC FFFF99 99CCFF FF99CC CC99FF FFCC99 " +
  "3366FF 33CCCC 99CC00 FFCC00 FF9900 FF6600 666699 969696 " +
  "003366 339966 003300 333300 993300 993366 333399 333333"
).split(" ");

/** Extracts safe CSS values from workbook styles; no workbook HTML is injected. */
export async function readXlsxStyles(zip: JSZip): Promise<XlsxCellStyle[]> {
  const xml = await zip.file("xl/styles.xml")?.async("string");
  if (!xml) return [{ whiteSpace: "pre" }];
  const root = new DOMParser().parseFromString(xml, "application/xml").documentElement;
  const themeXml = await zip.file("xl/theme/theme1.xml")?.async("string");
  const theme: string[] = [];
  if (themeXml) {
    const themeRoot = new DOMParser().parseFromString(themeXml, "application/xml");
    const scheme = Array.from(themeRoot.getElementsByTagName("*")).find((element) => element.localName === "clrScheme");
    for (const name of ["lt1", "dk1", "lt2", "dk2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"]) {
      const color = Array.from(scheme?.children ?? []).find((element) => element.localName === name)?.firstElementChild;
      theme.push(color?.getAttribute("lastClr") ?? color?.getAttribute("val") ?? "000000");
    }
  }
  const customPalette = children(children(root, "colors")[0], "indexedColors")[0];
  const palette = customPalette ? children(customPalette, "rgbColor").map((color) => color.getAttribute("rgb") ?? "000000") : PALETTE;
  const color = (element: Element | undefined): string | undefined => {
    if (!element || element.getAttribute("auto") === "1") return undefined;
    let rgb = element.getAttribute("rgb") ?? palette[number(element.getAttribute("indexed"), -1)] ?? theme[number(element.getAttribute("theme"), -1)];
    if (!rgb || !/^(?:[\da-f]{6}|[\da-f]{8})$/i.test(rgb)) return undefined;
    rgb = rgb.slice(-6);
    const tint = Number(element.getAttribute("tint") ?? 0);
    if (Number.isFinite(tint) && tint !== 0) {
      const amount = Math.max(-1, Math.min(1, tint));
      rgb = [0, 2, 4].map((index) => {
        const component = parseInt(rgb!.slice(index, index + 2), 16);
        return Math.round(amount < 0 ? component * (1 + amount) : component + (255 - component) * amount).toString(16).padStart(2, "0");
      }).join("");
    }
    return `#${rgb}`;
  };
  const fonts = children(children(root, "fonts")[0], "font");
  const fills = children(children(root, "fills")[0], "fill");
  const borders = children(children(root, "borders")[0], "border");
  const baseFormats = children(children(root, "cellStyleXfs")[0], "xf");
  return children(children(root, "cellXfs")[0], "xf").map((xf) => {
    const base = baseFormats[number(xf.getAttribute("xfId"), 0)];
    const font = fonts[number(xf.getAttribute("fontId") ?? base?.getAttribute("fontId"), 0)];
    const pattern = children(fills[number(xf.getAttribute("fillId") ?? base?.getAttribute("fillId"), 0)], "patternFill")[0];
    const border = borders[number(xf.getAttribute("borderId") ?? base?.getAttribute("borderId"), 0)];
    const alignment = children(xf, "alignment")[0] ?? children(base, "alignment")[0];
    const horizontal = alignment?.getAttribute("horizontal");
    const vertical = alignment?.getAttribute("vertical");
    const style: XlsxCellStyle = {
      whiteSpace: alignment?.getAttribute("wrapText") === "1" ? "pre-wrap" : "pre",
      fontFamily: children(font, "name")[0]?.getAttribute("val") ?? undefined,
      fontSize: Math.min(128, Math.max(1, number(children(font, "sz")[0]?.getAttribute("val"), 11))) * 4 / 3,
      color: color(children(font, "color")[0]),
      ...(enabled(children(font, "b")[0]) ? { fontWeight: "bold" as const } : {}),
      ...(enabled(children(font, "i")[0]) ? { fontStyle: "italic" as const } : {}),
      textDecoration: [enabled(children(font, "u")[0]) ? "underline" : "", enabled(children(font, "strike")[0]) ? "line-through" : ""].filter(Boolean).join(" ") || undefined,
      backgroundColor: pattern?.getAttribute("patternType") === "solid" ? color(children(pattern, "fgColor")[0]) : undefined,
      ...(["left", "center", "right", "justify"].includes(horizontal ?? "") ? { textAlign: horizontal as XlsxCellStyle["textAlign"] } : {}),
      verticalAlign: vertical === "top" ? "top" : vertical === "center" ? "middle" : "bottom"
    };
    for (const [side, key] of [["top", "borderTop"], ["right", "borderRight"], ["bottom", "borderBottom"], ["left", "borderLeft"]] as const) {
      const edge = children(border, side)[0];
      const kind = edge?.getAttribute("style");
      if (kind && kind !== "none") {
        const width = kind === "thick" ? 3 : kind.startsWith("medium") || kind === "double" ? 2 : 1;
        const line = kind === "double" ? "double" : /dash/i.test(kind) ? "dashed" : /dot/i.test(kind) ? "dotted" : "solid";
        style[key] = `${width}px ${line} ${color(children(edge, "color")[0]) ?? "#000000"}`;
      }
    }
    return style;
  });
}

function reference(value: string | null): { row: number; column: number } | null {
  const match = /^([A-Z]+)([1-9]\d*)$/.exec(value?.toUpperCase() ?? "");
  if (!match) return null;
  let column = 0;
  for (const letter of match[1]!) column = column * 26 + letter.charCodeAt(0) - 64;
  const row = Number(match[2]) - 1;
  return column <= XLSX_MAX_COLUMNS && row < XLSX_MAX_ROWS ? { row, column: column - 1 } : null;
}

/** Keeps declared blank template rows and merged geometry without expanding them into DOM nodes. */
export function readXlsxLayout(document: Document, styles: XlsxCellStyle[]): XlsxLayout {
  const root = document.documentElement;
  const format = children(root, "sheetFormatPr")[0];
  const defaultRowHeight = Math.max(1, number(format?.getAttribute("defaultRowHeight"), 15)) * 4 / 3;
  const defaultColumnWidth = number(format?.getAttribute("defaultColWidth"), 8.43) * 7 + 5;
  const rows: XlsxLayout["rows"] = new Map();
  let rowCount = 0;
  let columnCount = 0;
  let truncated = false;
  const merges: XlsxMerge[] = [];
  for (const row of children(children(root, "sheetData")[0], "row")) {
    const index = number(row.getAttribute("r"), rowCount + 1) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= XLSX_MAX_ROWS) { truncated = true; continue; }
    const cells: number[] = [];
    for (const [position, cell] of children(row, "c").entries()) {
      const column = cell.hasAttribute("r") ? reference(cell.getAttribute("r"))?.column : position;
      if (column == null || column >= XLSX_MAX_COLUMNS) { truncated = true; continue; }
      if (cell.hasAttribute("s")) cells[column] = number(cell.getAttribute("s"), 0);
      columnCount = Math.max(columnCount, column + 1);
    }
    rows.set(index, {
      height: Math.max(1, number(row.getAttribute("ht"), defaultRowHeight * 3 / 4)) * 4 / 3,
      hidden: row.getAttribute("hidden") === "1",
      style: row.hasAttribute("s") ? number(row.getAttribute("s"), 0) : undefined,
      cells
    });
    rowCount = Math.max(rowCount, index + 1);
  }
  for (const merge of children(children(root, "mergeCells")[0], "mergeCell")) {
    const [start, end] = (merge.getAttribute("ref") ?? "").split(":");
    const first = reference(start ?? null);
    const last = reference(end ?? start ?? null);
    if (!first || !last || last.row < first.row || last.column < first.column) { truncated = true; continue; }
    merges.push({ ...first, endRow: last.row, endColumn: last.column });
    rowCount = Math.max(rowCount, last.row + 1);
    columnCount = Math.max(columnCount, last.column + 1);
  }
  // Use actual cells and merges, not a stale dimension extending to Excel's last row.
  // A narrow dictionary sheet still needs adjacent blank columns for Excel's
  // unwrapped text overflow and a recognizable spreadsheet grid.
  if (columnCount > 0) columnCount = Math.max(columnCount, 12);
  const columnWidths = Array.from({ length: columnCount }, () => defaultColumnWidth);
  const columnStyles: number[] = [];
  for (const column of children(children(root, "cols")[0], "col")) {
    const first = Math.max(0, number(column.getAttribute("min"), 1) - 1);
    const last = Math.min(columnCount, number(column.getAttribute("max"), first + 1));
    for (let index = first; index < last; index += 1) {
      columnWidths[index] = column.getAttribute("hidden") === "1" ? 0 : Math.max(1, number(column.getAttribute("width"), (defaultColumnWidth - 5) / 7) * 7 + 5);
      if (column.hasAttribute("style")) columnStyles[index] = number(column.getAttribute("style"), 0);
    }
  }
  return { columnWidths, columnStyles, rowCount, defaultRowHeight, rows, merges, styles, truncated };
}
