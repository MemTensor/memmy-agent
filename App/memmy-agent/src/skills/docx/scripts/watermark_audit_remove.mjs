#!/usr/bin/env node
import fs from "node:fs/promises";
import JSZip from "jszip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

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
  let value = new XMLSerializer().serializeToString(doc);
  if (!value.startsWith("<?xml"))
    value = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + value;
  return Buffer.from(value);
}
function localName(node) {
  return node?.localName || node?.nodeName?.split(":").pop();
}
function descendants(root, name) {
  const out = [];
  const visit = (node) => {
    for (let child = node?.firstChild; child; child = child.nextSibling) {
      if (child.nodeType !== 1) continue;
      if (!name || localName(child) === name) out.push(child);
      visit(child);
    }
  };
  visit(root);
  return out;
}
function parts(zip) {
  return [
    "word/document.xml",
    ...Object.keys(zip.files).filter((name) => /^word\/(?:header|footer)\d+\.xml$/.test(name)),
  ].sort();
}
function scan(root) {
  const hits = [];
  for (const node of descendants(root, "textpath")) {
    const text = node.getAttribute("string") || "";
    if (text.trim()) hits.push({ kind: "vml_textpath", text: text.trim() });
  }
  for (const node of descendants(root))
    for (const attribute of Array.from(node.attributes || []))
      if (attribute.value.toLowerCase().includes("watermark")) {
        hits.push({ kind: "attr_watermark", text: attribute.value });
        break;
      }
  return hits;
}
async function main() {
  const invocationArgs = process.argv.slice(2);
  if (invocationArgs.includes("--help") || invocationArgs.includes("-h")) {
    process.stdout.write(
      [
        "usage: watermark_audit_remove.mjs [-h] --mode {report,remove}",
        "                                 [--contains CONTAINS] [--out OUT]",
        "                                 in_docx",
        "",
        "positional arguments:",
        "  in_docx",
        "",
        "options:",
        "  -h, --help            show this help message and exit",
        "  --mode {report,remove}",
        "  --contains CONTAINS   Substring to match for removal",
        "  --out OUT             Output docx for remove",
        "",
      ].join("\n"),
    );
    return;
  }
  if (invocationArgs.length === 0) {
    process.stderr.write(
      [
        "usage: watermark_audit_remove.mjs [-h] --mode {report,remove}",
        "                                 [--contains CONTAINS] [--out OUT]",
        "                                 in_docx",
        "watermark_audit_remove.mjs: error: the following arguments are required: in_docx, --mode",
        "",
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }
  const args = process.argv.slice(2);
  const input = args[0];
  let mode = null,
    contains = null,
    output = null;
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === "--mode") mode = args[++i];
    else if (args[i] === "--contains") contains = args[++i];
    else if (args[i] === "--out") output = args[++i];
    else {
      console.error(`unknown argument: ${args[i]}`);
      process.exitCode = 2;
      return;
    }
  }
  if (!input || !["report", "remove"].includes(mode)) {
    console.error(
      "usage: watermark_audit_remove.mjs input.docx --mode report|remove [--contains TEXT --out out.docx]",
    );
    process.exitCode = 2;
    return;
  }
  const zip = await JSZip.loadAsync(await fs.readFile(input));
  if (mode === "report") {
    let total = 0;
    for (const name of parts(zip)) {
      const entry = zip.file(name);
      if (!entry) continue;
      const hits = scan(parseXml(await entry.async("nodebuffer")).documentElement);
      if (hits.length) {
        console.log(`[${name}]`);
        for (const hit of hits.slice(0, 50)) console.log(`  - ${hit.kind}: ${hit.text}`);
        total += hits.length;
      }
    }
    console.log(`[summary] watermark_like_hits=${total}`);
    return;
  }
  if (!contains || !output) {
    console.error("--contains and --out are required when --mode remove");
    process.exitCode = 2;
    return;
  }
  const needle = contains.toLowerCase();
  const overrides = new Map();
  for (const name of parts(zip)) {
    const entry = zip.file(name);
    if (!entry) continue;
    const doc = parseXml(await entry.async("nodebuffer"));
    let changed = false;
    for (const pict of descendants(doc.documentElement, "pict")) {
      const hit = descendants(pict, "textpath").some((node) =>
        (node.getAttribute("string") || "").toLowerCase().includes(needle),
      );
      if (hit) {
        pict.parentNode?.removeChild(pict);
        changed = true;
      }
    }
    if (changed) overrides.set(name, xmlBytes(doc));
  }
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
  console.log(`[OK] wrote ${output}`);
}
main().catch((error) => {
  console.error(`[ERROR] ${error.message}`);
  process.exitCode = 2;
});
