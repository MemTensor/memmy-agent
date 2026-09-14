#!/usr/bin/env node
import fs from "node:fs/promises";
import JSZip from "jszip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const WP_NS = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const NONDESCRIPTIVE = new Set(["click here", "here", "link", "this link"]);

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
  const result = [];
  const visit = (node) => {
    for (let child = node?.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 1) {
        if (!name || localName(child) === name) result.push(child);
        visit(child);
      }
    }
  };
  visit(root);
  return result;
}
function children(root, name) {
  const result = [];
  for (let child = root?.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1 && (!name || localName(child) === name)) result.push(child);
  }
  return result;
}
function firstChild(root, name) {
  return children(root, name)[0] ?? null;
}
function attr(node, namespace, name) {
  return (
    node?.getAttributeNS(namespace, name) ||
    node?.getAttribute(name) ||
    node?.getAttribute(`w:${name}`) ||
    ""
  );
}
function setAttr(node, namespace, name, value) {
  node.setAttributeNS(namespace, `w:${name}`, String(value));
}
function textOf(root, textNames = new Set(["t"])) {
  return descendants(root)
    .filter((node) => textNames.has(localName(node)))
    .map((node) => node.textContent || "")
    .join("");
}
function createElement(doc, name, namespace = W_NS) {
  return doc.createElementNS(namespace, `w:${name}`);
}
async function loadZip(file) {
  return JSZip.loadAsync(await fs.readFile(file));
}
async function writeZip(inputZip, output, overrides) {
  const out = new JSZip();
  for (const [name, entry] of Object.entries(inputZip.files)) {
    out.file(name, overrides.has(name) ? overrides.get(name) : await entry.async("nodebuffer"), {
      binary: true,
      createFolders: false,
      date: entry.date,
      unixPermissions: entry.unixPermissions,
    });
  }
  for (const [name, data] of overrides)
    if (!inputZip.files[name]) out.file(name, data, { binary: true });
  await fs.writeFile(
    output,
    await out.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
  );
}
function storyParts(zip) {
  return [
    "word/document.xml",
    ...Object.keys(zip.files).filter((name) => /^word\/(?:header|footer)\d+\.xml$/.test(name)),
  ];
}
function headingLevel(value) {
  const match = /^Heading\s*(\d+)$/.exec(value || "");
  return match ? Number(match[1]) : null;
}
async function relMap(zip) {
  const entry = zip.file("word/_rels/document.xml.rels");
  if (!entry) return {};
  const doc = parseXml(await entry.async("nodebuffer"));
  return Object.fromEntries(
    children(doc.documentElement, "Relationship")
      .map((rel) => [rel.getAttribute("Id"), rel.getAttribute("Target")])
      .filter(([id, target]) => id && target),
  );
}
function finding(severity, kind, message, context) {
  return { severity, kind, message, context };
}

