#!/usr/bin/env node
import fs from "node:fs/promises";
import JSZip from "jszip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const COMMENT_REL_TYPES = new Set([
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments",
  "http://schemas.microsoft.com/office/2011/relationships/commentsExtended",
]);
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
function storyParts(zip) {
  return [
    "word/document.xml",
    ...Object.keys(zip.files).filter((name) => /^word\/(?:header|footer)\d+\.xml$/.test(name)),
  ];
}
async function main() {
  const invocationArgs = process.argv.slice(2);
  if (invocationArgs.includes("--help") || invocationArgs.includes("-h")) {
    process.stdout.write(
      [
        "usage: comments_strip.mjs [-h] --out OUT in_docx",
        "",
        "positional arguments:",
        "  in_docx",
        "",
        "options:",
        "  -h, --help  show this help message and exit",
        "  --out OUT",
        "",
      ].join("\n"),
    );
    return;
  }
  if (invocationArgs.length === 0) {
    process.stderr.write(
      [
        "usage: comments_strip.mjs [-h] --out OUT in_docx",
        "comments_strip.mjs: error: the following arguments are required: in_docx, --out",
        "",
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }
  const args = process.argv.slice(2);
  if (!args[0] || args[1] !== "--out" || !args[2]) {
    console.error("usage: comments_strip.mjs in.docx --out out.docx");
    process.exitCode = 2;
    return;
  }
  const input = args[0];
  const output = args[2];
  const zip = await JSZip.loadAsync(await fs.readFile(input));
  const overrides = new Map();
  const stats = {
    markup_removed: 0,
    comments_part_removed: 0,
    comments_extended_part_removed: 0,
    rels_updated: 0,
    content_types_updated: 0,
  };
  for (const name of storyParts(zip)) {
    const entry = zip.file(name);
    if (!entry) continue;
    const root = parseXml(await entry.async("nodebuffer"));
    let count = 0;
    for (const tag of ["commentRangeStart", "commentRangeEnd", "commentReference"])
      for (const node of descendants(root, tag).reverse()) {
        node.parentNode?.removeChild(node);
        count += 1;
      }
    if (count) {
      stats.markup_removed += count;
      overrides.set(name, xmlBytes(root));
    }
  }
  const rels = zip.file("word/_rels/document.xml.rels");
  if (rels) {
    const root = parseXml(await rels.async("nodebuffer"));
    let changed = false;
    for (const node of descendants(root, "Relationship"))
      if (COMMENT_REL_TYPES.has(node.getAttribute("Type"))) {
        node.parentNode?.removeChild(node);
        changed = true;
      }
    if (changed) {
      overrides.set("word/_rels/document.xml.rels", xmlBytes(root));
      stats.rels_updated = 1;
    }
  }
  const types = zip.file("[Content_Types].xml");
  if (types) {
    const root = parseXml(await types.async("nodebuffer"));
    let changed = false;
    for (const node of descendants(root, "Override"))
      if (
        ["/word/comments.xml", "/word/commentsExtended.xml"].includes(node.getAttribute("PartName"))
      ) {
        node.parentNode?.removeChild(node);
        changed = true;
      }
    if (changed) {
      overrides.set("[Content_Types].xml", xmlBytes(root));
      stats.content_types_updated = 1;
    }
  }
  const out = new JSZip();
  for (const [name, entry] of Object.entries(zip.files)) {
    if (name === "word/comments.xml" || name === "word/commentsExtended.xml") {
      if (name.endsWith("comments.xml")) stats.comments_part_removed = 1;
      else stats.comments_extended_part_removed = 1;
      continue;
    }
    out.file(name, overrides.has(name) ? overrides.get(name) : await entry.async("nodebuffer"), {
      binary: true,
      createFolders: false,
      date: entry.date,
      unixPermissions: entry.unixPermissions,
    });
  }
  await fs.writeFile(
    output,
    await out.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
  );
  const summary = `{${Object.entries(stats)
    .map(([key, value]) => `'${key}': ${typeof value === "string" ? `'${value}'` : value}`)
    .join(", ")}}`;
  console.log(`[OK] wrote ${output} | ${summary}`);
}
main().catch((error) => {
  console.error(`[ERROR] ${error.message}`);
  process.exitCode = 2;
});
