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
function inches(twips) {
  const value = Number(twips);
  return Number.isFinite(value) ? value / 1440 : Number.NaN;
}
function fmt(value) {
  return Number.isNaN(value) ? "nan" : value.toFixed(2);
}
async function main() {
  const invocationArgs = process.argv.slice(2);
  if (invocationArgs.includes("--help") || invocationArgs.includes("-h")) {
    process.stdout.write(
      [
        "usage: section_audit.mjs [-h] docx",
        "",
        "Audit DOCX sections: orientation, margins, header/footer linkage",
        "",
        "positional arguments:",
        "  docx",
        "",
        "options:",
        "  -h, --help  show this help message and exit",
        "",
      ].join("\n"),
    );
    return;
  }
  if (invocationArgs.length === 0) {
    process.stderr.write(
      [
        "usage: section_audit.mjs [-h] docx",
        "section_audit.mjs: error: the following arguments are required: docx",
        "",
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }
  const input = process.argv[2];
  if (!input) {
    console.error("usage: section_audit.mjs input.docx");
    process.exitCode = 2;
    return;
  }
  const zip = await JSZip.loadAsync(await fs.readFile(input));
  const entry = zip.file("word/document.xml");
  if (!entry) throw new Error("word/document.xml is missing");
  const root = parseXml(await entry.async("nodebuffer")).documentElement;
  const sections = descendants(root, "sectPr");
  const settingsEntry = zip.file("word/settings.xml");
  const settings = settingsEntry
    ? parseXml(await settingsEntry.async("nodebuffer")).documentElement
    : null;
  console.log(`SECTIONS: ${sections.length}`);
  sections.forEach((section, index) => {
    const size = direct(section, "pgSz")[0];
    const margin = direct(section, "pgMar")[0];
    const type = direct(section, "type")[0];
    const orientation = (wAttr(size, "orient") || "portrait").toUpperCase();
    const pageWidth = inches(wAttr(size, "w"));
    const pageHeight = inches(wAttr(size, "h"));
    const left = inches(wAttr(margin, "left"));
    const right = inches(wAttr(margin, "right"));
    const top = inches(wAttr(margin, "top"));
    const bottom = inches(wAttr(margin, "bottom"));
    const headerRefs = direct(section, "headerReference");
    const footerRefs = direct(section, "footerReference");
    const different = Boolean(direct(section, "titlePg")[0]);
    const startValue = wAttr(type, "val");
    const startType =
      startValue === "continuous"
        ? "CONTINUOUS (0)"
        : startValue === "evenPage"
          ? "EVEN_PAGE (3)"
          : startValue === "oddPage"
            ? "ODD_PAGE (4)"
            : "NEW_PAGE (2)";
    const orientationLabel = orientation === "LANDSCAPE" ? "LANDSCAPE (1)" : "PORTRAIT (0)";
    const oddEven = settings && descendants(settings, "evenAndOddHeaders").length ? "True" : "None";
    console.log(`\n[Section ${index + 1}] start_type=${startType} orientation=${orientationLabel}`);
    console.log(`  page_size(in): ${fmt(pageWidth)} x ${fmt(pageHeight)}`);
    console.log(`  margins(in): L=${fmt(left)} R=${fmt(right)} T=${fmt(top)} B=${fmt(bottom)}`);
    console.log(
      `  header_linked_to_previous=${headerRefs.length === 0 ? "True" : "False"} footer_linked_to_previous=${footerRefs.length === 0 ? "True" : "False"}`,
    );
    console.log(
      `  different_first_page=${different ? "True" : "False"} odd_even_headers=${oddEven}`,
    );
  });
  console.log("\nREMINDER");
  console.log("- If you change orientation mid-document, Word typically creates a new section.");
  console.log("- If headers/footers look wrong, check 'Link to Previous' per section.");
}
main().catch((error) => {
  console.error(`[ERROR] ${error.message}`);
  process.exitCode = 2;
});
