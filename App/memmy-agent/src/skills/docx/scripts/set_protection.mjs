#!/usr/bin/env node
import fs from "node:fs/promises";
import JSZip from "jszip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const SETTINGS_CT = "application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml";
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
function children(root, name) {
  return descendants(root, name).filter((node) => node.parentNode === root);
}
function wAttr(node, name) {
  return node?.getAttributeNS(W_NS, name) || node?.getAttribute(`w:${name}`) || "";
}
function setWAttr(node, name, value) {
  node.setAttributeNS(W_NS, `w:${name}`, String(value));
}
const modeMap = {
  off: "off",
  readonly: "readOnly",
  read_only: "readOnly",
  comments: "comments",
  trackedchanges: "trackedChanges",
  tracked_changes: "trackedChanges",
  forms: "forms",
};
async function main() {
  const invocationArgs = process.argv.slice(2);
  if (invocationArgs.includes("--help") || invocationArgs.includes("-h")) {
    process.stdout.write(
      [
        "usage: set_protection.mjs [-h] --mode MODE --out OUT in_docx",
        "",
        "positional arguments:",
        "  in_docx",
        "",
        "options:",
        "  -h, --help   show this help message and exit",
        "  --mode MODE  Protection mode: off | readOnly | comments | trackedChanges |",
        "               forms (aliases accepted: read_only, read-only, readonly,",
        "               tracked_changes, tracked-changes)",
        "  --out OUT",
        "",
      ].join("\n"),
    );
    return;
  }
  if (invocationArgs.length === 0) {
    process.stderr.write(
      [
        "usage: set_protection.mjs [-h] --mode MODE --out OUT in_docx",
        "set_protection.mjs: error: the following arguments are required: in_docx, --mode, --out",
        "",
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }
  const args = process.argv.slice(2);
  const input = args[0];
  let mode = null,
    output = null;
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === "--mode") mode = args[++i];
    else if (args[i] === "--out") output = args[++i];
    else {
      console.error(`unknown argument: ${args[i]}`);
      process.exitCode = 2;
      return;
    }
  }
  if (!input || !mode || !output) {
    console.error(
      "usage: set_protection.mjs in.docx --mode off|readOnly|comments|trackedChanges|forms --out out.docx",
    );
    process.exitCode = 2;
    return;
  }
  const key = mode.trim().replace(/-/g, "_").replace(/\s+/g, "_").toLowerCase();
  const canonical = modeMap[key];
  if (!canonical) {
    console.error(
      `[set_protection] invalid --mode=${JSON.stringify(mode)}. Use off, readOnly, comments, trackedChanges, forms (aliases: read_only, tracked_changes).`,
    );
    process.exitCode = 2;
    return;
  }
  const zip = await JSZip.loadAsync(await fs.readFile(input));
  const settingsEntry = zip.file("word/settings.xml");
  const settings = settingsEntry
    ? parseXml(await settingsEntry.async("nodebuffer"))
    : parseXml(`<?xml version="1.0"?><w:settings xmlns:w="${W_NS}"/>`);
  const typesEntry = zip.file("[Content_Types].xml");
  if (!typesEntry) throw new Error("[Content_Types].xml is missing");
  const types = parseXml(await typesEntry.async("nodebuffer"));
  let changedSettings = false;
  for (const node of descendants(settings.documentElement, "documentProtection")) {
    node.parentNode.removeChild(node);
    changedSettings = true;
  }
  if (canonical !== "off") {
    const protection = settings.createElementNS(W_NS, "w:documentProtection");
    setWAttr(protection, "edit", canonical);
    setWAttr(protection, "enforcement", "1");
    setWAttr(protection, "formatting", "0");
    settings.documentElement.insertBefore(protection, settings.documentElement.firstChild);
    changedSettings = true;
  }
  let changedTypes = false;
  const existing = descendants(types.documentElement, "Override").find(
    (node) => node.getAttribute("PartName") === "/word/settings.xml",
  );
  if (existing) {
    if (existing.getAttribute("ContentType") !== SETTINGS_CT) {
      existing.setAttribute("ContentType", SETTINGS_CT);
      changedTypes = true;
    }
  } else {
    const override = types.createElementNS(CT_NS, "Override");
    override.setAttribute("PartName", "/word/settings.xml");
    override.setAttribute("ContentType", SETTINGS_CT);
    types.documentElement.appendChild(override);
    changedTypes = true;
  }
  const overrides = new Map();
  if (changedSettings || !settingsEntry) overrides.set("word/settings.xml", xmlBytes(settings));
  if (changedTypes) overrides.set("[Content_Types].xml", xmlBytes(types));
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
  console.log(`[OK] wrote ${output} (mode=${canonical})`);
}
main().catch((error) => {
  console.error(`[ERROR] ${error.message}`);
  process.exitCode = 2;
});
