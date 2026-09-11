#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";

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
function attr(node, name) {
  return node?.getAttributeNS(W_NS, name) || node?.getAttribute(`w:${name}`) || "";
}
function fieldType(instruction) {
  const value = instruction.trim();
  return value ? value.split(/\s+/)[0].toUpperCase() : "(empty)";
}
function extractInstructions(root) {
  const output = [];
  for (const simple of descendants(root, "fldSimple")) {
    const value = attr(simple, "instr");
    if (value) output.push(value);
  }
  let active = false;
  let buffer = [];
  for (const node of descendants(root)) {
    if (localName(node) === "fldChar") {
      const kind = attr(node, "fldCharType");
      if (kind === "begin") {
        active = true;
        buffer = [];
      } else if (kind === "end" && active) {
        const value = buffer.join("").trim();
        if (value) output.push(value);
        active = false;
        buffer = [];
      }
    } else if (active && localName(node) === "instrText") buffer.push(node.textContent || "");
  }
  if (!output.length)
    for (const node of descendants(root, "instrText"))
      if ((node.textContent || "").trim()) output.push(node.textContent);
  return output.map((value) => value.replace(/\s+/g, " ").trim()).filter(Boolean);
}
async function main() {
  const invocationArgs = process.argv.slice(2);
  if (invocationArgs.includes("--help") || invocationArgs.includes("-h")) {
    process.stdout.write(
      [
        "usage: fields_report.mjs [-h] [--max_examples MAX_EXAMPLES] docx",
        "",
        "Scan a DOCX for Word fields (PAGE/TOC/REF/...).",
        "",
        "positional arguments:",
        "  docx",
        "",
        "options:",
        "  -h, --help            show this help message and exit",
        "  --max_examples MAX_EXAMPLES",
        "                        Examples to print per field type",
        "",
      ].join("\n"),
    );
    return;
  }
  if (invocationArgs.length === 0) {
    process.stderr.write(
      [
        "usage: fields_report.mjs [-h] [--max_examples MAX_EXAMPLES] docx",
        "fields_report.mjs: error: the following arguments are required: docx",
        "",
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }
  const args = process.argv.slice(2);
  const input = args[0];
  let max = 8;
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === "--max_examples") max = Number(args[++i]);
    else {
      console.error(`unknown argument: ${args[i]}`);
      process.exitCode = 2;
      return;
    }
  }
  if (!input) {
    console.error("usage: fields_report.mjs input.docx [--max_examples 8]");
    process.exitCode = 2;
    return;
  }
  const zip = await JSZip.loadAsync(await fs.readFile(input));
  const byPart = new Map();
  const counts = new Map();
  const examples = new Map();
  for (const name of Object.keys(zip.files)) {
    if (!name.startsWith("word/") || !name.endsWith(".xml")) continue;
    const base = path.basename(name);
    if (
      !(
        base === "document.xml" ||
        base === "settings.xml" ||
        /^(header|footer)\d+\.xml$/.test(base) ||
        /^(footnotes|endnotes)\.xml$/.test(base)
      )
    )
      continue;
    try {
      const values = extractInstructions(
        parseXml(await zip.file(name).async("nodebuffer")).documentElement,
      );
      if (!values.length) continue;
      byPart.set(name, values);
      for (const value of values) {
        const type = fieldType(value);
        counts.set(type, (counts.get(type) || 0) + 1);
        const list = examples.get(type) || [];
        if (list.length < max) list.push(value);
        examples.set(type, list);
      }
    } catch {
      /* malformed parts are skipped like the reference */
    }
  }
  if (!byPart.size) {
    console.log("No fields found in document.xml/headers/footers.");
    return;
  }
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  console.log("FIELD COUNTS");
  for (const [type, count] of ordered) console.log(`- ${type}: ${count}`);
  console.log("\nEXAMPLES");
  for (const [type] of ordered) {
    const list = examples.get(type) || [];
    if (!list.length) continue;
    console.log(`\n[${type}]`);
    for (const value of list) console.log(`  - ${value}`);
  }
  console.log("\nPER-PART DETAILS");
  for (const [part, values] of [...byPart.entries()].sort()) {
    console.log(`\n== ${part} ==`);
    for (const value of values) console.log(`- ${value}`);
  }
  if (["TOC", "REF", "PAGEREF", "NUMPAGES", "PAGE"].some((type) => counts.has(type))) {
    console.log("\nREMINDER");
    console.log(
      "- If the PDF/PNGs show placeholders or wrong page numbers/TOC, open in Word and run: Ctrl+A → F9 (Update Fields), then re-render.",
    );
  }
}
main().catch((error) => {
  console.error(`[ERROR] ${error.message}`);
  process.exitCode = 2;
});
