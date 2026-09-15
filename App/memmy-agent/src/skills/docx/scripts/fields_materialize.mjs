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
function setText(node, value) {
  while (node.firstChild) node.removeChild(node.firstChild);
  node.appendChild(node.ownerDocument.createTextNode(value));
  if (value.startsWith(" ") || value.endsWith(" "))
    node.setAttributeNS(XML_NS, "xml:space", "preserve");
}
function bookmarkText(root) {
  const stack = [];
  const result = {};
  const walk = (node) => {
    for (let child = node?.firstChild; child; child = child.nextSibling) {
      if (child.nodeType !== 1) continue;
      const name = localName(child);
      if (name === "bookmarkStart")
        stack.push({ id: wAttr(child, "id"), name: wAttr(child, "name"), text: "" });
      else if (name === "bookmarkEnd") {
        const index = [...stack].reverse().findIndex((item) => item.id === wAttr(child, "id"));
        if (index >= 0) {
          const actual = stack.length - 1 - index;
          const item = stack.splice(actual, 1)[0];
          if (item.name) result[item.name] = item.text;
        }
      } else if (name === "t") {
        for (const item of stack) item.text += child.textContent || "";
      }
      walk(child);
    }
  };
  walk(root);
  return result;
}
function materializeRoot(root, only) {
  let total = 0;
  const bookmarks = bookmarkText(root);
  const seqCounters = {};
  for (const p of descendants(root, "p")) {
    const runs = descendants(p, "r");
    let active = false,
      separated = false,
      instruction = "",
      resultNodes = [];
    for (const run of runs) {
      const fld = direct(run, "fldChar")[0];
      const type = wAttr(fld, "fldCharType");
      if (type === "begin") {
        active = true;
        separated = false;
        instruction = "";
        resultNodes = [];
        continue;
      }
      if (active && type === "separate") {
        separated = true;
        continue;
      }
      if (active && type === "end") {
        const normalized = instruction.replace(/\s+/g, " ").trim();
        const seq = /\bSEQ\s+([A-Za-z0-9_]+)/i.exec(normalized);
        const ref = /\bREF\s+([A-Za-z0-9_:.\-]+)/i.exec(normalized);
        let value = null;
        if (seq && only.has("SEQ")) {
          seqCounters[seq[1]] = (seqCounters[seq[1]] || 0) + 1;
          value = String(seqCounters[seq[1]]);
        }
        if (ref && only.has("REF") && Object.prototype.hasOwnProperty.call(bookmarks, ref[1]))
          value = bookmarks[ref[1]];
        if (value != null && resultNodes.length) {
          setText(resultNodes[0], value);
          for (const extra of resultNodes.slice(1)) setText(extra, "");
          total += 1;
        }
        active = false;
        separated = false;
        instruction = "";
        resultNodes = [];
        continue;
      }
      if (!active) continue;
      if (!separated)
        for (const node of direct(run, "instrText")) instruction += node.textContent || "";
      else resultNodes.push(...descendants(run, "t"));
    }
  }
  return total;
}
async function main() {
  const invocationArgs = process.argv.slice(2);
  if (invocationArgs.includes("--help") || invocationArgs.includes("-h")) {
    process.stdout.write(
      [
        "usage: fields_materialize.mjs [-h] --out OUT [--only {SEQ,REF} [{SEQ,REF} ...]]",
        "                             input_docx",
        "",
        "Materialize SEQ/REF field results inside a DOCX",
        "",
        "positional arguments:",
        "  input_docx",
        "",
        "options:",
        "  -h, --help            show this help message and exit",
        "  --out OUT             Output DOCX path",
        "  --only {SEQ,REF} [{SEQ,REF} ...]",
        "                        Which field types to materialize (default: SEQ REF)",
        "",
      ].join("\n"),
    );
    return;
  }
  if (invocationArgs.length === 0) {
    process.stderr.write(
      [
        "usage: fields_materialize.mjs [-h] --out OUT [--only {SEQ,REF} [{SEQ,REF} ...]]",
        "                             input_docx",
        "fields_materialize.mjs: error: the following arguments are required: input_docx, --out",
        "",
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }
  const args = process.argv.slice(2);
  const input = args[0];
  let output = null;
  let only = ["SEQ", "REF"];
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === "--out") output = args[++i];
    else if (args[i] === "--only") {
      only = [];
      while (i + 1 < args.length && !args[i + 1].startsWith("--")) only.push(args[++i]);
    } else {
      console.error(`unknown argument: ${args[i]}`);
      process.exitCode = 2;
      return;
    }
  }
  if (!input || !output || !only.length || only.some((value) => !["SEQ", "REF"].includes(value))) {
    console.error("usage: fields_materialize.mjs in.docx --out out.docx [--only SEQ REF]");
    process.exitCode = 2;
    return;
  }
  const zip = await JSZip.loadAsync(await fs.readFile(input));
  const out = new JSZip();
  let total = 0;
  for (const [name, entry] of Object.entries(zip.files)) {
    if (/^word\/(?:document|header\d+|footer\d+)\.xml$/.test(name)) {
      const doc = parseXml(await entry.async("nodebuffer"));
      total += materializeRoot(doc.documentElement, new Set(only));
      out.file(name, xmlBytes(doc), {
        binary: true,
        createFolders: false,
        date: entry.date,
        unixPermissions: entry.unixPermissions,
      });
    } else
      out.file(name, await entry.async("nodebuffer"), {
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
  console.log(`[OK] materialized ${total} field(s) -> ${output}`);
}
main().catch((error) => {
  console.error(`[ERROR] ${error.message}`);
  process.exitCode = 2;
});
