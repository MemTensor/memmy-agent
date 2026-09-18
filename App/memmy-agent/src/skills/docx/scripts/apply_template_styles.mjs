#!/usr/bin/env node
import fs from "node:fs/promises";
import JSZip from "jszip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

const CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
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
function elements(root, name) {
  const out = [];
  const visit = (node) => {
    for (let child = node?.firstChild; child; child = child.nextSibling) {
      if (child.nodeType !== 1) continue;
      if (!name || child.localName === name || child.nodeName.endsWith(`:${name}`)) out.push(child);
      visit(child);
    }
  };
  visit(root);
  return out;
}
function ensureOverride(root, partName, contentType) {
  const normalized = partName.startsWith("/") ? partName : `/${partName}`;
  for (const override of elements(root, "Override"))
    if (override.getAttribute("PartName") === normalized) {
      if (override.getAttribute("ContentType") !== contentType) {
        override.setAttribute("ContentType", contentType);
        return true;
      }
      return false;
    }
  const node = root.ownerDocument.createElementNS(CT_NS, "Override");
  node.setAttribute("PartName", normalized);
  node.setAttribute("ContentType", contentType);
  root.appendChild(node);
  return true;
}
async function main() {
  const invocationArgs = process.argv.slice(2);
  if (invocationArgs.includes("--help") || invocationArgs.includes("-h")) {
    process.stdout.write(
      [
        "usage: apply_template_styles.mjs [-h] --template TEMPLATE --target TARGET --out",
        "                                OUT",
        "",
        "options:",
        "  -h, --help           show this help message and exit",
        "  --template TEMPLATE",
        "  --target TARGET",
        "  --out OUT",
        "",
      ].join("\n"),
    );
    return;
  }
  if (invocationArgs.length === 0) {
    process.stderr.write(
      [
        "usage: apply_template_styles.mjs [-h] --template TEMPLATE --target TARGET --out",
        "                                OUT",
        "apply_template_styles.mjs: error: the following arguments are required: --template, --target, --out",
        "",
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }
  const args = process.argv.slice(2);
  let template = null,
    target = null,
    output = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--template") template = args[++i];
    else if (args[i] === "--target") target = args[++i];
    else if (args[i] === "--out") output = args[++i];
    else {
      console.error(`unknown argument: ${args[i]}`);
      process.exitCode = 2;
      return;
    }
  }
  if (!template || !target || !output) {
    console.error(
      "usage: apply_template_styles.mjs --template template.dotx --target report.docx --out styled.docx",
    );
    process.exitCode = 2;
    return;
  }
  const templateZip = await JSZip.loadAsync(await fs.readFile(template));
  const targetZip = await JSZip.loadAsync(await fs.readFile(target));
  const parts = [
    ["word/styles.xml", null],
    ["word/theme/theme1.xml", "application/vnd.openxmlformats-officedocument.theme+xml"],
    [
      "word/fontTable.xml",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml",
    ],
    [
      "word/numbering.xml",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml",
    ],
  ];
  const overrides = new Map();
  for (const [name] of parts) {
    const entry = templateZip.file(name);
    if (entry) overrides.set(name, await entry.async("nodebuffer"));
  }
  const contentTypes = targetZip.file("[Content_Types].xml");
  if (!contentTypes) throw new Error("[Content_Types].xml is missing");
  const ctDoc = parseXml(await contentTypes.async("nodebuffer"));
  let changed = false;
  for (const [name, type] of parts)
    if (type && overrides.has(name)) changed ||= ensureOverride(ctDoc.documentElement, name, type);
  if (changed) overrides.set("[Content_Types].xml", xmlBytes(ctDoc));
  const outZip = new JSZip();
  for (const [name, entry] of Object.entries(targetZip.files))
    outZip.file(name, overrides.has(name) ? overrides.get(name) : await entry.async("nodebuffer"), {
      binary: true,
      createFolders: false,
      date: entry.date,
      unixPermissions: entry.unixPermissions,
    });
  for (const [name, data] of overrides)
    if (!targetZip.files[name]) outZip.file(name, data, { binary: true });
  await fs.writeFile(
    output,
    await outZip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
  );
  console.log(`[OK] wrote ${output}`);
}
main().catch((error) => {
  console.error(`[ERROR] ${error.message}`);
  process.exitCode = 2;
});
