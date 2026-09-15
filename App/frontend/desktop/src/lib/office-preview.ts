/**
 * Read-only parser for the `.docx` artifacts previewed in-app.
 *
 * The format is a ZIP of XML, so this reads it with JSZip plus the browser's
 * native `DOMParser`. That avoids pulling a JavaScript XML parser into the
 * renderer to parse plugin-generated files, and it yields plain data that the
 * preview renders as React nodes rather than injected HTML.
 *
 * Only what a preview needs is extracted: text, heading level, bold/italic and
 * tables. Styling, images and charts are ignored.
 *
 * Spreadsheets are deliberately not previewed. A worksheet is a sparse grid
 * whose extent is whatever the producing tool wrote, so rendering one means
 * either a virtualised grid or an unbounded table; plugin workbooks are offered
 * as downloads instead.
 */
import JSZip from "jszip";

const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

export interface DocxTextSpan {
  text: string;
  bold: boolean;
  italic: boolean;
}

export type DocxBlock =
  | { kind: "paragraph"; headingLevel: number | null; spans: DocxTextSpan[] }
  | { kind: "table"; rows: DocxTextSpan[][][] };

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
