#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const XML_NS = "http://www.w3.org/XML/1998/namespace";
const CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const SETTINGS_CT = "application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml";
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
function create(doc, name) {
  return doc.createElementNS(W_NS, `w:${name}`);
}
function paragraphText(p) {
  return descendants(p, "t")
    .map((node) => node.textContent || "")
    .join("");
}
function addToc(paragraph, levels) {
  const doc = paragraph.ownerDocument;
  const run = create(doc, "r");
  const begin = create(doc, "fldChar");
  begin.setAttributeNS(W_NS, "w:fldCharType", "begin");
  const instruction = create(doc, "instrText");
  instruction.setAttributeNS(XML_NS, "xml:space", "preserve");
  instruction.appendChild(doc.createTextNode(` TOC \\o "${levels}" \\h \\z \\u `));
  const separate = create(doc, "fldChar");
  separate.setAttributeNS(W_NS, "w:fldCharType", "separate");
  const result = create(doc, "t");
  result.appendChild(doc.createTextNode("(TOC will populate after updating fields)"));
  const end = create(doc, "fldChar");
  end.setAttributeNS(W_NS, "w:fldCharType", "end");
  run.appendChild(begin);
  run.appendChild(instruction);
  run.appendChild(separate);
  run.appendChild(result);
  run.appendChild(end);
  paragraph.appendChild(run);
}
async function main() {
  const invocationArgs = process.argv.slice(2);
  if (invocationArgs.includes("--help") || invocationArgs.includes("-h")) {
    process.stdout.write(
      [
        "usage: insert_toc.mjs [-h] [--out OUT] [--placeholder PLACEHOLDER]",
        "                     [--levels LEVELS]",
        "                     docx",
        "",
        "Insert a Word TOC field at a placeholder paragraph.",
        "",
        "positional arguments:",
        "  docx",
        "",
        "options:",
        "  -h, --help            show this help message and exit",
        "  --out OUT             Output DOCX path (default: in-place)",
        "  --placeholder PLACEHOLDER",
        "                        Paragraph text token to replace",
        '  --levels LEVELS       Heading levels range, e.g. "1-3"',
        "",
      ].join("\n"),
    );
    return;
  }
  if (invocationArgs.length === 0) {
    process.stderr.write(
      [
        "usage: insert_toc.mjs [-h] [--out OUT] [--placeholder PLACEHOLDER]",
        "                     [--levels LEVELS]",
        "                     docx",
        "insert_toc.mjs: error: the following arguments are required: docx",
        "",
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }
  const args = process.argv.slice(2);
  const input = args[0];
  let output = null,
    placeholder = "[[TOC]]",
    levels = "1-3";
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === "--out") output = args[++i];
    else if (args[i] === "--placeholder") placeholder = args[++i];
    else if (args[i] === "--levels") levels = args[++i];
    else {
      console.error(`unknown argument: ${args[i]}`);
      process.exitCode = 2;
      return;
    }
  }
  if (!input) {
    console.error(
      "usage: insert_toc.mjs input.docx [--out out.docx] [--placeholder [[TOC]]] [--levels 1-3]",
    );
    process.exitCode = 2;
    return;
  }
  output ||= input;
  await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
  const zip = await JSZip.loadAsync(await fs.readFile(input));
  const documentEntry = zip.file("word/document.xml");
  if (!documentEntry) throw new Error("word/document.xml is missing");
  const document = parseXml(await documentEntry.async("nodebuffer"));
  const target = descendants(document.documentElement, "p").find(
    (p) => paragraphText(p).trim() === placeholder,
  );
  if (!target)
    throw new Error(
      `Could not find a paragraph whose text == placeholder ${JSON.stringify(placeholder)}. Tip: add a single paragraph containing that token.`,
    );
  for (const child of Array.from(target.childNodes))
    if (child.nodeType === 1 && localName(child) === "r") target.removeChild(child);
  addToc(target, levels);
  const settingsEntry = zip.file("word/settings.xml");
  const settings = settingsEntry
    ? parseXml(await settingsEntry.async("nodebuffer"))
    : parseXml(`<?xml version="1.0"?><w:settings xmlns:w="${W_NS}"/>`);
  let update = direct(settings.documentElement, "updateFields")[0];
  if (!update) {
    update = create(settings, "updateFields");
    settings.documentElement.insertBefore(update, settings.documentElement.firstChild);
  }
  update.setAttributeNS(W_NS, "w:val", "true");
  const typesEntry = zip.file("[Content_Types].xml");
  if (!typesEntry) throw new Error("[Content_Types].xml is missing");
  const types = parseXml(await typesEntry.async("nodebuffer"));
  if (
    !descendants(types.documentElement, "Override").some(
      (node) => node.getAttribute("PartName") === "/word/settings.xml",
    )
  ) {
    const override = types.createElementNS(CT_NS, "Override");
    override.setAttribute("PartName", "/word/settings.xml");
    override.setAttribute("ContentType", SETTINGS_CT);
    types.documentElement.appendChild(override);
  }
  const replacements = new Map([
    ["word/document.xml", xmlBytes(document)],
    ["word/settings.xml", xmlBytes(settings)],
    ["[Content_Types].xml", xmlBytes(types)],
  ]);
  const out = new JSZip();
  for (const [name, entry] of Object.entries(zip.files))
    out.file(
      name,
      replacements.has(name) ? replacements.get(name) : await entry.async("nodebuffer"),
      {
        binary: true,
        createFolders: false,
        date: entry.date,
        unixPermissions: entry.unixPermissions,
      },
    );
  for (const [name, data] of replacements)
    if (!zip.files[name]) out.file(name, data, { binary: true });
  await fs.writeFile(
    output,
    await out.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
  );
  console.log(
    `[OK] Inserted TOC field at placeholder '${placeholder.replaceAll("'", "\\'")}' → ${output}`,
  );
  console.log("Next: open in Word → Ctrl+A → F9 (Update Fields) → save → re-render.");
}
main().catch((error) => {
  console.error(`[ERROR] ${error.message}`);
  process.exitCode = 2;
});
