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
function wAttr(node, name) {
  return node?.getAttributeNS(W_NS, name) || node?.getAttribute(`w:${name}`) || "";
}
function noteText(note) {
  return descendants(note, "t")
    .map((node) => node.textContent || "")
    .join("")
    .trim();
}
async function main() {
  const invocationArgs = process.argv.slice(2);
  if (invocationArgs.includes("--help") || invocationArgs.includes("-h")) {
    process.stdout.write(
      [
        "usage: footnotes_report.mjs [-h] docx",
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
        "usage: footnotes_report.mjs [-h] docx",
        "footnotes_report.mjs: error: the following arguments are required: docx",
        "",
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }
  const input = process.argv[2];
  if (!input) {
    console.error("usage: footnotes_report.mjs input.docx");
    process.exitCode = 2;
    return;
  }
  const zip = await JSZip.loadAsync(await fs.readFile(input));
  const docEntry = zip.file("word/document.xml");
  if (!docEntry) throw new Error("word/document.xml is missing");
  const doc = parseXml(await docEntry.async("nodebuffer")).documentElement;
  const fnRefs = descendants(doc, "footnoteReference")
    .map((node) => Number(wAttr(node, "id")))
    .filter(Number.isInteger);
  const enRefs = descendants(doc, "endnoteReference")
    .map((node) => Number(wAttr(node, "id")))
    .filter(Number.isInteger);
  console.log(
    `[document.xml] footnoteReferences=${fnRefs.length} ids=[${[...new Set(fnRefs)].sort((a, b) => a - b).join(", ")}]`,
  );
  console.log(
    `[document.xml] endnoteReferences=${enRefs.length} ids=[${[...new Set(enRefs)].sort((a, b) => a - b).join(", ")}]`,
  );
  const duplicates = (values) => [
    ...new Set(values.filter((value, index) => values.indexOf(value) !== index)),
  ];
  if (duplicates(fnRefs).length)
    console.log(
      `[warn] duplicated footnote reference ids (multiple references to same note): [${duplicates(fnRefs).join(", ")}]`,
    );
  for (const [name, kind] of [
    ["word/footnotes.xml", "footnote"],
    ["word/endnotes.xml", "endnote"],
  ]) {
    const entry = zip.file(name);
    if (!entry) {
      console.log(`[${name}] MISSING`);
      continue;
    }
    const root = parseXml(await entry.async("nodebuffer")).documentElement;
    const notes = descendants(root, kind).filter((node) => Number(wAttr(node, "id")) >= 1);
    const ids = notes.map((node) => Number(wAttr(node, "id")));
    console.log(
      `[${name}] defined_${kind}s=${ids.length} ids=[${ids
        .slice(0, 10)
        .sort((a, b) => a - b)
        .join(", ")}]${ids.length > 10 ? "..." : ""}`,
    );
    for (const note of notes.slice(0, 5)) {
      const text = noteText(note);
      if (text) console.log(`  - id=${wAttr(note, "id")}: ${text.slice(0, 120)}`);
    }
  }
}
main().catch((error) => {
  console.error(`[ERROR] ${error.message}`);
  process.exitCode = 2;
});
