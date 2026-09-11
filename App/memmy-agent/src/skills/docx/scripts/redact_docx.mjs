#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
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
function textNodes(paragraph) {
  return descendants(paragraph, "t");
}
function applyParagraph(paragraph, rules, mask, replacement, preserve) {
  const nodes = textNodes(paragraph);
  if (!nodes.length) return 0;
  const segments = nodes.map((node) => node.textContent || "");
  const full = segments.join("");
  if (!full) return 0;
  const spans = [];
  for (const rule of rules) {
    rule.regex.lastIndex = 0;
    for (const match of full.matchAll(rule.regex))
      if (match.index !== match.index + match[0].length)
        spans.push([match.index, match.index + match[0].length]);
  }
  spans.sort((a, b) => a[0] - b[0] || b[1] - b[0] - (a[1] - a[0]));
  const selected = [];
  let lastEnd = -1;
  for (const span of spans)
    if (span[0] >= lastEnd) {
      selected.push(span);
      lastEnd = span[1];
    }
  if (!selected.length) return 0;
  const chars = Array.from(full);
  for (const [start, end] of [...selected].reverse()) {
    const length = end - start;
    let value =
      replacement == null
        ? mask.repeat(length)
        : replacement.repeat(Math.ceil(length / Math.max(1, replacement.length))).slice(0, length);
    if (!preserve) value = replacement == null ? mask.repeat(length) : replacement;
    chars.splice(start, length, ...Array.from(value));
  }
  const rewritten = chars.join("");
  let offset = 0;
  for (let i = 0; i < nodes.length; i += 1) {
    const length = segments[i].length;
    const value = rewritten.slice(offset, offset + length);
    while (nodes[i].firstChild) nodes[i].removeChild(nodes[i].firstChild);
    nodes[i].appendChild(nodes[i].ownerDocument.createTextNode(value));
    if (/^\s|\s$/.test(value)) nodes[i].setAttributeNS(XML_NS, "xml:space", "preserve");
    offset += length;
  }
  return selected.length;
}
function makeRules(args) {
  const rules = [];
  if (args.emails) rules.push({ regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi });
  if (args.phones)
    rules.push({ regex: /(?:(?:\+?\d{1,3}[\s-]?)?(?:\(\d{3}\)|\d{3})[\s-]?)\d{3}[\s-]?\d{4}/gi });
  for (const value of args.patterns) {
    let regex = new RegExp(value, "g");
    rules.push({ regex });
  }
  if (!rules.length)
    throw new Error("No redaction rules specified. Use --emails/--phones and/or --pattern REGEX.");
  return rules;
}
async function main() {
  const invocationArgs = process.argv.slice(2);
  if (invocationArgs.includes("--help") || invocationArgs.includes("-h")) {
    process.stdout.write(
      [
        "usage: redact_docx.mjs [-h] [--emails] [--phones] [--pattern PATTERN]",
        "                      [--mask_char MASK_CHAR] [--replacement REPLACEMENT]",
        "                      [--no_preserve_length] [--include_comments]",
        "                      input_docx output_docx",
        "",
        "Redact/anonymize text in a DOCX (OOXML patch).",
        "",
        "positional arguments:",
        "  input_docx",
        "  output_docx",
        "",
        "options:",
        "  -h, --help            show this help message and exit",
        "",
        "rules:",
        "  --emails              Redact email addresses",
        "  --phones              Redact phone-like numbers",
        "  --pattern PATTERN     Custom regex to redact (can be repeated)",
        "",
        "output:",
        "  --mask_char MASK_CHAR",
        "                        Mask character for length-preserving redaction",
        "                        (default: █)",
        "  --replacement REPLACEMENT",
        "                        Optional replacement string. If --preserve_length",
        "                        (default), it will be repeated/truncated to match each",
        "                        match's length.",
        "  --no_preserve_length  Disable length preservation (may cause layout drift)",
        "  --include_comments    Also redact word/comments.xml (if present)",
        "",
      ].join("\n"),
    );
    return;
  }
  if (invocationArgs.length === 0) {
    process.stderr.write(
      [
        "usage: redact_docx.mjs [-h] [--emails] [--phones] [--pattern PATTERN]",
        "                      [--mask_char MASK_CHAR] [--replacement REPLACEMENT]",
        "                      [--no_preserve_length] [--include_comments]",
        "                      input_docx output_docx",
        "redact_docx.mjs: error: the following arguments are required: input_docx, output_docx",
        "",
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }
  const args = process.argv.slice(2);
  const input = args[0],
    output = args[1];
  let mask = "█",
    replacement = null,
    preserve = true,
    includeComments = false,
    emails = false,
    phones = false,
    patterns = [];
  for (let i = 2; i < args.length; i += 1) {
    if (args[i] === "--emails") emails = true;
    else if (args[i] === "--phones") phones = true;
    else if (args[i] === "--pattern") patterns.push(args[++i]);
    else if (args[i] === "--mask_char") mask = args[++i];
    else if (args[i] === "--replacement") replacement = args[++i];
    else if (args[i] === "--no_preserve_length") preserve = false;
    else if (args[i] === "--include_comments") includeComments = true;
    else {
      console.error(`unknown argument: ${args[i]}`);
      process.exitCode = 2;
      return;
    }
  }
  if (!input || !output) {
    console.error(
      "usage: redact_docx.mjs input.docx output.docx [--emails|--phones|--pattern REGEX]",
    );
    process.exitCode = 2;
    return;
  }
  const rules = makeRules({ emails, phones, patterns });
  const zip = await JSZip.loadAsync(await fs.readFile(input));
  const out = new JSZip();
  const partPattern = /^word\/(?:document|footnotes|endnotes|header\d+|footer\d+|comments)\.xml$/;
  const stats = { file: input, parts_processed: 0, paragraphs_touched: 0, matches_redacted: 0 };
  for (const [name, entry] of Object.entries(zip.files)) {
    if (partPattern.test(name) && (includeComments || name !== "word/comments.xml")) {
      const doc = parseXml(await entry.async("nodebuffer"));
      let touched = 0,
        matches = 0;
      for (const paragraph of descendants(doc.documentElement, "p")) {
        const count = applyParagraph(paragraph, rules, mask, replacement, preserve);
        if (count) {
          touched += 1;
          matches += count;
        }
      }
      stats.parts_processed += 1;
      stats.paragraphs_touched += touched;
      stats.matches_redacted += matches;
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
  await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
  await fs.writeFile(
    output,
    await out.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
  );
  console.log(JSON.stringify(stats, null, 2));
}
main().catch((error) => {
  console.error(`[ERROR] ${error.message}`);
  process.exitCode = 2;
});
