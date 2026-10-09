#!/usr/bin/env node
import fs from "node:fs/promises";
import JSZip from "jszip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
function parseXml(bytes) {
  return new DOMParser({
    errorHandler: {
      warning() {},
      error(message) {
        throw new Error(message);
      },
      fatalError(message) {
        throw new Error(message);
      },
    },
  }).parseFromString(Buffer.from(bytes).toString("utf8"), "application/xml");
}
function xmlBytes(doc) {
  let text = new XMLSerializer().serializeToString(doc);
  if (!text.startsWith("<?xml"))
    text = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + text;
  return Buffer.from(text);
}
function localName(node) {
  return node?.localName || node?.nodeName?.split(":").pop();
}
function descendants(root, name) {
  const result = [];
  const visit = (node) => {
    for (let child = node?.firstChild; child; child = child.nextSibling) {
      if (child.nodeType !== 1) continue;
      if (!name || localName(child) === name) result.push(child);
      visit(child);
    }
  };
  visit(root);
  return result;
}
function children(root, name) {
  const result = [];
  for (let child = root?.firstChild; child; child = child.nextSibling)
    if (child.nodeType === 1 && (!name || localName(child) === name)) result.push(child);
  return result;
}
function create(doc, name) {
  return doc.createElementNS(W_NS, `w:${name}`);
}
function attr(node, name) {
  return node?.getAttributeNS(W_NS, name) || node?.getAttribute(`w:${name}`) || "";
}
function unwrap(element) {
  const parent = element.parentNode;
  if (!parent) return;
  const childrenToMove = [...children(element)];
  for (const child of childrenToMove) parent.insertBefore(child, element);
  parent.removeChild(element);
}
function countRevisions(root) {
  return {
    ins: descendants(root, "ins").length,
    del: descendants(root, "del").length,
    moveTo: descendants(root, "moveTo").length,
    moveFrom: descendants(root, "moveFrom").length,
  };
}
function removeChildren(element, predicate) {
  for (const child of [...children(element)]) if (predicate(child)) element.removeChild(child);
}
function applyMode(root, mode) {
  for (const tag of ["moveTo", "moveFrom", "ins", "del"]) {
    const elements = descendants(root, tag).reverse();
    for (const element of elements) {
      const insertion = tag === "moveTo" || tag === "ins";
      const keep = mode === "accept" ? insertion : !insertion;
      if (keep) unwrap(element);
      else element.parentNode?.removeChild(element);
    }
  }
}
function disableTracking(root) {
  let changed = false;
  for (const node of descendants(root, "trackRevisions")) {
    node.parentNode?.removeChild(node);
    changed = true;
  }
  return changed;
}
async function loadZip(file) {
  return JSZip.loadAsync(await fs.readFile(file));
}
async function writeZip(zip, output, overrides) {
  const out = new JSZip();
  for (const [name, entry] of Object.entries(zip.files))
    out.file(name, overrides.has(name) ? overrides.get(name) : await entry.async("nodebuffer"), {
      binary: true,
      createFolders: false,
      date: entry.date,
      unixPermissions: entry.unixPermissions,
    });
  await fs.writeFile(
    output,
    await out.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
  );
}
async function main() {
  const invocationArgs = process.argv.slice(2);
  if (invocationArgs.includes("--help") || invocationArgs.includes("-h")) {
    process.stdout.write(
      [
        "usage: accept_tracked_changes.mjs [-h] --mode {report,accept,reject}",
        "                                 [--out OUT] [--keep_tracking_on]",
        "                                 in_docx",
        "",
        "positional arguments:",
        "  in_docx",
        "",
        "options:",
        "  -h, --help            show this help message and exit",
        "  --mode {report,accept,reject}",
        "  --out OUT             Output DOCX (required for accept/reject)",
        "  --keep_tracking_on    Do not remove trackRevisions from settings.xml",
        "",
      ].join("\n"),
    );
    return;
  }
  if (invocationArgs.length === 0) {
    process.stderr.write(
      [
        "usage: accept_tracked_changes.mjs [-h] --mode {report,accept,reject}",
        "                                 [--out OUT] [--keep_tracking_on]",
        "                                 in_docx",
        "accept_tracked_changes.mjs: error: the following arguments are required: in_docx, --mode",
        "",
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }
  const args = process.argv.slice(2);
  const input = args[0];
  let mode = null,
    output = null,
    keepTracking = false;
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === "--mode") mode = args[++i];
    else if (args[i] === "--out") output = args[++i];
    else if (args[i] === "--keep_tracking_on") keepTracking = true;
    else {
      console.error(`unknown argument: ${args[i]}`);
      process.exitCode = 2;
      return;
    }
  }
  if (!input || !["report", "accept", "reject"].includes(mode)) {
    console.error(
      "usage: accept_tracked_changes.mjs in.docx --mode <report|accept|reject> [--out out.docx]",
    );
    process.exitCode = 2;
    return;
  }
  const zip = await loadZip(input);
  const documentEntry = zip.file("word/document.xml");
  if (!documentEntry) throw new Error("word/document.xml is missing");
  const root = parseXml(await documentEntry.async("nodebuffer"));
  const before = countRevisions(root);
  console.log(
    `[report] ins=${before.ins} del=${before.del} moveTo=${before.moveTo} moveFrom=${before.moveFrom}`,
  );
  if (mode === "report") return;
  if (!output) {
    console.error("--out is required for accept/reject");
    process.exitCode = 2;
    return;
  }
  applyMode(root, mode);
  let settingsBytes = null;
  if (!keepTracking) {
    const settings = zip.file("word/settings.xml");
    if (settings) {
      const settingsRoot = parseXml(await settings.async("nodebuffer"));
      if (disableTracking(settingsRoot)) settingsBytes = xmlBytes(settingsRoot);
    }
  }
  const after = countRevisions(root);
  console.log(
    `[after]  ins=${after.ins} del=${after.del} moveTo=${after.moveTo} moveFrom=${after.moveFrom}`,
  );
  const overrides = new Map([["word/document.xml", xmlBytes(root)]]);
  if (settingsBytes) overrides.set("word/settings.xml", settingsBytes);
  await writeZip(zip, output, overrides);
  console.log(`[OK] wrote ${output}`);
}
main().catch((error) => {
  console.error(`[ERROR] ${error.message}`);
  process.exitCode = 2;
});
