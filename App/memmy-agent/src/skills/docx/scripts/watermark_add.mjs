#!/usr/bin/env node
import fs from "node:fs/promises";
import JSZip from "jszip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const V_NS = "urn:schemas-microsoft-com:vml";
const O_NS = "urn:schemas-microsoft-com:office:office";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const HEADER_CT = "application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml";
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
function create(doc, ns, prefix, name) {
  return doc.createElementNS(ns, `${prefix}:${name}`);
}
function watermarkParagraph(doc, text) {
  const p = create(doc, W_NS, "w", "p");
  const run = create(doc, W_NS, "w", "r");
  const pict = create(doc, W_NS, "w", "pict");
  const shape = create(doc, V_NS, "v", "shape");
  shape.setAttribute("id", "DocxSkillWatermark");
  shape.setAttributeNS(O_NS, "o:spid", "_x0000_s1025");
  shape.setAttribute("type", "#_x0000_t136");
  shape.setAttribute(
    "style",
    "position:absolute;margin-left:0;margin-top:0;width:468pt;height:468pt;rotation:315;z-index:-251654144;mso-position-horizontal:center;mso-position-vertical:center;mso-wrap-edited:f;",
  );
  shape.setAttribute("fillcolor", "#C0C0C0");
  shape.setAttribute("stroked", "f");
  const fill = create(doc, V_NS, "v", "fill");
  fill.setAttribute("opacity", "0.15");
  const textpath = create(doc, V_NS, "v", "textpath");
  textpath.setAttribute("style", 'font-family:"Calibri";font-size:1pt');
  textpath.setAttribute("string", text);
  const pathNode = create(doc, V_NS, "v", "path");
  pathNode.setAttribute("textpathok", "t");
  shape.appendChild(fill);
  shape.appendChild(textpath);
  shape.appendChild(pathNode);
  pict.appendChild(shape);
  run.appendChild(pict);
  p.appendChild(run);
  return p;
}
function minimalHeader() {
  return parseXml(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:w="${W_NS}" xmlns:r="${R_NS}" xmlns:v="${V_NS}" xmlns:o="${O_NS}"><w:p><w:r><w:t xml:space="preserve"> </w:t></w:r></w:p></w:hdr>`,
  );
}
function nextHeaderName(zip) {
  const values = Object.keys(zip.files)
    .map((name) => /^word\/header(\d+)\.xml$/.exec(name)?.[1])
    .filter(Boolean)
    .map(Number);
  return `word/header${values.length ? Math.max(...values) + 1 : 1}.xml`;
}
async function main() {
  const invocationArgs = process.argv.slice(2);
  if (invocationArgs.includes("--help") || invocationArgs.includes("-h")) {
    process.stdout.write(
      [
        "usage: watermark_add.mjs [-h] --out OUT --text TEXT in_docx",
        "",
        "Add a VML watermark-like object to a DOCX header",
        "",
        "positional arguments:",
        "  in_docx",
        "",
        "options:",
        "  -h, --help   show this help message and exit",
        "  --out OUT",
        "  --text TEXT  Watermark string",
        "",
      ].join("\n"),
    );
    return;
  }
  if (invocationArgs.length === 0) {
    process.stderr.write(
      [
        "usage: watermark_add.mjs [-h] --out OUT --text TEXT in_docx",
        "watermark_add.mjs: error: the following arguments are required: in_docx, --out, --text",
        "",
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }
  const args = process.argv.slice(2);
  const input = args[0];
  let output = null,
    text = null;
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === "--out") output = args[++i];
    else if (args[i] === "--text") text = args[++i];
    else {
      console.error(`unknown argument: ${args[i]}`);
      process.exitCode = 2;
      return;
    }
  }
  if (!input || !output || text == null) {
    console.error("usage: watermark_add.mjs input.docx --out out.docx --text TEXT");
    process.exitCode = 2;
    return;
  }
  const zip = await JSZip.loadAsync(await fs.readFile(input));
  let header = Object.keys(zip.files)
    .filter((name) => /^word\/header\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))[0];
  const overrides = new Map();
  const documentEntry = zip.file("word/document.xml");
  if (!documentEntry) throw new Error("word/document.xml is missing");
  const document = parseXml(await documentEntry.async("nodebuffer"));
  const body = direct(document.documentElement, "body")[0];
  if (!body) throw new Error("Missing w:body");
  if (!header) {
    header = nextHeaderName(zip);
    overrides.set(header, xmlBytes(minimalHeader()));
    const relsEntry = zip.file("word/_rels/document.xml.rels");
    const rels = relsEntry
      ? parseXml(await relsEntry.async("nodebuffer"))
      : parseXml(`<?xml version="1.0"?><Relationships xmlns="${REL_NS}"/>`);
    const relRoot = rels.documentElement;
    const ids = descendants(relRoot, "Relationship")
      .map((node) => Number((node.getAttribute("Id") || "").replace(/^rId/, "")))
      .filter(Number.isInteger);
    const rid = `rId${ids.length ? Math.max(...ids) + 1 : 1}`;
    const relationship = rels.createElementNS(REL_NS, "Relationship");
    relationship.setAttribute("Id", rid);
    relationship.setAttribute(
      "Type",
      "http://schemas.openxmlformats.org/officeDocument/2006/relationships/header",
    );
    relationship.setAttribute("Target", header.replace("word/", ""));
    relRoot.appendChild(relationship);
    overrides.set("word/_rels/document.xml.rels", xmlBytes(rels));
    const sectPr = descendants(body, "sectPr").at(-1);
    if (!sectPr) throw new Error("Missing final w:sectPr");
    const ref = create(document, W_NS, "w", "headerReference");
    setWAttr(ref, "type", "default");
    ref.setAttributeNS(R_NS, "r:id", rid);
    sectPr.insertBefore(ref, sectPr.firstChild);
    const typesEntry = zip.file("[Content_Types].xml");
    if (typesEntry) {
      const types = parseXml(await typesEntry.async("nodebuffer"));
      const override = types.createElementNS(CT_NS, "Override");
      override.setAttribute("PartName", `/${header}`);
      override.setAttribute("ContentType", HEADER_CT);
      types.documentElement.appendChild(override);
      overrides.set("[Content_Types].xml", xmlBytes(types));
    }
  }
  const headerDoc = overrides.has(header)
    ? parseXml(overrides.get(header))
    : parseXml(await zip.file(header).async("nodebuffer"));
  headerDoc.documentElement.appendChild(watermarkParagraph(headerDoc, text));
  overrides.set(header, xmlBytes(headerDoc));
  overrides.set("word/document.xml", xmlBytes(document));
  const out = new JSZip();
  for (const [name, entry] of Object.entries(zip.files))
    out.file(name, overrides.has(name) ? overrides.get(name) : await entry.async("nodebuffer"), {
      binary: true,
      createFolders: false,
      date: entry.date,
      unixPermissions: entry.unixPermissions,
    });
  for (const [name, data] of overrides)
    if (!zip.files[name]) out.file(name, data, { binary: true });
  await fs.writeFile(
    output,
    await out.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
  );
  console.log(`[OK] wrote ${output} (patched ${header})`);
}
main().catch((error) => {
  console.error(`[ERROR] ${error.message}`);
  process.exitCode = 2;
});
