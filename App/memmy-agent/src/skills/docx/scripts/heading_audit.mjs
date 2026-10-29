#!/usr/bin/env node
import fs from "node:fs/promises";
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
function direct(root, name) {
  return descendants(root, name).filter((node) => node.parentNode === root);
}
function wAttr(node, name) {
  return node?.getAttributeNS(W_NS, name) || node?.getAttribute(`w:${name}`) || "";
}
function paragraphText(p) {
  return descendants(p, "t")
    .map((node) => node.textContent || "")
    .join("");
}
function headingLevel(style) {
  const match = /^heading\s+(\d+)$/i.exec((style || "").trim());
  return match ? Number(match[1]) : null;
}
async function main() {
  const invocationArgs = process.argv.slice(2);
  if (invocationArgs.includes("--help") || invocationArgs.includes("-h")) {
    process.stdout.write(
      [
        "usage: heading_audit.mjs [-h] [--max_findings MAX_FINDINGS] docx",
        "",
        "Audit heading hierarchy + numbering usage in a DOCX",
        "",
        "positional arguments:",
        "  docx",
        "",
        "options:",
        "  -h, --help            show this help message and exit",
        "  --max_findings MAX_FINDINGS",
        "",
      ].join("\n"),
    );
    return;
  }
  if (invocationArgs.length === 0) {
    process.stderr.write(
      [
        "usage: heading_audit.mjs [-h] [--max_findings MAX_FINDINGS] docx",
        "heading_audit.mjs: error: the following arguments are required: docx",
        "",
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }
  const args = process.argv.slice(2);
  const input = args[0];
  let max = 20;
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === "--max_findings") max = Number(args[++i]);
    else {
      console.error(`unknown argument: ${args[i]}`);
      process.exitCode = 2;
      return;
    }
  }
  if (!input) {
    console.error("usage: heading_audit.mjs input.docx [--max_findings 20]");
    process.exitCode = 2;
    return;
  }
  const zip = await JSZip.loadAsync(await fs.readFile(input));
  const entry = zip.file("word/document.xml");
  if (!entry) throw new Error("word/document.xml is missing");
  const root = parseXml(await entry.async("nodebuffer")).documentElement;
  const styleNames = new Map();
  const stylesEntry = zip.file("word/styles.xml");
  if (stylesEntry) {
    const stylesRoot = parseXml(await stylesEntry.async("nodebuffer")).documentElement;
    // The document consumer falls back to its default template when a minimal
    // or malformed styles part is supplied. Only resolve document styles when
    // the normal document defaults marker is present.
    if (direct(stylesRoot, "docDefaults").length) {
      for (const style of descendants(stylesRoot, "style")) {
        const id = wAttr(style, "styleId");
        const name = wAttr(direct(style, "name")[0], "val");
        if (id) styleNames.set(id, name || id);
      }
    }
  }
  const counts = new Map();
  const jumps = [];
  const numbered = [];
  let last = null;
  const paragraphs = descendants(root, "p");
  paragraphs.forEach((p, index) => {
    const pPr = direct(p, "pPr")[0];
    const styleId = wAttr(direct(pPr, "pStyle")[0], "val");
    const style = styleNames.get(styleId) || "Normal";
    const level = headingLevel(style);
    if (level !== null) {
      counts.set(level, (counts.get(level) || 0) + 1);
      if (last !== null && level > last + 1)
        jumps.push(
          `p#${index + 1}: Heading ${last} → Heading ${level}: ${JSON.stringify(paragraphText(p).slice(0, 80))}`,
        );
      last = level;
    }
    if (direct(pPr, "numPr")[0] && level === null) {
      const text = paragraphText(p).trim();
      if (text)
        numbered.push(
          `p#${index + 1}: style=${JSON.stringify(style)} text=${JSON.stringify(text.slice(0, 80))}`,
        );
    }
  });
  console.log("HEADING STYLE COUNTS");
  if (!counts.size) console.log("- (no Heading styles found)");
  else
    for (const level of [...counts.keys()].sort((a, b) => a - b))
      console.log(`- Heading ${level}: ${counts.get(level)}`);
  if (jumps.length) {
    console.log("\nPOTENTIAL HEADING LEVEL JUMPS (review)");
    for (const value of jumps.slice(0, max)) console.log(`- ${value}`);
    if (jumps.length > max) console.log(`- ... (${jumps.length - max} more)`);
  }
  if (numbered.length) {
    console.log("\nNUMBERING WITHOUT HEADING STYLE (common TOC issue)");
    for (const value of numbered.slice(0, max)) console.log(`- ${value}`);
    if (numbered.length > max) console.log(`- ... (${numbered.length - max} more)`);
  }
  console.log("\nREMINDER");
  console.log(
    "- TOC relies on Heading styles (Heading 1/2/3...). Avoid manual numbering + direct formatting for headings.",
  );
}
main().catch((error) => {
  console.error(`[ERROR] ${error.message}`);
  process.exitCode = 2;
});
