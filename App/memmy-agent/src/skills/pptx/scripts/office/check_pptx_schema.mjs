#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_ROOT = path.resolve(SCRIPT_DIR, "../../schemas");
const usage = `Usage: check_pptx_schema.mjs --input <deck.pptx|directory> [--json]
       check_pptx_schema.mjs <deck.pptx|directory> [--json]`;

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
  const doc = new DOMParser({ errorHandler: { warning() {}, error(message) { issue = message; }, fatalError(message) { issue = message; } } }).parseFromString(bytes.toString("utf8"), "application/xml");
  if (issue || !doc?.documentElement) throw new Error(`${name}: invalid XML`);
  return doc;
}

async function readPackage(input) {
  const stat = await fs.stat(input).catch(() => null);
  if (!stat) throw new Error(`Input does not exist: ${input}`);
  if (stat.isDirectory()) return fs.readFile(path.join(input, "ppt/presentation.xml"));
  const zip = await JSZip.loadAsync(await fs.readFile(input), { checkCRC32: true });
  const entry = zip.file("ppt/presentation.xml");
  if (!entry) throw new Error("ppt/presentation.xml is missing");
  return entry.async("nodebuffer");
}

async function check(input) {
  const errors = [];
  const warnings = [];
  const manifestPath = path.join(SCHEMA_ROOT, "SCHEMA-MANIFEST.json");
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch (error) {
    errors.push({ code: "schema_manifest_missing", part: manifestPath, message: error.message });
  }
  if (manifest) {
    if (!manifest.root || !Array.isArray(manifest.files) || !manifest.files.includes(manifest.root)) errors.push({ code: "schema_manifest_invalid", part: manifestPath, message: "Manifest must list a root and include it in files" });
    for (const relative of manifest.files ?? []) {
      if (!relative || path.posix.normalize(relative) !== relative || relative.startsWith("../") || path.isAbsolute(relative)) {
        errors.push({ code: "schema_path_invalid", part: relative, message: `Schema path is unsafe: ${relative}` });
        continue;
      }
      const file = path.join(SCHEMA_ROOT, relative);
      const bytes = await fs.readFile(file).catch(() => null);
      if (!bytes) {
        errors.push({ code: "schema_file_missing", part: relative, message: `Schema file is missing: ${relative}` });
        continue;
      }
      try {
        parseXml(bytes, relative);
      } catch (error) {
        errors.push({ code: "schema_xml_invalid", part: relative, message: error.message });
      }
      const expected = manifest.sha256?.[relative];
      const actual = crypto.createHash("sha256").update(bytes).digest("hex");
      if (!expected || expected !== actual) errors.push({ code: "schema_hash_mismatch", part: relative, expected: expected ?? null, actual, message: `Schema hash mismatch: ${relative}` });
    }
  }
  try {
    const presentation = parseXml(await readPackage(input), "ppt/presentation.xml").documentElement;
    const namespace = presentation.namespaceURI || "";
    const local = presentation.localName || presentation.nodeName.split(":").pop();
    if (local !== "presentation" || namespace !== "http://schemas.openxmlformats.org/presentationml/2006/main") errors.push({ code: "presentation_schema_root", part: "ppt/presentation.xml", message: "Root is not a PresentationML presentation element" });
  } catch (error) {
    errors.push({ code: "presentation_schema_input", part: "ppt/presentation.xml", message: error.message });
  }
  return { ok: errors.length === 0, checker: "pptx.schema", input: path.resolve(input), schemaRoot: path.resolve(SCHEMA_ROOT), schemaValidated: errors.length === 0, errors, warnings };
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
    console.log(`${report.ok ? "ok" : "failed"}: PresentationML schema resources checked`);
    for (const error of report.errors) console.error(`${error.code}: ${error.message}`);
  }
  process.exitCode = report.ok ? 0 : 1;
} catch (error) {
  const report = { ok: false, checker: "pptx.schema", errors: [{ code: "input_error", message: error.message }], warnings: [] };
  if (options?.json) console.log(JSON.stringify(report));
  else console.error(error.message);
  process.exitCode = 2;
}
