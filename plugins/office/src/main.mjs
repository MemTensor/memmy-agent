import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { runProcess } from "./process.mjs";
import JSZip from "jszip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { Document, Packer, Paragraph, HeadingLevel } from "docx";
import ExcelJS from "exceljs";
import pptxgen from "pptxgenjs";
import Ajv from "ajv";
import { manifest } from "../scripts/manifest.mjs";
import { parseDelimited } from "./delimited.mjs";
import { selectCjkFont } from "./cjk-fonts.mjs";

const NS = {
  w: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  s: "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
};
const media = { docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pdf: "application/pdf", png: "image/png" };
const ajv = new Ajv({ strict: false, allErrors: true });
const validators = new Map(manifest.capabilities.map(c => [c.id, ajv.compile(c.inputSchema)]));
const emit = event => process.stdout.write(JSON.stringify(event) + "\n");
const fail = (code, message) => Object.assign(new Error(message), { code });
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const ext = name => path.extname(name).slice(1).toLowerCase();
const MAX_FILE = 40 * 1024 * 1024;
const MAX_UNPACKED = 100 * 1024 * 1024;
const children = new Set();
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => {
  for (const child of children) child.kill("SIGKILL");
  process.exit(130);
});

function safeName(value) {
  if (typeof value !== "string" || !value || value.length > 200 || value === "." || value === ".."
    || /[\\/\x00-\x1f<>:"|?*]/.test(value) || /[. ]$/.test(value)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) throw fail("invalid_path", "Expected a safe file name");
  return value;
}
function parseXml(bytes) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString("utf8") : bytes;
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw fail("unsafe_document", "XML entities are not supported");
  return new DOMParser({ onError(level, message) { if (level !== "warning") throw new Error(message); } }).parseFromString(text, "application/xml");
}
const xml = document => new XMLSerializer().serializeToString(document);
const nodes = (document, namespace, tag) => [...Array.from(document.getElementsByTagNameNS(namespace, tag))];
async function regular(file) {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE) throw fail("unsafe_file", "Expected a regular file no larger than 40 MiB");
  return file;
}
// AppContainer cannot query the Windows Mount Manager used by native realpath.
// These roots are canonicalized by the Host before granting the OS sandbox.
// Walk every component inside a granted root and reject all reparse points.
async function canonicalPath(file) {
  if (process.platform !== "win32") return fs.realpath(file);
  const roots = [process.env.MEMMY_PLUGIN_DATA_DIR, ...JSON.parse(process.env.MEMMY_PLUGIN_INPUT_ROOTS ?? "[]")].filter(Boolean);
  const absolute = path.resolve(file);
  const root = roots.find(root => { const rel = path.relative(root, absolute); return !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`); });
  if (!root) throw fail("unsafe_file", "Path is outside Host-approved roots");
  let current = root;
  for (const component of ["", ...path.relative(root, absolute).split(path.sep).filter(Boolean)]) {
    current = path.join(current, component);
    if ((await fs.lstat(current)).isSymbolicLink()) throw fail("unsafe_file", "Path cannot traverse symbolic links");
  }
  return absolute;
}
async function storeRoot() {
  const configured = process.env.MEMMY_PLUGIN_DATA_DIR;
  if (!configured || !path.isAbsolute(configured)) throw fail("plugin_data_unavailable", "Host did not provide plugin-data");
  const root = await canonicalPath(configured);
  await fs.mkdir(path.join(root, "tasks"), { recursive: true });
  return root;
}
async function taskDirectory(id) {
  if (!/^[0-9a-f-]{36}$/.test(id ?? "")) throw fail("invalid_task", "Invalid Office task ID");
  const root = await storeRoot();
  const dir = path.join(root, "tasks", id);
  if ((await fs.lstat(dir)).isSymbolicLink() || await canonicalPath(dir) !== dir) throw fail("invalid_task", "Task directory is unsafe");
  return dir;
}
async function newTask() {
  const root = await storeRoot();
  const taskId = randomUUID();
  const directory = path.join(root, "tasks", taskId);
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, "state.json"), JSON.stringify({ reviews: {}, dirtyFormulaFiles: [] }));
  return { taskId, directory };
}
async function taskFile(input) {
  const directory = await taskDirectory(input.taskId);
  const name = safeName(input.file);
  if (!Object.hasOwn(media, ext(name)) && !["csv", "tsv"].includes(ext(name))) throw fail("unsupported_format", "Unsupported Office format");
  const file = await regular(path.join(directory, name));
  return { directory, file };
}
async function state(directory, update) {
  const file = path.join(directory, "state.json");
  if (!update) return JSON.parse(await fs.readFile(file, "utf8"));
  const lock = path.join(directory, ".state-lock");
  let acquired = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    try { await fs.mkdir(lock); acquired = true; break; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const info = await fs.stat(lock).catch(() => null);
      if (info && Date.now() - info.mtimeMs > 30000) await fs.rm(lock, { recursive: true, force: true });
      await new Promise(ok => setTimeout(ok, 10));
    }
  }
  if (!acquired) throw fail("task_busy", "Another Office operation is updating this task; retry shortly");
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    update(value);
    const temporary = path.join(directory, `${randomUUID()}.json`);
    await fs.writeFile(temporary, JSON.stringify(value));
    await fs.rename(temporary, file);
    return value;
  } finally {
    await fs.rm(lock, { recursive: true, force: true });
  }
}
async function writeNew(file, bytes) {
  if (bytes.length > MAX_FILE) throw fail("file_too_large", "Office output exceeds 40 MiB");
  await fs.writeFile(file, bytes, { flag: "wx" });
}
async function loadZip(file) {
  const bytes = await fs.readFile(await regular(file));
  // Inspect directory sizes before CRC checking, which inflates every entry.
  const zip = await JSZip.loadAsync(bytes);
  const entries = Object.values(zip.files);
  if (entries.length > 4000) throw fail("unsafe_document", "Too many ZIP entries");
  let size = 0;
  for (const item of entries) {
    const original = item.unsafeOriginalName ?? item.name;
    if (original.includes("..") || original.includes("\\") || original.startsWith("/")) throw fail("unsafe_document", "Unsafe ZIP path");
    size += item._data?.uncompressedSize ?? 0;
    if (size > MAX_UNPACKED) throw fail("unsafe_document", "Expanded document exceeds 100 MiB");
    if (/vbaProject|encryption|ActiveX/i.test(item.name)) throw fail("unsupported_document", "Macros, encryption and ActiveX are not supported");
  }
  return await JSZip.loadAsync(bytes, { checkCRC32: true });
}
async function runtime() {
  let available = {};
  if (process.env.MEMMY_OFFICE_TOOLS) available = JSON.parse(process.env.MEMMY_OFFICE_TOOLS);
  const found = {};
  for (const [name, file] of Object.entries(available)) {
    if (!path.isAbsolute(file)) continue;
    try { await fs.access(file, 1); found[name] = file; } catch { /* explicit missing dependency */ }
  }
  return found;
}
async function command(name, args, directory) {
  const tools = await runtime();
  if (!tools[name]) throw fail("office_dependency_missing", `${name} is unavailable. The Host could not provision LibreOffice and Poppler. Retry plugin activation or check the runtime registry. No render or calculation was performed.`);
  // A fresh HOME must not hide system fonts from headless/fontconfig builds.
  const fontConfig = path.join(directory, "office-fonts.conf");
  const xml = value => value.replaceAll("\\", "/").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
  const fontDirectories = process.platform === "win32"
    ? [path.join(process.env.SystemRoot ?? "C:\\Windows", "Fonts")]
    : ["/System/Library/Fonts", "/Library/Fonts", "/usr/share/fonts", "/usr/local/share/fonts"];
  await fs.writeFile(fontConfig, `<?xml version="1.0"?><fontconfig>${fontDirectories.map(dir => `<dir>${xml(dir)}</dir>`).join("")}<cachedir>${xml(directory)}/font-cache</cachedir></fontconfig>`);
  const result = await runProcess(tools[name], args, { cwd: directory, children,
    env: { ...process.env, HOME: directory, TMPDIR: directory, TEMP: directory, TMP: directory,
      XDG_CONFIG_HOME: path.join(directory, "config"), XDG_CACHE_HOME: path.join(directory, "cache"), FONTCONFIG_FILE: fontConfig } });
  if (result.code !== 0) throw fail("office_conversion_failed", `${name} failed (${result.code ?? result.signal}): ${result.stderr || result.stdout.slice(0, 8192) || "no diagnostic output"}`);
  return result.stdout;
}
async function workbookWithoutFormulaCaches(input) {
  const zip = await loadZip(input);
  let formulaCount = 0;
  for (const part of Object.values(zip.files)) {
    if (part.dir || !/^xl\/worksheets\/sheet\d+\.xml$/.test(part.name)) continue;
    const document = parseXml(await part.async("string"));
    let changed = false;
    for (const cell of nodes(document, NS.s, "c")) {
      if (!nodes(cell, NS.s, "f").length) continue;
      // Keep formulas (including shared/array metadata), styles and constants.
      // A cached result and its type are not evidence of a fresh calculation.
      for (const cached of nodes(cell, NS.s, "v")) cached.parentNode.removeChild(cached);
      cell.removeAttribute("t");
      formulaCount++; changed = true;
    }
    if (changed) zip.file(part.name, xml(document));
  }
  if (!formulaCount) return fs.readFile(input);
  const workbook = parseXml(await zip.file("xl/workbook.xml").async("string"));
  let calculation = nodes(workbook, NS.s, "calcPr")[0];
  if (!calculation) {
    calculation = workbook.createElementNS(NS.s, "calcPr");
    const following = new Set(["oleSize", "customWorkbookViews", "pivotCaches", "smartTagPr", "smartTagTypes", "webPublishing", "fileRecoveryPr", "webPublishObjects", "extLst"]);
    workbook.documentElement.insertBefore(calculation, Array.from(workbook.documentElement.childNodes).find(node => following.has(node.localName)) ?? null);
  }
  calculation.setAttribute("calcMode", "auto");
  calculation.setAttribute("fullCalcOnLoad", "1");
  calculation.setAttribute("forceFullCalc", "1");
  zip.file("xl/workbook.xml", xml(workbook));
  return zip.generateAsync({ type: "nodebuffer" });
}
async function convertFile(input, outputDir, format, csv) {
  // Windows extension registries append long names below UserInstallation.
  // Deep task/QA paths can exceed native limits despite longPathAware. Keep
  // each conversion in a short, unique directory inside approved plugin-data.
  const windows = process.platform === "win32";
  const work = await fs.mkdtemp(path.join(windows ? await storeRoot() : outputDir, windows ? "r-" : "conversion-"));
  const profile = pathToFileURL(path.join(work, "profile")).href;
  try {
    let source = input, convertedDirectory = work;
    if (windows || ext(input) === "xlsx") {
      source = path.join(work, `source.${ext(input)}`);
      // Recalculate a private copy, never the user's source workbook. Missing
      // caches force LibreOffice to evaluate formulas instead of reusing them.
      await writeNew(source, ext(input) === "xlsx" ? await workbookWithoutFormulaCaches(input) : await fs.readFile(input));
      convertedDirectory = path.join(work, "out");
      await fs.mkdir(convertedDirectory);
    }
    // LibreOffice must not run embedded macros or refresh external links.
    const profileDirectory = path.join(work, "profile", "user");
    await fs.mkdir(profileDirectory, { recursive: true });
    await fs.writeFile(path.join(profileDirectory, "registrymodifications.xcu"), `<?xml version="1.0" encoding="UTF-8"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item><item oor:path="/org.openoffice.Office.Calc/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>0</value></prop></item></oor:items>`);
    // LibreOffice falls back here when the OS sandbox denies /tmp and /var/tmp.
    // Keep the Unix socket name short and relative to this private working dir.
    const options = [`-env:UserInstallation=${profile}`, "-env:OSL_SOCKET_PATH=.", "--headless", "--norestore", "--nodefault", "--nolockcheck"];
    const tools = await runtime();
    if (process.platform === "darwin" && tools.soffice) {
      // The native macOS spellchecker calls NSApplicationLoad even in headless
      // mode. Use a per-conversion UNO registry without that GUI-only service;
      // keep Hunspell and leave the verified renderer installation untouched.
      const services = path.resolve(path.dirname(tools.soffice), "../Resources/services/services.rdb");
      const registry = parseXml(await fs.readFile(services));
      const implementations = nodes(registry, "http://openoffice.org/2010/uno-components", "implementation");
      const native = implementations.find(item => item.getAttribute("name") === "org.openoffice.lingu.MacOSXSpellChecker");
      if (native) {
        const component = native.parentNode;
        component.removeChild(native);
        if (!nodes(component, "http://openoffice.org/2010/uno-components", "implementation").length) component.parentNode.removeChild(component);
        const headless = path.join(work, "headless-services.rdb");
        await fs.writeFile(headless, xml(registry));
        options.push(`-env:URE_MORE_SERVICES=${pathToFileURL(headless).href}`);
      }
    }
    if (["csv", "tsv"].includes(ext(input))) {
      if (!csv) throw fail("csv_policy_required", "CSV/TSV needs an explicit UTF-8 encoding and delimiter");
      const delimiter = csv.delimiter.charCodeAt(0);
      options.push(`--infilter=Text - txt - csv (StarCalc):${delimiter},34,76,1,,0,false,true,false,false,false,0,false`);
    }
    const filters = { pdf: "pdf", xlsx: "xlsx:Calc MS Excel 2007 XML" };
    await command("soffice", [...options, "--convert-to", filters[format], "--outdir", convertedDirectory, source], work);
    const converted = path.join(convertedDirectory, `${path.basename(source, path.extname(source))}.${format}`);
    await regular(converted);
    const output = path.join(outputDir, `${randomUUID()}.${format}`);
    await writeNew(output, await fs.readFile(converted));
    return output;
  } finally { await fs.rm(work, { recursive: true, force: true }); }
}
function artifact(file, name, role = "deliverable") {
  emit({ type: "artifact", artifact: { id: randomUUID(), name, mediaType: media[ext(file)], uri: pathToFileURL(file).href, role } });
}

async function create(input) {
  const name = safeName(input.name);
  if (ext(name) !== input.format) throw fail("invalid_format", "File name must match format");
  const task = await newTask();
  const file = path.join(task.directory, name);
  if (input.format === "docx" || input.format === "pdf") {
    if (!input.title && !input.paragraphs?.length) throw fail("empty_document", "Provide title or paragraphs");
    const cjkFont = await selectCjkFont([input.title ?? "", ...(input.paragraphs ?? [])].join("\n"));
    const font = cjkFont ? { ascii: "Arial", hAnsi: "Arial", cs: "Arial", eastAsia: cjkFont.familyName } : "Arial";
    const doc = new Document({ styles: { default: { document: { run: { font, size: 22 }, paragraph: { spacing: { after: 160, line: 276 } } } } },
      sections: [{ properties: { page: { margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 } } }, children: [
        ...(input.title ? [new Paragraph({ text: input.title, heading: HeadingLevel.TITLE })] : []),
        ...(input.paragraphs ?? []).map(text => new Paragraph({ text }))
      ] }] });
    const source = input.format === "pdf" ? path.join(task.directory, "source.docx") : file;
    await writeNew(source, await Packer.toBuffer(doc));
    if (input.format === "pdf") await fs.rename(await convertFile(source, task.directory, "pdf"), file);
  } else if (input.format === "pptx") {
    if (!input.slides?.length) throw fail("empty_document", "Provide slides");
    const deck = new pptxgen(); deck.layout = "LAYOUT_WIDE"; deck.author = "Memmy Office";
    deck.subject = input.title ?? ""; deck.title = input.title ?? "";
    deck.theme = { headFontFace: "Arial", bodyFontFace: "Arial", lang: "zh-CN" };
    for (const content of input.slides) {
      const slide = deck.addSlide();
      slide.background = { color: "FFFFFF" };
      slide.addText(content.title, { x: 0.6, y: 0.5, w: 12.1, h: 0.85, fontSize: 32, bold: true, color: "173C35", breakLine: false });
      slide.addText(content.body.map(text => ({ text, options: { bullet: { indent: 20 }, breakLine: true } })),
        { x: 0.7, y: 1.6, w: 11.9, h: 4.9, fontSize: 20, paraSpaceAfterPt: 14, color: "24332F", valign: "top" });
      if (content.notes) slide.addNotes(content.notes);
    }
    await writeNew(file, Buffer.from(await deck.write({ outputType: "nodebuffer" })));
  } else if (input.format === "xlsx") {
    if (!input.sheets?.length) throw fail("empty_document", "Provide sheets");
    const book = new ExcelJS.Workbook(); book.creator = "Memmy Office";
    let formulas = false;
    for (const content of input.sheets) {
      const sheet = book.addWorksheet(content.name);
      for (const row of content.rows) {
        if (row.some(value => value && typeof value === "object" && value.formula)) formulas = true;
        sheet.addRow(row);
      }
      sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
      sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF24574A" } };
      sheet.views = [{ state: "frozen", ySplit: 1 }];
      for (const column of sheet.columns) column.width = 22;
      sheet.pageSetup = { paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
    }
    book.calcProperties.fullCalcOnLoad = true;
    await writeNew(file, Buffer.from(await book.xlsx.writeBuffer()));
    if (formulas) await state(task.directory, s => { s.dirtyFormulaFiles.push(name); });
  }
  await inspect(file);
  return { taskId: task.taskId, file: name, needsRender: true, needsRecalculation: (await state(task.directory)).dirtyFormulaFiles.includes(name) };
}

async function inspect(file) {
  const format = ext(file);
  if (format === "pdf") {
    if (!(await fs.readFile(file)).subarray(0, 5).equals(Buffer.from("%PDF-"))) throw fail("invalid_pdf", "Missing PDF header");
    const text = await command("pdftotext", ["-layout", file, "-"], path.dirname(file));
    const info = await command("pdfinfo", [file], path.dirname(file));
    return { format, text: text.slice(0, 100000), truncated: text.length > 100000, info };
  }
  if (["csv", "tsv"].includes(format)) return { format, text: (await fs.readFile(file, "utf8")).slice(0, 100000), needsExplicitCsvPolicy: true };
  const zip = await loadZip(file);
  const main = { docx: "word/document.xml", pptx: "ppt/presentation.xml", xlsx: "xl/workbook.xml" }[format];
  if (!main || !zip.file(main) || !zip.file("[Content_Types].xml") || !zip.file("_rels/.rels")) throw fail("invalid_document", "Missing required Office parts");
  const warnings = [], texts = [], formulas = [];
  for (const item of Object.values(zip.files)) {
    if (item.dir) continue;
    if (item.name.endsWith(".rels")) {
      const rels = parseXml(await item.async("string"));
      for (const rel of Array.from(rels.getElementsByTagName("Relationship"))) {
        if (rel.getAttribute("TargetMode") === "External") { warnings.push(`External relationship retained: ${item.name}`); continue; }
        const base = item.name === "_rels/.rels" ? "" : path.posix.dirname(path.posix.dirname(item.name));
        const target = path.posix.normalize(path.posix.join(base, rel.getAttribute("Target")));
        const absolute = rel.getAttribute("Target").replace(/^\//, "");
        if (!zip.file(target) && !zip.file(absolute)) throw fail("broken_relationship", `Missing part: ${target}`);
      }
    }
    if (format === "docx" && /^word\/(document|header\d+|footer\d+)\.xml$/.test(item.name)) {
      const doc = parseXml(await item.async("string"));
      texts.push(...nodes(doc, NS.w, "p").map(p => nodes(p, NS.w, "t").map(t => t.textContent).join("")));
    }
    if (format === "pptx" && /^ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/.test(item.name)) {
      const doc = parseXml(await item.async("string"));
      texts.push(...nodes(doc, NS.a, "p").map(p => nodes(p, NS.a, "t").map(t => t.textContent).join("")));
    }
    if (format === "xlsx" && /^xl\/worksheets\/sheet\d+\.xml$/.test(item.name)) {
      const doc = parseXml(await item.async("string"));
      for (const cell of nodes(doc, NS.s, "c")) {
        const formula = nodes(cell, NS.s, "f")[0];
        const value = nodes(cell, NS.s, "v")[0]?.textContent ?? null;
        if (cell.getAttribute("t") === "e") throw fail("formula_error", `Excel error ${value} at ${cell.getAttribute("r")}`);
        if (formula) formulas.push({ part: item.name, cell: cell.getAttribute("r"), formula: formula.textContent, cachedValue: value });
      }
    }
  }
  const text = texts.join("\n");
  if (format === "pptx" && /\b(?:xxx|lorem|ipsum|TODO)\b|\[insert/i.test(text)) throw fail("placeholder_text", "Presentation contains placeholder text");
  return { format, text: text.slice(0, 100000), truncated: text.length > 100000, parts: Object.keys(zip.files).length,
    warnings: [...new Set(warnings)], ...(format === "xlsx" ? { formulas, sheets: await workbookSummary(zip) } : {}) };
}
async function workbookSummary(zip) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await zip.generateAsync({ type: "nodebuffer" }));
  return workbook.worksheets.map(sheet => ({ name: sheet.name, state: sheet.state,
    rows: sheet.getSheetValues().slice(1, 1001).map(row => row?.slice(1)), truncated: sheet.rowCount > 1000 }));
}

function replaceInParagraph(paragraph, namespace, replacements) {
  const runs = nodes(paragraph, namespace, "t");
  let count = 0;
  for (const replacement of replacements) {
    let combined = runs.map(t => t.textContent ?? "").join("");
    let index = combined.indexOf(replacement.from);
    const occurrences = [];
    while (index >= 0) { occurrences.push(index); index = combined.indexOf(replacement.from, index + replacement.from.length); }
    for (const start of occurrences.reverse()) {
      const end = start + replacement.from.length;
      let offset = 0;
      for (const run of runs) {
        const text = run.textContent ?? "", next = offset + text.length;
        if (offset < end && next > start) {
          run.textContent = text.slice(0, Math.max(0, start - offset)) + (start >= offset ? replacement.to : "") + text.slice(Math.min(text.length, end - offset));
          run.setAttribute("xml:space", "preserve");
        }
        offset = next;
      }
      count++;
    }
  }
  return count;
}
async function edit(input) {
  const { directory, file } = await taskFile(input);
  const name = safeName(input.name), format = ext(file);
  if (ext(name) !== format || name === input.file) throw fail("invalid_output", "Editing requires a different name with the same format");
  if (!["docx", "pptx", "xlsx"].includes(format)) throw fail("unsupported_operation", "Use conversion or recreation for PDF");
  const zip = await loadZip(file);
  let changes = 0, formulaChanged = false;
  if (format === "xlsx") {
    if (!input.cells?.length || input.replacements) throw fail("invalid_edit", "Excel editing requires explicit cells");
    const book = parseXml(await zip.file("xl/workbook.xml").async("string"));
    const rels = parseXml(await zip.file("xl/_rels/workbook.xml.rels").async("string"));
    for (const change of input.cells) {
      const sheet = Array.from(book.getElementsByTagName("sheet")).find(s => s.getAttribute("name") === change.sheet);
      if (!sheet) throw fail("sheet_not_found", change.sheet);
      const rel = Array.from(rels.getElementsByTagName("Relationship")).find(r => r.getAttribute("Id") === sheet.getAttribute("r:id"));
      if (!rel) throw fail("invalid_document", "Sheet relationship missing");
      const target = rel.getAttribute("Target");
      const part = target.startsWith("/") ? target.slice(1) : path.posix.normalize(path.posix.join("xl", target));
      const doc = parseXml(await zip.file(part).async("string"));
      const sheetData = nodes(doc, NS.s, "sheetData")[0];
      const rowNumber = Number(change.address.match(/\d+$/)[0]);
      if (rowNumber > 1048576) throw fail("invalid_cell", "Row exceeds Excel limit");
      const column = change.address.match(/^[A-Z]+/)[0];
      const columnIndex = letters => [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
      if (columnIndex(column) > 16384) throw fail("invalid_cell", "Column exceeds Excel limit");
      let row = nodes(doc, NS.s, "row").find(r => Number(r.getAttribute("r")) === rowNumber);
      if (!row) {
        row = doc.createElementNS(NS.s, "row"); row.setAttribute("r", String(rowNumber));
        sheetData.insertBefore(row, nodes(sheetData, NS.s, "row").find(r => Number(r.getAttribute("r")) > rowNumber) ?? null);
      }
      let cell = nodes(row, NS.s, "c").find(c => c.getAttribute("r") === change.address);
      if (!cell) {
        cell = doc.createElementNS(NS.s, "c"); cell.setAttribute("r", change.address);
        row.insertBefore(cell, nodes(row, NS.s, "c").find(c => columnIndex(c.getAttribute("r").match(/^[A-Z]+/)[0]) > columnIndex(column)) ?? null);
      }
      if (nodes(cell, NS.s, "f").length && !change.formula) throw fail("formula_preservation_required", "Cannot replace a formula with a constant");
      while (cell.firstChild) cell.removeChild(cell.firstChild);
      cell.removeAttribute("t");
      const add = (tag, value) => { const element = doc.createElementNS(NS.s, tag); element.textContent = String(value); cell.appendChild(element); };
      if (change.formula) { add("f", change.formula.replace(/^=/, "")); formulaChanged = true; }
      else if (typeof change.value === "string") { cell.setAttribute("t", "inlineStr"); const is = doc.createElementNS(NS.s, "is"); const t = doc.createElementNS(NS.s, "t"); t.textContent = change.value; t.setAttribute("xml:space", "preserve"); is.appendChild(t); cell.appendChild(is); }
      else if (typeof change.value === "number") add("v", change.value);
      else if (typeof change.value === "boolean") { cell.setAttribute("t", "b"); add("v", change.value ? 1 : 0); }
      else if (change.value !== null) throw fail("invalid_edit", "Cell needs value or formula");
      zip.file(part, xml(doc)); changes++;
    }
    // Any cell edit may invalidate dependent formulas, including cross-sheet ones.
    formulaChanged ||= (await inspect(file)).formulas.length > 0;
  } else {
    if (!input.replacements?.length || input.cells) throw fail("invalid_edit", "Text edits require replacements");
    const namespace = format === "docx" ? NS.w : NS.a;
    const matched = new Map(input.replacements.map(r => [r.from, 0]));
    for (const item of Object.values(zip.files)) {
      const eligible = format === "docx" ? /^word\/(document|header\d+|footer\d+|footnotes|endnotes)\.xml$/ : /^ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/;
      if (!eligible.test(item.name)) continue;
      const document = parseXml(await item.async("string"));
      let changed = 0;
      for (const paragraph of nodes(document, namespace, "p")) {
        for (const replacement of input.replacements) {
          const count = replaceInParagraph(paragraph, namespace, [replacement]);
          matched.set(replacement.from, matched.get(replacement.from) + count); changed += count;
        }
      }
      if (changed) zip.file(item.name, xml(document));
      changes += changed;
    }
    if ([...matched.values()].some(n => !n)) throw fail("text_not_found", "At least one exact replacement has no match");
  }
  const output = path.join(directory, name);
  await writeNew(output, await zip.generateAsync({ type: "nodebuffer" }));
  await inspect(output);
  if (formulaChanged) await state(directory, s => { s.dirtyFormulaFiles.push(name); });
  return { taskId: input.taskId, file: name, changes, needsRender: true, needsRecalculation: formulaChanged };
}

async function render(input) {
  const { directory, file } = await taskFile(input);
  const sourceSummary = await inspect(file);
  if (["csv", "tsv"].includes(ext(file))) throw fail("conversion_required", "Convert delimited text to XLSX before rendering");
  const revision = digest(await fs.readFile(file));
  const qa = await fs.mkdtemp(path.join(directory, "qa-"));
  const pdf = ext(file) === "pdf" ? file : await convertFile(file, qa, "pdf");
  if (ext(file) === "docx" && /[\u3400-\u9fff]/.test(sourceSummary.text)) {
    const renderedText = await command("pdftotext", [pdf, "-"], qa);
    if (!/[\u3400-\u9fff]/.test(renderedText)) throw fail("font_rendering_failed", "Chinese source text disappeared during rendering; install CJK fonts and render again");
  }
  const info = await command("pdfinfo", [pdf], qa);
  const pages = Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
  if (!Number.isInteger(pages) || pages < 1 || pages > 200) throw fail("page_limit", "Rendering supports 1–200 pages");
  const prefix = path.join(qa, "page");
  await command("pdftoppm", ["-png", "-r", "100", pdf, prefix], qa);
  const files = (await fs.readdir(qa)).filter(f => /^page-\d+\.png$/.test(f)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  if (files.length !== pages) throw fail("incomplete_render", "Missing rendered pages");
  const pageRecords = [];
  for (let index = 0; index < files.length; index++) {
    const image = await regular(path.join(qa, files[index]));
    const name = `qa-${input.taskId}-${revision.slice(0, 12)}-page-${index + 1}.png`;
    pageRecords.push({ page: index + 1, name });
  }
  await state(directory, s => { s.reviews[input.file] = { revision, pages, qa, files, viewedPages: [] }; });
  return { taskId: input.taskId, file: input.file, revision, pages: pageRecords, requiresVisualReview: true };
}
async function deliver(input) {
  const { directory, file } = await taskFile(input);
  const summary = await inspect(file);
  const s = await state(directory), review = s.reviews[input.file];
  if (!review || review.revision !== input.revision || input.revision !== digest(await fs.readFile(file))) throw fail("stale_review", "Render the exact final file before delivery");
  const pages = [...input.reviewedPages].sort((a, b) => a - b);
  if (pages.length !== review.pages || pages.some((page, i) => page !== i + 1)) throw fail("incomplete_review", "Every rendered page must be inspected");
  if (pages.some(page => !review.viewedPages.includes(page))) throw fail("pages_not_viewed", "Request every rendered page with office_review_page before delivery");
  if (ext(file) === "xlsx" && (s.dirtyFormulaFiles.includes(input.file) || summary.formulas.some(f => f.cachedValue === null || f.cachedValue === ""))) throw fail("recalculation_required", "Workbook formulas need recalculation before delivery");
  const audit = { revision: input.revision, reviewedPages: pages, reviewNotes: input.reviewNotes, deliveredAt: new Date().toISOString() };
  await fs.writeFile(path.join(directory, `${randomUUID()}.review.json`), JSON.stringify(audit));
  artifact(file, input.file);
  return { taskId: input.taskId, file: input.file, delivered: true, revision: input.revision, review: audit };
}

async function handle(call) {
  const validate = validators.get(call.capabilityId);
  if (!validate) throw fail("capability_not_found", "Unknown Office capability");
  const input = call.input ?? {};
  if (!validate(input)) throw fail("invalid_input", ajv.errorsText(validate.errors));
  switch (call.capabilityId) {
    case "office_status": {
      const tools = await runtime();
      const missing = ["soffice", "pdfinfo", "pdftoppm", "pdftotext"].filter(tool => !tools[tool]);
      return { version: manifest.version, formats: ["docx", "pdf", "pptx", "xlsx"], ready: !missing.length, missing,
        limits: { inputMiB: 40, pages: 200, macros: false, directPdfTextEditing: false } };
    }
    case "office_create": return await create(input);
    case "office_execute": {
      if (input.inputFiles?.length && !input.sourceTaskId) throw fail("invalid_input", "inputFiles require sourceTaskId");
      const task = await newTask();
      const executionDirectory = path.join(task.directory, "execution");
      await fs.mkdir(executionDirectory);
      // Snapshot clean input bytes before untrusted code runs. A byte-identical
      // copy keeps calculation state, but never inherits visual review state.
      const cleanWorkbookHashes = new Set();
      for (const name of input.inputFiles ?? []) {
        const source = await taskFile({ taskId: input.sourceTaskId, file: name });
        const bytes = await fs.readFile(source.file);
        if (ext(name) === "xlsx" && !(await state(source.directory)).dirtyFormulaFiles.includes(name)) {
          cleanWorkbookHashes.add(digest(bytes));
        }
        await writeNew(path.join(executionDirectory, safeName(name)), bytes);
      }
      // __filename survives the CommonJS bundle; it is never derived from input.
      const executable = path.join(path.dirname(__filename), "execute.cjs");
      const root = path.dirname(executable);
      const executed = await runProcess(process.execPath, [...(process.platform === "win32" ? ["--preserve-symlinks", "--preserve-symlinks-main"] : []),
        "--permission", "--max-old-space-size=256", `--allow-fs-read=${root}`, `--allow-fs-read=${executionDirectory}`,
        `--allow-fs-write=${executionDirectory}`, executable], { cwd: executionDirectory, children, timeout: 60000, maxOutput: 1048576,
        input: JSON.stringify({ code: input.code, workspace: executionDirectory }),
        env: { PATH: process.env.PATH, ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
          LOCALAPPDATA: process.env.LOCALAPPDATA, TEMP: executionDirectory, TMP: executionDirectory } : {}), LANG: "C.UTF-8", ELECTRON_RUN_AS_NODE: "1" } });
      if (executed.code !== 0) throw fail("office_execution_failed", executed.stderr || "Office code failed");
      let response;
      try { response = JSON.parse(executed.stdout); }
      catch { throw fail("invalid_execution_result", "Code must return {files:[names]}"); }
      if (!response || !Array.isArray(response.files) || !response.files.length || response.files.length > 30) throw fail("invalid_execution_result", "Return 1–30 output file names");
      for (const name of response.files) {
        safeName(name);
        if (!["docx", "pdf", "pptx", "xlsx"].includes(ext(name))) throw fail("unsupported_format", "Execution outputs must be Office/PDF files");
        const source = await regular(path.join(executionDirectory, name));
        const file = path.join(task.directory, name);
        const bytes = await fs.readFile(source);
        await writeNew(file, bytes);
        const checked = await inspect(file);
        if (ext(file) === "xlsx" && checked.formulas.length && !cleanWorkbookHashes.has(digest(bytes))) {
          await state(task.directory, s => { s.dirtyFormulaFiles.push(name); });
        }
      }
      return { taskId: task.taskId, files: response.files, needsRender: true, codeExecutedInPermissionSandbox: true };
    }
    case "office_import": {
      if (!path.isAbsolute(input.path)) throw fail("invalid_path", "Upload path must be absolute");
      await regular(input.path);
      if (await canonicalPath(input.path) !== input.path) throw fail("unsafe_file", "Upload cannot traverse symbolic links");
      const format = ext(input.path);
      if (!["docx", "pdf", "pptx", "xlsx", "csv", "tsv"].includes(format)) throw fail("unsupported_format", "Unsupported upload format");
      const task = await newTask(); const name = safeName(path.basename(input.path));
      await writeNew(path.join(task.directory, name), await fs.readFile(input.path));
      await inspect(path.join(task.directory, name));
      return { taskId: task.taskId, file: name, sourceUnchanged: true };
    }
    case "office_inspect": return { taskId: input.taskId, file: input.file, ...await inspect((await taskFile(input)).file) };
    case "office_edit": return await edit(input);
    case "office_convert": {
      const { directory, file } = await taskFile(input);
      const format = ext(file);
      if (format === "pdf" || !["docx", "pptx", "xlsx", "csv", "tsv"].includes(format)) throw fail("unsupported_conversion", "Unsupported conversion source");
      if (input.format === "xlsx" && !["xlsx", "csv", "tsv"].includes(format)) throw fail("unsupported_conversion", "Only workbook sources can become XLSX");
      if (input.format === "xlsx" && format === "xlsx" && input.allowLossy !== true) throw fail("preservation_consent_required", "LibreOffice normalization may alter unsupported objects; explicit allowLossy=true is required");
      const sourceHash = digest(await fs.readFile(file));
      let output;
      if (["csv", "tsv"].includes(format)) {
        let rows;
        try { rows = parseDelimited(await fs.readFile(file), input.csv); }
        catch (error) { throw fail("invalid_csv", error.message); }
        const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet("Data");
        sheet.addRows(rows); // Strings stay strings, including leading '=' and zeros.
        const intermediate = path.join(directory, `${randomUUID()}.xlsx`);
        await writeNew(intermediate, Buffer.from(await workbook.xlsx.writeBuffer()));
        output = input.format === "xlsx" ? intermediate : await convertFile(intermediate, directory, "pdf");
      } else output = await convertFile(file, directory, input.format, input.csv);
      const summary = await inspect(output);
      if (input.format === "xlsx" && summary.formulas.some(formula => formula.cachedValue === null)) {
        throw fail("recalculation_failed", "LibreOffice did not produce calculated formula results");
      }
      if (sourceHash !== digest(await fs.readFile(file))) throw fail("source_modified", "Conversion altered source");
      return { taskId: input.taskId, file: path.basename(output), sourceUnchanged: true, needsRender: true, ...(input.allowLossy ? { warning: "LibreOffice normalized this workbook; review object and formatting preservation." } : {}) };
    }
    case "office_render": return await render(input);
    case "office_review_page": {
      const { directory, file } = await taskFile(input);
      const review = (await state(directory)).reviews[input.file];
      if (!review || review.revision !== input.revision || input.revision !== digest(await fs.readFile(file))) throw fail("stale_review", "Render the current file first");
      if (input.page > review.pages) throw fail("invalid_page", "Page does not exist");
      const image = await regular(path.join(review.qa, review.files[input.page - 1]));
      artifact(image, `qa-${input.taskId}-page-${input.page}.png`, "setup");
      await state(directory, s => { const pages = s.reviews[input.file].viewedPages; if (!pages.includes(input.page)) pages.push(input.page); });
      return { taskId: input.taskId, file: input.file, revision: input.revision, page: input.page, requiresVisualInspection: true };
    }
    case "office_deliver": return await deliver(input);
  }
}

const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
reader.once("line", async line => {
  reader.close(); process.stdin.pause();
  try {
    if (Buffer.byteLength(line) > 8 * 1024 * 1024) throw fail("input_limit", "Request exceeds 8 MiB");
    const call = JSON.parse(line);
    emit({ type: "progress", current: 0, total: 1, message: "Office processing", cancellable: true });
    const output = await handle(call);
    emit({ type: "result", output });
  } catch (error) {
    console.error(error.stack ?? error);
    emit({ type: "error", code: error.code ?? "office_error", message: error.message, retryable: false });
  }
});
