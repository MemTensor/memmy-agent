#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";

const usage = `Usage: check_drawing_rules.mjs --input <workbook.xlsx|xlsm|xltx|directory> [--json]
       check_drawing_rules.mjs <workbook>`;

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

function nodes(root, wanted) {
  const result = [];
  const visit = (node) => {
    for (let child = node?.firstChild; child; child = child.nextSibling) {
      if (child.nodeType !== 1) continue;
      const local = child.localName || child.nodeName.split(":").pop();
      if (local === wanted) result.push(child);
      visit(child);
    }
  };
  visit(root);
  return result;
}

async function filesOf(input) {
  const stat = await fs.stat(input).catch(() => null);
  if (!stat) throw new Error(`Input does not exist: ${input}`);
  if (stat.isDirectory()) {
    const map = new Map();
    const visit = async (directory) => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(file);
        else map.set(path.relative(input, file).split(path.sep).join("/"), await fs.readFile(file));
      }
    };
    await visit(input);
    return map;
  }
  const zip = await JSZip.loadAsync(await fs.readFile(input), { checkCRC32: true });
  const map = new Map();
  for (const [name, entry] of Object.entries(zip.files)) if (!entry.dir) map.set(path.posix.normalize(name), await entry.async("nodebuffer"));
  return map;
}

function relationshipSource(name) {
  const marker = "/_rels/";
  const index = name.lastIndexOf(marker);
  return index < 0 ? null : `${name.slice(0, index)}/${name.slice(index + marker.length, -5)}`;
}

async function check(options) {
  const files = await filesOf(options.input);
  const errors = [];
  const warnings = [];
  const drawings = [...files.keys()].filter((name) => /^xl\/drawings\/[^/]+\.xml$/i.test(name));
  for (const name of drawings) {
    try {
      const root = parseXml(files.get(name), name).documentElement;
      const anchors = [...nodes(root, "twoCellAnchor"), ...nodes(root, "oneCellAnchor"), ...nodes(root, "absoluteAnchor")];
      for (const anchor of anchors) {
        if (nodes(anchor, "from").length === 0 && !["absoluteAnchor"].includes(anchor.localName || anchor.nodeName.split(":").pop())) errors.push({ code: "drawing_anchor_missing", part: name, message: "Drawing anchor has no from position" });
        if (nodes(anchor, "pic").length === 0 && nodes(anchor, "graphicFrame").length === 0 && nodes(anchor, "sp").length === 0) warnings.push({ code: "empty_drawing_anchor", part: name, message: "Drawing anchor has no recognized object" });
      }
      const relsName = `${path.posix.dirname(name)}/_rels/${path.posix.basename(name)}.rels`;
      if (files.has(relsName)) {
        const rels = parseXml(files.get(relsName), relsName);
        const source = relationshipSource(relsName) || name;
        for (const relation of nodes(rels.documentElement, "Relationship")) {
          if (String(relation.getAttribute("TargetMode")).toLowerCase() === "external") { warnings.push({ code: "external_drawing_relationship", part: relsName, target: relation.getAttribute("Target") }); continue; }
          const target = path.posix.normalize(path.posix.join(path.posix.dirname(source), relation.getAttribute("Target"))).replace(/^\//, "");
          if (!files.has(target)) errors.push({ code: "drawing_relationship_missing", part: relsName, target, message: `Drawing relationship target is missing: ${target}` });
        }
      }
    } catch (error) {
      errors.push({ code: "invalid_drawing_xml", part: name, message: error.message });
    }
  }
  return { ok: errors.length === 0, checker: "xlsx.drawings", input: path.resolve(options.input), drawingCount: drawings.length, errors, warnings };
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(usage); process.exit(0); }
  const report = await check(options);
  if (options.json) console.log(JSON.stringify(report)); else console.log(`${report.ok ? "ok" : "failed"}: ${report.drawingCount} drawing parts`);
  process.exitCode = report.ok ? 0 : 1;
} catch (error) {
  const report = { ok: false, checker: "xlsx.drawings", errors: [{ code: "input_error", message: error.message }], warnings: [] };
  if (options?.json) console.log(JSON.stringify(report)); else console.error(error.message);
  process.exitCode = 2;
}
