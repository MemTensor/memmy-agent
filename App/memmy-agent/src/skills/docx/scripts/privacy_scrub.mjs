#!/usr/bin/env node
import fs from "node:fs/promises";
import JSZip from "jszip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const REL_TYPES_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const CP_NS = "http://schemas.openxmlformats.org/package/2006/metadata/core-properties";
const DC_NS = "http://purl.org/dc/elements/1.1/";
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
  return Object.keys(zip.files).filter(
    (name) =>
      name === "word/document.xml" ||
      /^word\/(?:header|footer)\d+\.xml$/.test(name) ||
      ["word/footnotes.xml", "word/endnotes.xml"].includes(name),
  );
}
async function main() {
  const invocationArgs = process.argv.slice(2);
  if (invocationArgs.includes("--help") || invocationArgs.includes("-h")) {
    process.stdout.write(
      [
        "usage: privacy_scrub.mjs [-h] --out OUT in_docx",
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
        "usage: privacy_scrub.mjs [-h] --out OUT in_docx",
        "privacy_scrub.mjs: error: the following arguments are required: in_docx, --out",
        "",
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }
  const args = process.argv.slice(2);
  if (!args[0] || args[1] !== "--out" || !args[2]) {
    console.error("usage: privacy_scrub.mjs in.docx --out out.docx");
    process.exitCode = 2;
    return;
  }
  const input = args[0],
    output = args[2],
    zip = await JSZip.loadAsync(await fs.readFile(input)),
    overrides = new Map();
  const stats = {
    rsid_attrs_removed: 0,
    core_props_scrubbed: 0,
    custom_props_removed: 0,
    rels_updated: 0,
    content_types_updated: 0,
  };
  for (const name of storyParts(zip)) {
    const root = parseXml(await zip.file(name).async("nodebuffer"));
    let count = 0;
    for (const element of descendants(root))
      for (const attribute of Array.from(element.attributes || []))
        if (
          (attribute.namespaceURI === W_NS && attribute.localName?.startsWith("rsid")) ||
          attribute.name.startsWith("w:rsid")
        ) {
          element.removeAttributeNS(W_NS, attribute.localName);
          element.removeAttribute(attribute.name);
          count += 1;
        }
    if (count) {
      stats.rsid_attrs_removed += count;
      overrides.set(name, xmlBytes(root));
    }
  }
  const core = zip.file("docProps/core.xml");
  if (core) {
    const root = parseXml(await core.async("nodebuffer"));
    let changed = false;
    for (const element of descendants(root))
      if (
        (element.namespaceURI === DC_NS && element.localName === "creator") ||
        (element.namespaceURI === CP_NS && element.localName === "lastModifiedBy")
      )
        if ((element.textContent || "").trim()) {
          while (element.firstChild) element.removeChild(element.firstChild);
          changed = true;
        }
    if (changed) {
      overrides.set("docProps/core.xml", xmlBytes(root));
      stats.core_props_scrubbed = 1;
    }
  }
  const rels = zip.file("_rels/.rels");
  if (rels) {
    const root = parseXml(await rels.async("nodebuffer"));
    let changed = false;
    for (const element of descendants(root, "Relationship"))
      if ((element.getAttribute("Target") || "").endsWith("docProps/custom.xml")) {
        element.parentNode.removeChild(element);
        changed = true;
      }
    if (changed) {
      overrides.set("_rels/.rels", xmlBytes(root));
      stats.rels_updated = 1;
    }
  }
  const types = zip.file("[Content_Types].xml");
  if (types) {
    const root = parseXml(await types.async("nodebuffer"));
    let changed = false;
    for (const element of descendants(root, "Override"))
      if (element.getAttribute("PartName") === "/docProps/custom.xml") {
        element.parentNode.removeChild(element);
        changed = true;
      }
    if (changed) {
      overrides.set("[Content_Types].xml", xmlBytes(root));
      stats.content_types_updated = 1;
    }
  }
  const out = new JSZip();
  for (const [name, entry] of Object.entries(zip.files)) {
    if (name === "docProps/custom.xml") {
      stats.custom_props_removed = 1;
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
