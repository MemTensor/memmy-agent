#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";

const usage = `Usage: check_theme_rules.mjs --input <deck.pptx|directory> [--json]
       check_theme_rules.mjs <deck.pptx|directory> [--json]`;

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
  let error = "";
  const doc = new DOMParser({ errorHandler: { warning() {}, error(message) { error = message; }, fatalError(message) { error = message; } } }).parseFromString(bytes.toString("utf8"), "application/xml");
  if (error || !doc?.documentElement) throw new Error(`${name}: invalid XML`);
  return doc;
}

async function readFiles(input) {
  const stat = await fs.stat(input).catch(() => null);
  if (!stat) throw new Error(`Input does not exist: ${input}`);
  if (stat.isDirectory()) {
    const map = new Map();
    const walk = async (dir) => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(file);
        else map.set(path.relative(input, file).split(path.sep).join("/"), await fs.readFile(file));
      }
    };
    await walk(input);
    return map;
  }
  const zip = await JSZip.loadAsync(await fs.readFile(input), { checkCRC32: true });
  const map = new Map();
  for (const [name, entry] of Object.entries(zip.files)) if (!entry.dir) map.set(path.posix.normalize(name), await entry.async("nodebuffer"));
  return map;
}

function local(node) {
  return node?.localName || node?.nodeName?.split(":").pop() || "";
}

function descendants(root, wanted) {
  const out = [];
  const visit = (node) => {
    for (let child = node?.firstChild; child; child = child.nextSibling) {
      if (child.nodeType !== 1) continue;
      if (!wanted || local(child) === wanted) out.push(child);
      visit(child);
    }
  };
  visit(root);
  return out;
}

function relSource(name) {
  if (name === "_rels/.rels") return "";
  const marker = "/_rels/";
  const index = name.lastIndexOf(marker);
  return index < 0 ? null : `${name.slice(0, index)}/${name.slice(index + marker.length, -5)}`;
}

async function check(input) {
  const files = await readFiles(input);
  const errors = [];
  const warnings = [];
  const rels = files.get("ppt/_rels/presentation.xml.rels");
  if (!rels) errors.push({ code: "missing_presentation_relationships", part: "ppt/_rels/presentation.xml.rels", message: "Presentation relationships are missing" });
  const expectedTargets = new Set();
  if (rels) {
    try {
      const doc = parseXml(rels, "ppt/_rels/presentation.xml.rels");
      for (const node of descendants(doc.documentElement, "Relationship")) {
        const type = node.getAttribute("Type");
        const target = node.getAttribute("Target");
        if (!target || String(node.getAttribute("TargetMode")).toLowerCase() === "external") continue;
        const source = relSource("ppt/_rels/presentation.xml.rels");
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(source), target));
        expectedTargets.add(resolved);
        if (/slideLayout|slideMaster|theme/i.test(type) && !files.has(resolved)) errors.push({ code: "missing_theme_chain_part", part: "ppt/_rels/presentation.xml.rels", target: resolved, message: `Theme chain target is missing: ${resolved}` });
      }
    } catch (error) {
      errors.push({ code: "invalid_relationships", part: "ppt/_rels/presentation.xml.rels", message: error.message });
    }
  }
  const types = files.get("[Content_Types].xml");
  if (types) {
    try {
      const doc = parseXml(types, "[Content_Types].xml");
      for (const part of expectedTargets) {
        if (!/slideLayout|slideMaster|theme/i.test(part)) continue;
        const override = descendants(doc.documentElement, "Override").find((node) => path.posix.normalize(node.getAttribute("PartName").replace(/^\//, "")) === part);
        if (!override) warnings.push({ code: "missing_explicit_content_type", part, message: `Theme-chain part has no explicit content type: ${part}` });
      }
    } catch (error) {
      errors.push({ code: "invalid_content_types", part: "[Content_Types].xml", message: error.message });
    }
  } else errors.push({ code: "missing_content_types", part: "[Content_Types].xml", message: "Content types part is missing" });
  return { ok: errors.length === 0, checker: "pptx.theme", input: path.resolve(input), errors, warnings };
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
    console.log(`${report.ok ? "ok" : "failed"}: theme chain checked`);
    for (const error of report.errors) console.error(`${error.code}: ${error.message}`);
  }
  process.exitCode = report.ok ? 0 : 1;
} catch (error) {
  const report = { ok: false, checker: "pptx.theme", errors: [{ code: "input_error", message: error.message }], warnings: [] };
  if (options?.json) console.log(JSON.stringify(report));
  else console.error(error.message);
  process.exitCode = 2;
}
