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
function direct(root, name) {
  return descendants(root, name).filter((node) => node.parentNode === root);
}
async function main() {
  const invocationArgs = process.argv.slice(2);
  if (invocationArgs.includes("--help") || invocationArgs.includes("-h")) {
    process.stdout.write(
      [
        "usage: merge_docx_append.mjs [-h] --out OUT [--allow_drawings]",
        "                            base_docx append_docx",
        "",
        "positional arguments:",
        "  base_docx",
        "  append_docx",
        "",
        "options:",
        "  -h, --help        show this help message and exit",
        "  --out OUT",
        "  --allow_drawings",
        "",
      ].join("\n"),
    );
    return;
  }
  if (invocationArgs.length === 0) {
    process.stderr.write(
      [
        "usage: merge_docx_append.mjs [-h] --out OUT [--allow_drawings]",
        "                            base_docx append_docx",
        "merge_docx_append.mjs: error: the following arguments are required: base_docx, append_docx, --out",
        "",
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }
  const args = process.argv.slice(2);
  const base = args[0];
  const append = args[1];
  let output = null,
    allow = false;
  for (let i = 2; i < args.length; i += 1) {
    if (args[i] === "--out") output = args[++i];
    else if (args[i] === "--allow_drawings") allow = true;
    else {
      console.error(`unknown argument: ${args[i]}`);
      process.exitCode = 2;
      return;
    }
  }
  if (!base || !append || !output) {
    console.error(
      "usage: merge_docx_append.mjs base.docx append.docx --out merged.docx [--allow_drawings]",
    );
    process.exitCode = 2;
    return;
  }
  const baseZip = await JSZip.loadAsync(await fs.readFile(base));
  const appendZip = await JSZip.loadAsync(await fs.readFile(append));
  const baseEntry = baseZip.file("word/document.xml");
  const appendEntry = appendZip.file("word/document.xml");
  if (!baseEntry || !appendEntry)
    throw new Error("Missing word/document.xml in one of the documents");
  const baseDoc = parseXml(await baseEntry.async("nodebuffer"));
  const appendDoc = parseXml(await appendEntry.async("nodebuffer"));
  const baseBody = direct(baseDoc.documentElement, "body")[0];
  const appendBody = direct(appendDoc.documentElement, "body")[0];
  if (!baseBody || !appendBody) throw new Error("Missing w:body in one of the documents");
  if (
    !allow &&
    descendants(appendBody).some((node) => ["drawing", "pict"].includes(localName(node)))
  ) {
    console.error(
      "append.docx contains drawings/images. Re-run with --allow_drawings if this is acceptable, or remove drawings first to keep the merge safer.",
    );
    process.exitCode = 1;
    return;
  }
  const baseChildren = direct(baseBody);
  const sectPr = baseChildren.at(-1)?.localName === "sectPr" ? baseChildren.at(-1) : null;
  if (sectPr) baseBody.removeChild(sectPr);
  const appendChildren = direct(appendBody);
  const appendContent =
    appendChildren.at(-1)?.localName === "sectPr" ? appendChildren.slice(0, -1) : appendChildren;
  for (const child of appendContent)
    baseBody.appendChild(
      baseDoc.importNode ? baseDoc.importNode(child, true) : child.cloneNode(true),
    );
  if (sectPr) baseBody.appendChild(sectPr);
  const outZip = new JSZip();
  for (const [name, entry] of Object.entries(baseZip.files))
    outZip.file(
      name,
      name === "word/document.xml" ? xmlBytes(baseDoc) : await entry.async("nodebuffer"),
      {
        binary: true,
        createFolders: false,
        date: entry.date,
        unixPermissions: entry.unixPermissions,
      },
    );
  await fs.writeFile(
    output,
    await outZip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
  );
  console.log(`[OK] wrote ${output} | {'body_children_appended': ${appendContent.length}}`);
}
main().catch((error) => {
  console.error(`[ERROR] ${error.message}`);
  process.exitCode = 2;
});
