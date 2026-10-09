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
function children(root) {
  return [...(root?.childNodes ? Array.from(root.childNodes) : [])].filter(
    (node) => node.nodeType === 1,
  );
}
function create(doc, name) {
  return doc.createElementNS(W_NS, `w:${name}`);
}
function wAttr(node, name) {
  return node?.getAttributeNS(W_NS, name) || node?.getAttribute(`w:${name}`) || "";
}
function setWAttr(node, name, value) {
  node.setAttributeNS(W_NS, `w:${name}`, String(value));
}
function clone(node) {
  return node.cloneNode(true);
}
function nowUtc() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
function makeChange(doc, kind, text, id, when) {
  const wrapper = create(doc, kind);
  setWAttr(wrapper, "id", id);
  setWAttr(wrapper, "date", when);
  const run = create(doc, "r");
  const textNode = create(doc, kind === "del" ? "delText" : "t");
  textNode.appendChild(doc.createTextNode(text));
  run.appendChild(textNode);
  wrapper.appendChild(run);
  return wrapper;
}
function nextChangeId(root) {
  const ids = descendants(root)
    .map((node) => Number(wAttr(node, "id")))
    .filter(Number.isInteger);
  return ids.length ? Math.max(...ids) + 1 : 1;
}
function replaceTextNode(tNode, oldText, newText, startId, when) {
  const text = tNode.textContent || "";
  const index = text.indexOf(oldText);
  if (index < 0 || !tNode.parentNode?.parentNode) return { nextId: startId, changed: false };
  const run = tNode.parentNode;
  const parent = run.parentNode;
  const before = text.slice(0, index);
  const after = text.slice(index + oldText.length);
  const nodes = [];
  const makeRun = (value) => {
    const r = create(tNode.ownerDocument, "r");
    const rPr = children(run).find((node) => localName(node) === "rPr");
    if (rPr) r.appendChild(clone(rPr));
    const t = create(tNode.ownerDocument, "t");
    t.appendChild(tNode.ownerDocument.createTextNode(value));
    r.appendChild(t);
    return r;
  };
  if (before) nodes.push(makeRun(before));
  nodes.push(makeChange(tNode.ownerDocument, "del", oldText, startId, when));
  nodes.push(makeChange(tNode.ownerDocument, "ins", newText, startId + 1, when));
  if (after) nodes.push(makeRun(after));
  for (const node of nodes) parent.insertBefore(node, run);
  parent.removeChild(run);
  return { nextId: startId + 2, changed: true };
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
  for (const [name, data] of overrides)
    if (!zip.files[name]) out.file(name, data, { binary: true });
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
        "usage: add_tracked_replacements.mjs [-h] --out OUT [--replace REPLACE] in_docx",
        "",
        "Add tracked replacement edits (best-effort)",
        "",
        "positional arguments:",
        "  in_docx",
        "",
        "options:",
        "  -h, --help         show this help message and exit",
        "  --out OUT",
        "  --replace REPLACE  Replacement formatted as OLD=NEW (repeatable)",
        "",
      ].join("\n"),
    );
    return;
  }
  if (invocationArgs.length === 0) {
    process.stderr.write(
      [
        "usage: add_tracked_replacements.mjs [-h] --out OUT [--replace REPLACE] in_docx",
        "add_tracked_replacements.mjs: error: the following arguments are required: in_docx, --out",
        "",
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }
  const args = process.argv.slice(2);
  const input = args[0];
  let output = null;
  const replacements = [];
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === "--out") output = args[++i];
    else if (args[i] === "--replace") replacements.push(args[++i]);
    else {
      console.error(`unknown argument: ${args[i]}`);
      process.exitCode = 2;
      return;
    }
  }
  if (!input || !output) {
    console.error(
      "usage: add_tracked_replacements.mjs in.docx --out out.docx --replace OLD=NEW [--replace OLD=NEW ...]",
    );
    process.exitCode = 2;
    return;
  }
  if (!replacements.length) {
    console.error("Provide at least one --replace");
    process.exitCode = 2;
    return;
  }
  const pairs = replacements.map((value) => {
    const index = value.indexOf("=");
    if (index < 0) throw new Error("--replace must be formatted as OLD=NEW");
    return [value.slice(0, index), value.slice(index + 1)];
  });
  const zip = await loadZip(input);
  const docEntry = zip.file("word/document.xml");
  if (!docEntry) throw new Error("word/document.xml is missing");
  const doc = parseXml(await docEntry.async("nodebuffer"));
  const settingsEntry = zip.file("word/settings.xml");
  const settings = settingsEntry
    ? parseXml(await settingsEntry.async("nodebuffer"))
    : parseXml(`<?xml version="1.0"?><w:settings xmlns:w="${W_NS}"/>`);
  if (!descendants(settings, "trackRevisions").length)
    settings.documentElement.insertBefore(
      create(settings, "trackRevisions"),
      settings.documentElement.firstChild,
    );
  let id = nextChangeId(doc.documentElement);
  const when = nowUtc();
  let total = 0;
  for (const [oldText, newText] of pairs) {
    for (const node of descendants(doc.documentElement, "t")) {
      const result = replaceTextNode(node, oldText, newText, id, when);
      if (result.changed) {
        id = result.nextId;
        total += 1;
        break;
      }
    }
  }
  const overrides = new Map([
    ["word/document.xml", xmlBytes(doc)],
    ["word/settings.xml", xmlBytes(settings)],
  ]);
  await writeZip(zip, output, overrides);
  console.log(`[OK] wrote ${output} (replacements=${total})`);
}
main().catch((error) => {
  console.error(`[ERROR] ${error.message}`);
  process.exitCode = 2;
});
