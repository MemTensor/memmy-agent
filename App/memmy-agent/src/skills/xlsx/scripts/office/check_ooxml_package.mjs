#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";

const usage = `Usage: check_ooxml_package.mjs --input <workbook.xlsx|directory> [--json]
       check_ooxml_package.mjs <workbook.xlsx|directory> [--json]`;

function parseArgs(argv) {
  const result = { input: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--json") result.json = true;
    else if (arg === "--input" || arg === "-i") result.input = argv[++i];
    else if (!arg.startsWith("-") && !result.input) result.input = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!result.input) throw new Error("Missing input");
  return result;
}

function parseXml(bytes, name) {
  let issue = "";
  const document = new DOMParser({ errorHandler: { warning() {}, error(message) { issue = message; }, fatalError(message) { issue = message; } } }).parseFromString(bytes.toString("utf8"), "application/xml");
  if (issue || !document?.documentElement) throw new Error(`${name}: invalid XML`);
  return document;
}

function descendants(root, wanted) {
  const result = [];
  const visit = (node) => {
    for (let child = node?.firstChild; child; child = child.nextSibling) {
      if (child.nodeType !== 1) continue;
      const local = child.localName || child.nodeName.split(":").pop();
      if (!wanted || local === wanted) result.push(child);
      visit(child);
    }
  };
  visit(root);
  return result;
}

async function readFiles(input) {
  const stat = await fs.stat(input).catch(() => null);
  if (!stat) throw new Error(`Input does not exist: ${input}`);
  if (stat.isDirectory()) {
    const result = new Map();
    const visit = async (directory) => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(file);
        else result.set(path.relative(input, file).split(path.sep).join("/"), await fs.readFile(file));
      }
    };
    await visit(input);
    return result;
  }
  const zip = await JSZip.loadAsync(await fs.readFile(input), { checkCRC32: true });
  const result = new Map();
  for (const [name, entry] of Object.entries(zip.files)) {
    const normalized = path.posix.normalize(name);
    if (normalized.startsWith("../") || normalized === ".." || name.startsWith("/")) throw new Error(`ZIP path traversal: ${name}`);
    if (!entry.dir) result.set(normalized, await entry.async("nodebuffer"));
  }
  return result;
}

function relationshipSource(name) {
  if (name === "_rels/.rels") return "";
  const marker = "/_rels/";
  const index = name.lastIndexOf(marker);
  return index < 0 ? null : `${name.slice(0, index)}/${name.slice(index + marker.length, -5)}`;
}

async function check(input) {
  const files = await readFiles(input);
  const errors = [];
  const warnings = [];
  const documents = new Map();
  for (const [name, bytes] of files) if (name.endsWith(".xml") || name.endsWith(".rels")) {
    try { documents.set(name, parseXml(bytes, name)); } catch (error) { errors.push({ code: "invalid_xml", part: name, message: error.message }); }
  }
  for (const required of ["[Content_Types].xml", "xl/workbook.xml", "xl/_rels/workbook.xml.rels"]) if (!files.has(required)) errors.push({ code: "missing_part", part: required, message: `Required part is missing: ${required}` });
  const types = documents.get("[Content_Types].xml");
  if (types) for (const override of descendants(types.documentElement, "Override")) {
    const part = override.getAttribute("PartName").replace(/^\//, "");
    if (part && !files.has(part)) errors.push({ code: "missing_content_type_part", part, message: `Content type points to missing part: ${part}` });
  }
  for (const [name, document] of documents) if (name.endsWith(".rels")) {
    const source = relationshipSource(name) || "";
    for (const relation of descendants(document.documentElement, "Relationship")) {
      if (String(relation.getAttribute("TargetMode")).toLowerCase() === "external") {
        warnings.push({ code: "external_relationship", part: name, target: relation.getAttribute("Target") });
        continue;
      }
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(source), relation.getAttribute("Target"))).replace(/^\//, "");
      if (target.startsWith("../") || !files.has(target)) errors.push({ code: "missing_relationship_target", part: name, target, message: `Relationship target is missing: ${target}` });
    }
  }
  const workbook = documents.get("xl/workbook.xml");
  if (workbook) {
    const ids = new Set();
    for (const sheet of descendants(workbook.documentElement, "sheet")) {
      const id = sheet.getAttribute("sheetId");
      if (ids.has(id)) errors.push({ code: "duplicate_sheet_id", part: "xl/workbook.xml", id, message: `Duplicate sheetId ${id}` });
      ids.add(id);
    }
  }
  return { ok: errors.length === 0, checker: "xlsx.ooxml", input: path.resolve(input), parts: files.size, errors, warnings };
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage);
    process.exit(0);
  }
  const report = await check(options.input);
  if (options.json) console.log(JSON.stringify(report));
  else {
    console.log(`${report.ok ? "ok" : "failed"}: ${report.parts} parts`);
    for (const error of report.errors) console.error(`${error.code}: ${error.message}`);
  }
  process.exitCode = report.ok ? 0 : 1;
} catch (error) {
  const report = { ok: false, checker: "xlsx.ooxml", errors: [{ code: "input_error", message: error.message }], warnings: [] };
  if (options?.json) console.log(JSON.stringify(report));
  else console.error(error.message);
  process.exitCode = 2;
}
