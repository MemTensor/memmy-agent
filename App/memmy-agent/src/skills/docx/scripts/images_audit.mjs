#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";

const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const EMU_PER_INCH = 914400;
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
function attr(node, name, namespace = null) {
  return (
    node?.getAttributeNS(namespace, name) ||
    node?.getAttribute(`r:${name}`) ||
    node?.getAttribute(name) ||
    ""
  );
}
function inches(value) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n / EMU_PER_INCH : null;
}
function contentParts(zip) {
  return Object.keys(zip.files).filter(
    (name) => name.startsWith("word/") && /(?:document|header\d+|footer\d+)\.xml$/.test(name),
  );
}
async function relsMap(zip, part) {
  const name = `word/_rels/${path.basename(part)}.rels`;
  const entry = zip.file(name);
  if (!entry) return {};
  const root = parseXml(await entry.async("nodebuffer")).documentElement;
  return Object.fromEntries(
    descendants(root, "Relationship")
      .map((node) => [node.getAttribute("Id"), node.getAttribute("Target")])
      .filter(([id, target]) => id && target),
  );
}
async function main() {
  const invocationArgs = process.argv.slice(2);
  if (invocationArgs.includes("--help") || invocationArgs.includes("-h")) {
    process.stdout.write(
      [
        "usage: images_audit.mjs [-h] [--max_rows MAX_ROWS] docx",
        "",
        "Audit images in a DOCX (inline vs floating, sizes)",
        "",
        "positional arguments:",
        "  docx",
        "",
        "options:",
        "  -h, --help           show this help message and exit",
        "  --max_rows MAX_ROWS",
        "",
      ].join("\n"),
    );
    return;
  }
  if (invocationArgs.length === 0) {
    process.stderr.write(
      [
        "usage: images_audit.mjs [-h] [--max_rows MAX_ROWS] docx",
        "images_audit.mjs: error: the following arguments are required: docx",
        "",
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }
  const args = process.argv.slice(2);
  const input = args[0];
  let max = 50;
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === "--max_rows") max = Number(args[++i]);
    else {
      console.error(`unknown argument: ${args[i]}`);
      process.exitCode = 2;
      return;
    }
  }
  if (!input) {
    console.error("usage: images_audit.mjs input.docx [--max_rows 50]");
    process.exitCode = 2;
    return;
  }
  const zip = await JSZip.loadAsync(await fs.readFile(input));
  const rows = [];
  const counts = new Map();
  for (const part of contentParts(zip)) {
    const root = parseXml(await zip.file(part).async("nodebuffer")).documentElement;
    const rels = await relsMap(zip, part);
    for (const kind of ["inline", "anchor"])
      for (const element of descendants(root, kind)) {
        counts.set(kind, (counts.get(kind) || 0) + 1);
        const extent = descendants(element, "extent")[0];
        const width = inches(extent?.getAttribute("cx"));
        const height = inches(extent?.getAttribute("cy"));
        const blip = descendants(element, "blip")[0];
        const rid = attr(blip, "embed", R_NS);
        const target = rid ? rels[rid] || "" : "";
        const zipPath = target.startsWith("media/") ? `word/${target}` : "";
        const image =
          zipPath && zip.file(zipPath) ? await zip.file(zipPath).async("nodebuffer") : null;
        rows.push({
          part,
          kind,
          rId: rid,
          target,
          zip_path: zipPath,
          size_in:
            width != null && height != null
              ? `${width.toFixed(2)} x ${height.toFixed(2)}`
              : "(unknown)",
          bytes: image ? String(image.length) : "",
        });
      }
  }
  if (!rows.length) {
    console.log("No inline/anchored drawings found in document/header/footer parts.");
    return;
  }
  console.log("IMAGE KINDS");
  for (const [kind, count] of [...counts.entries()].sort((a, b) => b[1] - a[1]))
    console.log(`- ${kind}: ${count}`);
  console.log("\nROWS (part | kind | size | target)");
  for (const row of rows.slice(0, max))
    console.log(`- ${row.part} | ${row.kind} | ${row.size_in} | ${row.target}`);
  if (rows.length > max) console.log(`- ... (${rows.length - max} more)`);
  if ((counts.get("anchor") || 0) > 0) {
    console.log("\nWARNING");
    console.log(
      "- Floating/anchored images detected (wp:anchor). These are the most common Word-vs-LO mismatch.",
    );
    console.log("  Strongly recommend: render to PNG and check placement on every affected page.");
  }
}
main().catch((error) => {
  console.error(`[ERROR] ${error.message}`);
  process.exitCode = 2;
});
