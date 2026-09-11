#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const XML_NS = "http://www.w3.org/XML/1998/namespace";
const PLACEHOLDER_RE = /\{\{([A-Za-z0-9_-]+)\}\}/g;
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
function setWAttr(node, name, value) {
  node.setAttributeNS(W_NS, `w:${name}`, String(value));
}
function create(doc, name) {
  return doc.createElementNS(W_NS, `w:${name}`);
}
function preserveText(node, value) {
  node.appendChild(node.ownerDocument.createTextNode(value));
  if (/^\s|\s$/.test(value)) node.setAttributeNS(XML_NS, "xml:space", "preserve");
}
function textOf(root) {
  return descendants(root, "t")
    .map((node) => node.textContent || "")
    .join("");
}
function sdtTag(sdt) {
  const props = direct(sdt, "sdtPr")[0];
  return wAttr(direct(props, "tag")[0], "val");
}
function sdtAlias(sdt) {
  const props = direct(sdt, "sdtPr")[0];
  return wAttr(direct(props, "alias")[0], "val");
}
function makeRun(doc, text, rPr) {
  const run = create(doc, "r");
  if (rPr) run.appendChild(rPr.cloneNode(true));
  const t = create(doc, "t");
  preserveText(t, text);
  run.appendChild(t);
  return run;
}
function makeSdt(doc, tag, placeholder, rPr) {
  const sdt = create(doc, "sdt");
  const props = create(doc, "sdtPr");
  const tagNode = create(doc, "tag");
  setWAttr(tagNode, "val", tag);
  const alias = create(doc, "alias");
  setWAttr(alias, "val", tag);
  props.appendChild(tagNode);
  props.appendChild(alias);
  props.appendChild(create(doc, "text"));
  const content = create(doc, "sdtContent");
  content.appendChild(makeRun(doc, placeholder, rPr));
  sdt.appendChild(props);
  sdt.appendChild(content);
  return sdt;
}
function wrapTree(root) {
  let changed = 0;
  for (const run of descendants(root, "r")) {
    const texts = direct(run, "t");
    const full = texts.map((node) => node.textContent || "").join("");
    if (!full || !PLACEHOLDER_RE.test(full)) {
      PLACEHOLDER_RE.lastIndex = 0;
      continue;
    }
    PLACEHOLDER_RE.lastIndex = 0;
    const parent = run.parentNode;
    if (!parent) continue;
    const rPr = direct(run, "rPr")[0];
    const nodes = [];
    let cursor = 0;
    for (const match of full.matchAll(PLACEHOLDER_RE)) {
      if (match.index > cursor)
        nodes.push(makeRun(root.ownerDocument, full.slice(cursor, match.index), rPr));
      nodes.push(makeSdt(root.ownerDocument, match[1], match[0], rPr));
      cursor = match.index + match[0].length;
    }
    if (cursor < full.length) nodes.push(makeRun(root.ownerDocument, full.slice(cursor), rPr));
    const index = Array.from(parent.childNodes).indexOf(run);
    parent.removeChild(run);
    for (const [offset, node] of nodes.entries())
      parent.insertBefore(node, parent.childNodes[index + offset] || null);
    changed += 1;
  }
  return changed;
}
function fillTree(root, values) {
  let updated = 0;
  for (const sdt of descendants(root, "sdt")) {
    const tag = sdtTag(sdt);
    if (!tag || !Object.prototype.hasOwnProperty.call(values, tag)) continue;
    const content = direct(sdt, "sdtContent")[0];
    if (!content) continue;
    const firstRpr = descendants(content, "rPr")[0];
    const block = direct(content, "p").length > 0;
    for (const child of Array.from(content.childNodes)) content.removeChild(child);
    if (block) {
      const p = create(root.ownerDocument, "p");
      p.appendChild(makeRun(root.ownerDocument, values[tag], firstRpr));
      content.appendChild(p);
    } else content.appendChild(makeRun(root.ownerDocument, values[tag], firstRpr));
    updated += 1;
  }
  return updated;
}
function parts(zip, includeHeaders) {
  return Object.keys(zip.files).filter(
    (name) =>
      name === "word/document.xml" ||
      (includeHeaders && /^word\/(?:header|footer)\d+\.xml$/.test(name)),
  );
}
function parsePairs(values) {
  const result = {};
  for (const value of values) {
    const i = value.indexOf("=");
    if (i < 0) throw new Error(`Invalid --set '${value}' (expected TAG=VALUE)`);
    const key = value.slice(0, i).trim();
    if (!key) throw new Error(`Invalid --set '${value}' (empty TAG)`);
    result[key] = value.slice(i + 1);
  }
  return result;
}
async function main() {
  const invocationArgs = process.argv.slice(2);
  if (invocationArgs.includes("--help") || invocationArgs.includes("-h")) {
    process.stdout.write(
      [
        "usage: content_controls.mjs [-h] docx {list,wrap_placeholders,fill} ...",
        "",
        "Work with Word content controls (SDTs) in a DOCX",
        "",
        "positional arguments:",
        "  docx                  Input .docx",
        "  {list,wrap_placeholders,fill}",
        "    list                List SDTs",
        "    wrap_placeholders   Wrap {{TAG}} placeholders into SDTs",
        "    fill                Fill SDTs by tag",
        "",
        "options:",
        "  -h, --help            show this help message and exit",
        "",
      ].join("\n"),
    );
    return;
  }
  if (invocationArgs.length === 0) {
    process.stderr.write(
      [
        "usage: content_controls.mjs [-h] docx {list,wrap_placeholders,fill} ...",
        "content_controls.mjs: error: the following arguments are required: docx, cmd",
        "",
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }
  const args = process.argv.slice(2);
  const input = args[0];
  const command = args[1];
  let output = null,
    json = false,
    includeHeaders = true,
    pairs = [];
  for (let i = 2; i < args.length; i += 1) {
    if (args[i] === "--output") output = args[++i];
    else if (args[i] === "--no_headers_footers") includeHeaders = false;
    else if (args[i] === "--json") json = true;
    else if (args[i] === "--set") pairs.push(args[++i]);
    else {
      console.error(`unknown argument: ${args[i]}`);
      process.exitCode = 2;
      return;
    }
  }
  if (!input || !["list", "wrap_placeholders", "fill"].includes(command)) {
    console.error("usage: content_controls.mjs input.docx list|wrap_placeholders|fill [options]");
    process.exitCode = 2;
    return;
  }
  const zip = await JSZip.loadAsync(await fs.readFile(input));
  if (command === "list") {
    const rows = [];
    for (const name of parts(zip, includeHeaders)) {
      const root = parseXml(await zip.file(name).async("nodebuffer")).documentElement;
      for (const sdt of descendants(root, "sdt")) {
        const content = direct(sdt, "sdtContent")[0];
        rows.push({
          part: name,
          tag: sdtTag(sdt),
          alias: sdtAlias(sdt),
          text: textOf(content || sdt),
        });
      }
    }
    if (json) console.log(JSON.stringify(rows, null, 2));
    else if (!rows.length) console.log("[content_controls] no SDTs found");
    else
      for (const row of rows)
        console.log(
          `- ${row.part}: tag=${row.tag || "(no-tag)"} alias=${row.alias || ""} text=${row.text.replaceAll("\n", " ")}`,
        );
    return;
  }
  if (!output) throw new Error("--output is required");
  const out = new JSZip();
  let total = 0;
  const values = command === "fill" ? parsePairs(pairs) : null;
  if (command === "fill" && !pairs.length)
    throw new Error("fill requires at least one --set TAG=VALUE");
  for (const [name, entry] of Object.entries(zip.files)) {
    if (parts(zip, includeHeaders).includes(name)) {
      const doc = parseXml(await entry.async("nodebuffer"));
      total +=
        command === "fill" ? fillTree(doc.documentElement, values) : wrapTree(doc.documentElement);
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
  if (command === "fill") console.log(`[content_controls] filled ${total} SDT(s); wrote ${output}`);
  else console.log(`[content_controls] wrapped placeholders in ${total} run(s); wrote ${output}`);
}
main().catch((error) => {
  console.error(`[ERROR] ${error.message}`);
  process.exitCode = 2;
});
