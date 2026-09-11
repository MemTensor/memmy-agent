#!/usr/bin/env node
import fs from "node:fs/promises";
import JSZip from "jszip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const XML_NS = "http://www.w3.org/XML/1998/namespace";
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
function wAttr(node, name) {
  return node?.getAttributeNS(W_NS, name) || node?.getAttribute(`w:${name}`) || "";
}
function flattenPart(root) {
  let changed = 0;
  for (const paragraph of descendants(root, "p")) {
    let kids = Array.from(paragraph.childNodes).filter((node) => node.nodeType === 1);
    let i = 0;
    while (i < kids.length) {
      const begin = kids[i];
      const beginField = descendants(begin, "fldChar").find(
        (node) => wAttr(node, "fldCharType") === "begin",
      );
      if (!beginField) {
        i += 1;
        continue;
      }
      let separate = -1,
        end = -1;
      for (let j = i + 1; j < kids.length; j += 1) {
        const field = descendants(kids[j], "fldChar")[0];
        if (!field) continue;
        const type = wAttr(field, "fldCharType");
        if (type === "separate") separate = j;
        if (type === "end") {
          end = j;
          break;
        }
      }
      if (end < 0 || separate < 0) {
        i += 1;
        continue;
      }
      const instruction = kids
        .slice(i, separate + 1)
        .flatMap((node) => descendants(node, "instrText").map((value) => value.textContent || ""))
        .join("");
      if (!/\b(PAGE)?REF\b/i.test(instruction)) {
        i += 1;
        continue;
      }
      const visible = kids
        .slice(separate + 1, end)
        .flatMap((node) => descendants(node, "t").map((value) => value.textContent || ""))
        .join("");
      if (!visible.trim()) {
        i = end + 1;
        continue;
      }
      const run = root.ownerDocument.createElementNS(W_NS, "w:r");
      const t = root.ownerDocument.createElementNS(W_NS, "w:t");
      t.appendChild(root.ownerDocument.createTextNode(visible));
      if (/^\s|\s$/.test(visible)) t.setAttributeNS(XML_NS, "xml:space", "preserve");
      run.appendChild(t);
      paragraph.insertBefore(run, kids[i]);
      for (let j = i + 1; j <= end; j += 1) paragraph.removeChild(kids[j]);
      changed += 1;
      kids = Array.from(paragraph.childNodes).filter((node) => node.nodeType === 1);
      i += 1;
    }
  }
  return changed;
}
async function main() {
  const invocationArgs = process.argv.slice(2);
  if (invocationArgs.includes("--help") || invocationArgs.includes("-h")) {
    process.stdout.write(
      [
        "usage: flatten_ref_fields.mjs [-h] --out OUT in_docx",
        "",
        "Flatten REF/PAGEREF fields to literal text",
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
        "usage: flatten_ref_fields.mjs [-h] --out OUT in_docx",
        "flatten_ref_fields.mjs: error: the following arguments are required: in_docx, --out",
        "",
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }
  const args = process.argv.slice(2);
  if (!args[0] || args[1] !== "--out" || !args[2]) {
    console.error("usage: flatten_ref_fields.mjs in.docx --out out.docx");
    process.exitCode = 2;
    return;
  }
  const input = args[0],
    output = args[2],
    zip = await JSZip.loadAsync(await fs.readFile(input));
  const entry = zip.file("word/document.xml");
  if (!entry) throw new Error("word/document.xml is missing");
  const doc = parseXml(await entry.async("nodebuffer"));
  const count = flattenPart(doc.documentElement);
  const out = new JSZip();
  for (const [name, item] of Object.entries(zip.files))
    out.file(name, name === "word/document.xml" ? xmlBytes(doc) : await item.async("nodebuffer"), {
      binary: true,
      createFolders: false,
      date: item.date,
      unixPermissions: item.unixPermissions,
    });
  await fs.writeFile(
    output,
    await out.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
  );
  console.log(`[OK] wrote ${output} (fields_flattened=${count})`);
}
main().catch((error) => {
  console.error(`[ERROR] ${error.message}`);
  process.exitCode = 2;
});
