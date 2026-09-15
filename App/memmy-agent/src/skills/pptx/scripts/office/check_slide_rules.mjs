#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";

const usage = `Usage: check_slide_rules.mjs --input <deck.pptx|directory> [--json]
       check_slide_rules.mjs <deck.pptx|directory> [--json]`;

function args(argv) {
  const out = { input: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--json") out.json = true;
    else if (arg === "--input" || arg === "-i") out.input = argv[++i];
    else if (!arg.startsWith("-") && !out.input) out.input = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!out.input) throw new Error("Missing input");
  return out;
}

function xml(bytes, name) {
  let issue = "";
  const doc = new DOMParser({ errorHandler: { warning() {}, error(message) { issue = message; }, fatalError(message) { issue = message; } } }).parseFromString(bytes.toString("utf8"), "application/xml");
  if (issue || !doc?.documentElement) throw new Error(`${name}: invalid XML`);
  return doc;
}

async function filesAt(input) {
  const stat = await fs.stat(input).catch(() => null);
  if (!stat) throw new Error(`Input does not exist: ${input}`);
  if (stat.isDirectory()) {
    const map = new Map();
    const visit = async (dir) => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
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

async function check(input) {
  const files = await filesAt(input);
  const errors = [];
  const warnings = [];
  const presentation = files.get("ppt/presentation.xml");
  if (!presentation) errors.push({ code: "missing_presentation", part: "ppt/presentation.xml", message: "Presentation XML is missing" });
  const slideNames = [...files.keys()].filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name)).sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]));
  if (slideNames.length === 0) errors.push({ code: "no_slides", part: "ppt/slides", message: "No slide XML parts found" });
  const declared = new Set();
  if (presentation) {
    try {
      const doc = xml(presentation, "ppt/presentation.xml");
      for (const node of descendants(doc.documentElement, "sldId")) {
        const id = node.getAttribute("id");
        if (declared.has(id)) errors.push({ code: "duplicate_slide_id", part: "ppt/presentation.xml", id, message: `Duplicate slide id ${id}` });
        declared.add(id);
        const relation = node.getAttribute("r:id") || node.getAttributeNS?.("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") || "";
        if (!relation) errors.push({ code: "missing_slide_relationship", part: "ppt/presentation.xml", id, message: `Slide ${id} has no relationship id` });
      }
    } catch (error) {
      errors.push({ code: "invalid_presentation_xml", part: "ppt/presentation.xml", message: error.message });
    }
  }
  for (const name of slideNames) {
    try {
      const doc = xml(files.get(name), name);
      const root = doc.documentElement;
      const rootName = root.localName || root.nodeName.split(":").pop();
      if (rootName !== "sld") errors.push({ code: "invalid_slide_root", part: name, message: `Expected p:sld root, found ${rootName}` });
      if (descendants(root, "cSld").length === 0) errors.push({ code: "missing_common_slide_data", part: name, message: "Slide has no p:cSld" });
      if (descendants(root, "spTree").length === 0) errors.push({ code: "missing_shape_tree", part: name, message: "Slide has no p:spTree" });
      for (const placeholder of descendants(root, "ph")) {
        if (!placeholder.getAttribute("type") && !placeholder.getAttribute("idx")) warnings.push({ code: "unidentified_placeholder", part: name, message: "Placeholder has neither type nor idx" });
      }
      const text = descendants(root, "t").map((node) => node.textContent || "").join(" ");
      if (/(?:xxx|lorem|ipsum|todo|\[insert)/i.test(text)) errors.push({ code: "placeholder_text", part: name, message: "Slide contains unresolved placeholder text" });
      if (root.getAttribute("show") === "0" || root.getAttribute("show") === "false") warnings.push({ code: "hidden_slide", part: name, message: "Slide is hidden" });
    } catch (error) {
      errors.push({ code: "invalid_slide_xml", part: name, message: error.message });
    }
  }
  return { ok: errors.length === 0, checker: "pptx.slides", input: path.resolve(input), slideCount: slideNames.length, errors, warnings };
}

let options;
try {
  options = args(process.argv.slice(2));
  if (options.help) {
    console.log(usage);
    process.exit(0);
  }
  const report = await check(options.input);
  if (options.json) console.log(JSON.stringify(report));
  else {
    console.log(`${report.ok ? "ok" : "failed"}: ${report.slideCount} slides`);
    for (const error of report.errors) console.error(`${error.code}: ${error.message}`);
  }
  process.exitCode = report.ok ? 0 : 1;
} catch (error) {
  const report = { ok: false, checker: "pptx.slides", errors: [{ code: "input_error", message: error.message }], warnings: [] };
  if (options?.json) console.log(JSON.stringify(report));
  else console.error(error.message);
  process.exitCode = 2;
}