function auditHeadings(root, part) {
  const result = [];
  let last = null;
  for (const p of descendants(root, "p")) {
    const pPr = firstChild(p, "pPr");
    const style = firstChild(pPr, "pStyle");
    const level = headingLevel(attr(style, W_NS, "val"));
    if (level == null) continue;
    if (last != null && level > last + 1)
      result.push(
        finding("medium", "heading_skip", `Heading level jumped from ${last} to ${level}`, {
          part,
          text: textOf(p).slice(0, 120),
        }),
      );
    last = level;
  }
  return result;
}
function auditImages(root, part) {
  return descendants(root, "docPr")
    .filter(
      (node) =>
        !(node.getAttribute("descr") || "").trim() && !(node.getAttribute("title") || "").trim(),
    )
    .map((node) =>
      finding("high", "image_missing_alt", "Image missing alt text (descr/title empty)", {
        part,
        id: node.getAttribute("id"),
        name: node.getAttribute("name"),
      }),
    );
}
function auditTables(root, part) {
  const result = [];
  for (const table of descendants(root, "tbl")) {
    const row = children(table, "tr")[0];
    if (!row) continue;
    const trPr = firstChild(row, "trPr");
    if (!firstChild(trPr, "tblHeader"))
      result.push(
        finding(
          "medium",
          "table_no_header_row",
          "Table first row is not marked as header (w:tblHeader missing)",
          { part },
        ),
      );
  }
  return result;
}
function auditHyperlinks(root, part) {
  const result = [];
  for (const hyperlink of descendants(root, "hyperlink")) {
    const text = textOf(hyperlink).trim();
    if (!text) continue;
    const lower = text.toLowerCase();
    if (NONDESCRIPTIVE.has(lower))
      result.push(
        finding("medium", "hyperlink_nondescriptive", `Non-descriptive hyperlink text: '${text}'`, {
          part,
        }),
      );
    if (/https?:\/\/\S+/i.test(text) && /^https?:\/\/\S+$/i.test(text))
      result.push(
        finding(
          "low",
          "hyperlink_raw_url",
          "Hyperlink display text is a raw URL (often less accessible)",
          { part, text: text.slice(0, 120) },
        ),
      );
  }
  return result;
}
function imageAltFix(root, rels) {
  let changed = 0;
  for (const drawing of descendants(root, "drawing")) {
    const docPr = descendants(drawing, "docPr")[0];
    if (
      !docPr ||
      (docPr.getAttribute("descr") || "").trim() ||
      (docPr.getAttribute("title") || "").trim()
    )
      continue;
    const blip = descendants(drawing, "blip")[0];
    const rid = blip?.getAttributeNS(R_NS, "embed") || blip?.getAttribute("r:embed");
    const target = rid ? rels[rid] : null;
    const filename = target ? target.split("/").pop() : null;
    docPr.setAttribute("descr", filename ? `Image: ${filename}` : "Image");
    changed += 1;
  }
  return changed;
}
function tableHeaderFix(root) {
  let changed = 0;
  for (const table of descendants(root, "tbl")) {
    const row = children(table, "tr")[0];
    if (!row) continue;
    let trPr = firstChild(row, "trPr");
    if (!trPr) {
      trPr = createElement(root.ownerDocument, "trPr");
      row.appendChild(trPr);
    }
    if (!firstChild(trPr, "tblHeader")) {
      trPr.appendChild(createElement(root.ownerDocument, "tblHeader"));
      changed += 1;
    }
  }
  return changed;
}
async function audit(path) {
  const zip = await loadZip(path);
  const findings = storyParts(zip).flatMap((part) => {
    return part;
  });
  const allFindings = [];
  for (const part of findings) {
    const entry = zip.file(part);
    if (!entry) continue;
    const root = parseXml(await entry.async("nodebuffer"));
    allFindings.push(
      ...auditHeadings(root, part),
      ...auditImages(root, part),
      ...auditTables(root, part),
      ...auditHyperlinks(root, part),
    );
  }
  return {
    file: path,
    counts: {
      high: allFindings.filter((x) => x.severity === "high").length,
      medium: allFindings.filter((x) => x.severity === "medium").length,
      low: allFindings.filter((x) => x.severity === "low").length,
    },
    findings: allFindings,
  };
}
async function auditAndFix(input, output, fixImageAlt, fixTableHeaders) {
  const zip = await loadZip(input);
  const rels = await relMap(zip);
  const overrides = new Map();
  const stats = { image_alt_filled: 0, table_headers_set: 0 };
  for (const part of storyParts(zip)) {
    const entry = zip.file(part);
    if (!entry) continue;
    const root = parseXml(await entry.async("nodebuffer"));
    let changed = false;
    if (fixImageAlt === "from_filename") {
      const count = imageAltFix(root, rels);
      stats.image_alt_filled += count;
      changed ||= count > 0;
    }
    if (fixTableHeaders === "first_row") {
      const count = tableHeaderFix(root);
      stats.table_headers_set += count;
      changed ||= count > 0;
    }
    if (changed) overrides.set(part, xmlBytes(root));
  }
  await writeZip(zip, output, overrides);
  return stats;
}
function formatStats(value) {
  return `{${Object.entries(value)
    .map(([key, item]) => `'${key}': ${typeof item === "string" ? `'${item}'` : item}`)
    .join(", ")}}`;
}
function usageError(message) {
  console.error(message);
  process.exitCode = 2;
}
async function main() {
  const invocationArgs = process.argv.slice(2);
  if (invocationArgs.includes("--help") || invocationArgs.includes("-h")) {
    process.stdout.write(
      [
        "usage: a11y_audit.mjs [-h] [--fix_image_alt {from_filename}]",
        "                     [--fix_table_headers {first_row}] [--out OUT]",
        "                     [--out_json OUT_JSON]",
        "                     in_docx",
        "",
        "positional arguments:",
        "  in_docx",
        "",
        "options:",
        "  -h, --help            show this help message and exit",
        "  --fix_image_alt {from_filename}",
        "                        Apply safe image alt fix",
        "  --fix_table_headers {first_row}",
        "                        Mark first row as header",
        "  --out OUT             Write fixed DOCX",
        "  --out_json OUT_JSON   Optional path to write the audit report JSON. When",
        "                        provided, stdout only prints a short summary.",
        "",
      ].join("\n"),
    );
    return;
  }
  if (invocationArgs.length === 0) {
    process.stderr.write(
      [
        "usage: a11y_audit.mjs [-h] [--fix_image_alt {from_filename}]",
        "                     [--fix_table_headers {first_row}] [--out OUT]",
        "                     [--out_json OUT_JSON]",
        "                     in_docx",
        "a11y_audit.mjs: error: the following arguments are required: in_docx",
        "",
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }
  const args = process.argv.slice(2);
  const input = args[0];
  if (!input)
    return usageError(
      "usage: a11y_audit.mjs input.docx [--fix_image_alt from_filename] [--fix_table_headers first_row] [--out fixed.docx] [--out_json report.json]",
    );
  let fixImageAlt = null,
    fixTableHeaders = null,
    output = null,
    outJson = null;
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === "--fix_image_alt") fixImageAlt = args[++i];
    else if (args[i] === "--fix_table_headers") fixTableHeaders = args[++i];
    else if (args[i] === "--out") output = args[++i];
    else if (args[i] === "--out_json") outJson = args[++i];
    else return usageError(`unknown argument: ${args[i]}`);
  }
  if ((fixImageAlt || fixTableHeaders) && !output)
    return usageError("--out is required when applying fixes");
  const stats =
    fixImageAlt || fixTableHeaders
      ? await auditAndFix(input, output, fixImageAlt, fixTableHeaders)
      : null;
  if (stats) console.log(`[OK] wrote ${output} | ${formatStats(stats)}`);
  const report = await audit(stats ? output : input);
  if (outJson) {
    await fs.writeFile(outJson, JSON.stringify(report, null, 2) + "\n");
    console.log(
      `[a11y] wrote report -> ${outJson} | high=${report.counts.high} medium=${report.counts.medium} low=${report.counts.low}`,
    );
  } else console.log(JSON.stringify(report, null, 2));
  if (report.counts.high > 0) process.exitCode = 1;
}
main().catch((error) => {
  console.error(`[ERROR] ${error.message}`);
  process.exitCode = 2;
});
