#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";

const usage = `Usage: prune_orphans.mjs --input <unpacked-dir|deck.pptx> [--output <deck.pptx>] [--json]
       prune_orphans.mjs <unpacked-dir|deck.pptx>`;

function parseArgs(argv) {
  const result = { input: null, output: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--json") result.json = true;
    else if (arg === "--input" || arg === "-i") result.input = argv[++i];
    else if (arg === "--output" || arg === "-o") result.output = argv[++i];
    else if (!arg.startsWith("-") && !result.input) result.input = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!result.input) throw new Error("Missing input");
  return result;
}

async function load(input) {
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
    return { files: map, directory: true };
  }
  const zip = await JSZip.loadAsync(await fs.readFile(input), { checkCRC32: true });
  const map = new Map();
  for (const [name, entry] of Object.entries(zip.files)) if (!entry.dir) map.set(path.posix.normalize(name), await entry.async("nodebuffer"));
  return { files: map, directory: false };
}

function parseXml(bytes, name) {
  let issue = "";
  const doc = new DOMParser({ errorHandler: { warning() {}, error(message) { issue = message; }, fatalError(message) { issue = message; } } }).parseFromString(bytes.toString("utf8"), "application/xml");
  if (issue || !doc?.documentElement) throw new Error(`${name}: invalid XML`);
  return doc;
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

function relsFor(part) {
  const directory = path.posix.dirname(part);
  const base = path.posix.basename(part);
  return directory === "." ? `_rels/${base}.rels` : `${directory}/_rels/${base}.rels`;
}

function relationshipSource(rels) {
  if (rels === "_rels/.rels") return "";
  const marker = "/_rels/";
  const index = rels.lastIndexOf(marker);
  return index < 0 ? null : `${rels.slice(0, index)}/${rels.slice(index + marker.length, -5)}`;
}

function resolve(source, target) {
  if (!target || target.includes("://") || target.startsWith("/")) return null;
  return path.posix.normalize(path.posix.join(path.posix.dirname(source), target)).replace(/^\//, "");
}

function relationshipMap(files, relationshipPart) {
  const bytes = files.get(relationshipPart);
  if (!bytes) return [];
  const doc = parseXml(bytes, relationshipPart);
  const source = relationshipSource(relationshipPart) || "";
  return descendants(doc.documentElement, "Relationship").map((node) => ({ id: node.getAttribute("Id"), target: resolve(source, node.getAttribute("Target")), external: String(node.getAttribute("TargetMode")).toLowerCase() === "external" }));
}

async function save(loaded, input, output) {
  if (loaded.directory && !output) {
    for (const [name, bytes] of loaded.files) {
      const target = path.join(input, ...name.split("/"));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes);
    }
    return input;
  }
  const destination = output || input;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const zip = new JSZip();
  for (const [name, bytes] of loaded.files) zip.file(name, bytes);
  const temporary = `${destination}.tmp-${process.pid}`;
  await fs.writeFile(temporary, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  await fs.rename(temporary, destination);
  return destination;
}

async function prune(options) {
  const loaded = await load(options.input);
  const files = loaded.files;
  const errors = [];
  const presentationBytes = files.get("ppt/presentation.xml");
  if (!presentationBytes) throw new Error("ppt/presentation.xml is missing");
  const presentation = parseXml(presentationBytes, "ppt/presentation.xml");
  const presentationRels = relationshipMap(files, "ppt/_rels/presentation.xml.rels");
  const relationById = new Map(presentationRels.map((relation) => [relation.id, relation.target]));
  const retainedSlides = new Set();
  for (const slide of descendants(presentation.documentElement, "sldId")) {
    const id = slide.getAttribute("r:id") || slide.getAttributeNS?.("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
    const target = relationById.get(id);
    if (target) retainedSlides.add(target);
    else errors.push({ code: "missing_slide_relationship", part: "ppt/presentation.xml", id, message: `Slide relationship ${id} is missing` });
  }
  const reachable = new Set(["ppt/presentation.xml", "ppt/_rels/presentation.xml.rels", "[Content_Types].xml"]);
  const queue = [...retainedSlides];
  while (queue.length) {
    const part = queue.shift();
    if (!part || reachable.has(part) || !files.has(part)) continue;
    reachable.add(part);
    const relPart = relsFor(part);
    if (files.has(relPart)) {
      reachable.add(relPart);
      for (const relation of relationshipMap(files, relPart)) if (!relation.external && relation.target && !reachable.has(relation.target)) queue.push(relation.target);
    }
  }
  const removed = [];
  for (const name of [...files.keys()]) {
    if (/^ppt\/slides\/slide\d+\.xml$/i.test(name) && !reachable.has(name)) {
      files.delete(name);
      files.delete(relsFor(name));
      removed.push(name);
    }
    if (/^ppt\/media\//i.test(name) && !reachable.has(name)) {
      files.delete(name);
      removed.push(name);
    }
  }
  const contentTypes = files.get("[Content_Types].xml");
  if (contentTypes) {
    let text = contentTypes.toString("utf8");
    for (const name of removed) text = text.replace(new RegExp(`\\s*<Override\\b[^>]*PartName=["']/${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}['"][^>]*/>`, "gi"), "");
    files.set("[Content_Types].xml", Buffer.from(text));
  }
  const destination = await save(loaded, options.input, options.output);
  return { ok: errors.length === 0, removed, retainedSlides: [...retainedSlides].sort(), output: path.resolve(destination), errors };
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage);
    process.exit(0);
  }
  const report = await prune(options);
  if (options.json) console.log(JSON.stringify({ checker: "pptx.prune", ...report }));
  else console.log(`${report.ok ? "ok" : "failed"}: removed ${report.removed.length} orphan parts`);
  process.exitCode = report.ok ? 0 : 1;
} catch (error) {
  const report = { checker: "pptx.prune", ok: false, errors: [{ code: "input_error", message: error.message }] };
  if (options?.json) console.log(JSON.stringify(report));
  else console.error(error.message);
  process.exitCode = 2;
}
