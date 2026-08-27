import fs from "node:fs";
import path from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import mammoth from "mammoth";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import { detectImageMime } from "./helpers.js";

export const SUPPORTED_EXTENSIONS = new Set([
  ".pdf",
  ".docx",
  ".xlsx",
  ".pptx",
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".xml",
  ".html",
  ".htm",
  ".log",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
]);

const MAX_TEXT_LENGTH = 200_000;
const MAX_EXTRACT_FILE_SIZE = 50 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".xml",
  ".html",
  ".htm",
  ".log",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
]);

export function isTextExtension(ext: string): boolean {
  return TEXT_EXTENSIONS.has(ext);
}

function truncate(text: string, maxLength = MAX_TEXT_LENGTH): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}... (truncated, ${text.length} chars total)`;
}

function xmlText(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function readZip(file: string): Promise<JSZip> {
  return JSZip.loadAsync(fs.readFileSync(file));
}

async function zipEntryText(zip: JSZip, entry: string): Promise<string | null> {
  return (await zip.file(entry)?.async("text")) ?? null;
}

const XML = new XMLParser({
  ignoreAttributes: false,
  trimValues: false,
  textNodeName: "#text",
});

function valuesOf(value: unknown): unknown[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function collectXmlText(value: unknown, names: Set<string>, out: string[]): void {
  if (value == null) return;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return;
  if (Array.isArray(value)) {
    for (const item of value) collectXmlText(item, names, out);
    return;
  }
  if (typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (names.has(key)) {
      for (const item of valuesOf(child)) {
        if (typeof item === "string" || typeof item === "number") out.push(xmlText(String(item)));
        else if (item && typeof item === "object" && "#text" in item) {
          out.push(xmlText(String((item as Record<string, unknown>)["#text"] ?? "")));
        } else collectXmlText(item, names, out);
      }
      continue;
    }
    collectXmlText(child, names, out);
  }
}

async function extractDocxOpenXml(file: string): Promise<string> {
  const zip = await readZip(file);
  const xml = await zipEntryText(zip, "word/document.xml");
  if (xml == null) return "[error: failed to extract DOCX: missing document.xml]";
  const parsed = XML.parse(xml);
  const paragraphs = [...xml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)]
    .map((match) => {
      const texts: string[] = [];
      collectXmlText(XML.parse(match[0]), new Set(["w:t"]), texts);
      return texts.join("");
    })
    .filter((line) => line.trim());
  if (paragraphs.length) return truncate(paragraphs.join("\n\n"));
  const texts: string[] = [];
  collectXmlText(parsed, new Set(["w:t"]), texts);
  return truncate(texts.filter(Boolean).join("\n\n"));
}

async function extractDocx(file: string): Promise<string> {
  try {
    const result = await mammoth.extractRawText({ path: file });
    const text = result.value.trim();
    if (text) return truncate(text);
    return extractDocxOpenXml(file);
  } catch (err) {
    try {
      return await extractDocxOpenXml(file);
    } catch {
      return `[error: failed to extract DOCX: ${(err as Error).message}]`;
    }
  }
}

async function extractXlsxOpenXml(file: string): Promise<string> {
  const zip = await readZip(file);
  const entries = Object.keys(zip.files);
  const sharedXml = (await zipEntryText(zip, "xl/sharedStrings.xml")) ?? "";
  const sharedStrings = [...sharedXml.matchAll(/<si\b[\s\S]*?<\/si>/g)].map((match) => {
    const texts: string[] = [];
    collectXmlText(XML.parse(match[0]), new Set(["t"]), texts);
    return texts.join("");
  });
  const sheetEntries = entries
    .filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry))
    .sort((a, b) => Number(a.match(/sheet(\d+)\.xml/)?.[1] ?? 0) - Number(b.match(/sheet(\d+)\.xml/)?.[1] ?? 0));
  const sheets: string[] = [];
  for (const [index, entry] of sheetEntries.entries()) {
    const xml = await zipEntryText(zip, entry);
    if (!xml) continue;
    const rows: string[] = [];
    for (const row of xml.matchAll(/<row\b[\s\S]*?<\/row>/g)) {
      const cells = [...row[0].matchAll(/<c\b([^>]*)>[\s\S]*?<v>([\s\S]*?)<\/v>[\s\S]*?<\/c>/g)].map((m) => {
        const attrs = m[1];
        const value = xmlText(m[2]);
        return /\bt="s"/.test(attrs) ? sharedStrings[Number(value)] ?? "" : value;
      });
      const line = cells.join("\t");
      if (line.trim()) rows.push(line);
    }
    if (rows.length) sheets.push(`--- Sheet: Sheet${index + 1} ---\n${rows.join("\n")}`);
  }
  return truncate(sheets.join("\n\n"));
}

async function extractXlsx(file: string): Promise<string> {
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(file);
    const sheets: string[] = [];
    workbook.worksheets.forEach((sheet) => {
      const rows: string[] = [];
      sheet.eachRow((row) => {
        const values = Array.isArray(row.values) ? row.values.slice(1) : [];
        const line = values.map((value) => (value == null ? "" : String(value))).join("\t");
        if (line.trim()) rows.push(line);
      });
      if (rows.length) sheets.push(`--- Sheet: ${sheet.name} ---\n${rows.join("\n")}`);
    });
    return truncate(sheets.join("\n\n"));
  } catch (err) {
    try {
      return await extractXlsxOpenXml(file);
    } catch {
      return `[error: failed to extract XLSX: ${(err as Error).message}]`;
    }
  }
}

function tableRowsFromNode(value: unknown): string[] {
  const rows: string[] = [];
  if (value == null) return rows;
  if (Array.isArray(value)) return value.flatMap(tableRowsFromNode);
  if (typeof value !== "object") return rows;
  const obj = value as Record<string, unknown>;
  for (const row of valuesOf(obj["a:tr"])) {
    const cells = valuesOf((row as Record<string, unknown>)?.["a:tc"]).map((cell) => {
      const texts: string[] = [];
      collectXmlText(cell, new Set(["a:t"]), texts);
      return texts.join("").trim();
    });
    const line = cells.filter(Boolean).join("\t");
    if (line) rows.push(line);
  }
  for (const [key, child] of Object.entries(obj)) {
    if (key !== "a:tr") rows.push(...tableRowsFromNode(child));
  }
  return rows;
}

function collectPptxText(value: unknown, out: string[]): void {
  if (value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) collectPptxText(item, out);
    return;
  }
  if (typeof value !== "object") return;
  const obj = value as Record<string, unknown>;
  const rows = tableRowsFromNode(obj);
  if (rows.length) {
    out.push(...rows);
    for (const [key, child] of Object.entries(obj)) {
      if (key !== "a:tr" && key !== "a:tbl") collectPptxText(child, out);
    }
    return;
  }
  for (const [key, child] of Object.entries(obj)) {
    if (key === "a:t") {
      for (const item of valuesOf(child)) {
        if (typeof item === "string" || typeof item === "number") out.push(xmlText(String(item)));
        else if (item && typeof item === "object" && "#text" in item) {
          out.push(xmlText(String((item as Record<string, unknown>)["#text"] ?? "")));
        }
      }
      continue;
    }
    collectPptxText(child, out);
  }
}

async function extractPptx(file: string): Promise<string> {
  try {
    const zip = await readZip(file);
    const entries = Object.keys(zip.files)
      .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry))
      .sort((a, b) => Number(a.match(/slide(\d+)\.xml/)?.[1] ?? 0) - Number(b.match(/slide(\d+)\.xml/)?.[1] ?? 0));
    const slides: string[] = [];
    for (const [index, entry] of entries.entries()) {
      const xml = await zipEntryText(zip, entry);
      if (!xml) continue;
      const texts: string[] = [];
      collectPptxText(XML.parse(xml), texts);
      const cleaned = texts.map((line) => line.trim()).filter(Boolean);
      if (cleaned.length) slides.push(`--- Slide ${index + 1} ---\n${cleaned.join("\n")}`);
    }
    return truncate(slides.join("\n\n"));
  } catch (err) {
    return `[error: failed to extract PPTX: ${(err as Error).message}]`;
  }
}

async function extractPdf(file: string): Promise<string> {
  let doc: Awaited<ReturnType<typeof getDocument>["promise"]> | null = null;
  try {
    const data = new Uint8Array(fs.readFileSync(file));
    doc = await getDocument({
      data,
      disableFontFace: true,
      isEvalSupported: false,
      useSystemFonts: true,
    } as any).promise;
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i += 1) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const text = content.items
        .map((item: any) => ("str" in item ? String(item.str) : ""))
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      pages.push(`--- Page ${i} ---\n${text}`);
    }
    return truncate(pages.join("\n\n"));
  } catch (err) {
    const raw = fs.readFileSync(file);
    const text = raw.toString("latin1").match(/\(([^()\r\n]{2,})\)/g)?.map((m) => m.slice(1, -1)).join("\n") ?? "";
    if (text) return truncate(`--- Page 1 ---\n${text}`);
    return `[error: failed to extract PDF: ${(err as Error).message}]`;
  } finally {
    await (doc as any)?.destroy?.();
  }
}

function extractTextFile(file: string): string {
  try {
    return truncate(fs.readFileSync(file, "utf8"));
  } catch {
    return truncate(fs.readFileSync(file, "latin1"));
  }
}

export async function extractText(filePath: string): Promise<string | null> {
  const file = String(filePath);
  if (!fs.existsSync(file)) return `[error: file not found: ${file}]`;
  const ext = path.extname(file).toLowerCase();
  if (ext === ".pdf") return extractPdf(file);
  if (ext === ".docx") return extractDocx(file);
  if (ext === ".xlsx") return extractXlsx(file);
  if (ext === ".pptx") return extractPptx(file);
  if (isTextExtension(ext)) {
    try {
      return extractTextFile(file);
    } catch (err) {
      return `[error: failed to read file: ${(err as Error).message}]`;
    }
  }
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext)) return `[image: ${path.basename(file)}]`;
  return null;
}

function guessImage(file: string): boolean {
  try {
    const fd = fs.openSync(file, "r");
    const header = Buffer.alloc(16);
    const read = fs.readSync(fd, header, 0, 16, 0);
    fs.closeSync(fd);
    if (detectImageMime(header.subarray(0, read))) return true;
  } catch {
    return false;
  }
  return [".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(path.extname(file).toLowerCase());
}

export async function extractDocuments(
  text: string,
  mediaPaths: string[] = [],
  { maxFileSize }: { maxFileSize?: number } = {},
): Promise<[string, string[]]> {
  const limit = maxFileSize ?? MAX_EXTRACT_FILE_SIZE;
  const imagePaths: string[] = [];
  const docTexts: string[] = [];

  for (const item of mediaPaths) {
    if (!fs.existsSync(item) || !fs.statSync(item).isFile()) continue;
    const stat = fs.statSync(item);
    if (stat.size > limit) continue;
    if (guessImage(item)) {
      imagePaths.push(item);
      continue;
    }
    const extracted = await extractText(item);
    if (extracted && !extracted.startsWith("[error:")) {
      docTexts.push(`[File: ${path.basename(item)}]\n${extracted}`);
    }
  }

  return [docTexts.length ? `${text}\n\n${docTexts.join("\n\n")}` : text, imagePaths];
}
