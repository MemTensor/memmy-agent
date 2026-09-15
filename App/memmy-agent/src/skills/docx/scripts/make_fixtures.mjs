#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const V_NS = "urn:schemas-microsoft-com:vml";
const O_NS = "urn:schemas-microsoft-com:office:office";
function parseXml(text) {
  return new DOMParser().parseFromString(text, "application/xml");
}
function xmlBytes(doc) {
  let value = new XMLSerializer().serializeToString(doc);
  if (!value.startsWith("<?xml"))
    value = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + value;
  return Buffer.from(value);
}
function create(doc, ns, prefix, name) {
  return doc.createElementNS(ns, `${prefix}:${name}`);
}
function textParagraph(doc, text, style = null) {
  const p = create(doc, W_NS, "w", "p");
  if (style) {
    const pPr = create(doc, W_NS, "w", "pPr"),
      pStyle = create(doc, W_NS, "w", "pStyle");
    pStyle.setAttributeNS(W_NS, "w:val", style);
    pPr.appendChild(pStyle);
    p.appendChild(pPr);
  }
  const r = create(doc, W_NS, "w", "r"),
    t = create(doc, W_NS, "w", "t");
  t.appendChild(doc.createTextNode(text));
  if (/^\s|\s$/.test(text)) t.setAttribute("xml:space", "preserve");
  r.appendChild(t);
  p.appendChild(r);
  return p;
}
function baseParts(includeHeader) {
  const document = parseXml(
    `<?xml version="1.0"?><w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}"><w:body></w:body></w:document>`,
  );
  const body = document.documentElement.getElementsByTagNameNS(W_NS, "body")[0];
  if (includeHeader) {
    body.appendChild(textParagraph(document, "Watermark Fixture", "Heading1"));
    body.appendChild(
      textParagraph(
        document,
        "This file contains a VML watermark-like header shape with text DRAFT.",
      ),
    );
    body.appendChild(
      textParagraph(document, "LibreOffice headless may not render it; use OOXML audit/removal."),
    );
  } else {
    body.appendChild(textParagraph(document, "Tracked Changes Fixture", "Heading1"));
    body.appendChild(textParagraph(document, "Sentence with a pending edit: REPLACE_ME"));
    body.appendChild(textParagraph(document, "End of fixture."));
  }
  const sectPr = create(document, W_NS, "w", "sectPr");
  const pgSz = create(document, W_NS, "w", "pgSz");
  pgSz.setAttributeNS(W_NS, "w:w", "12240");
  pgSz.setAttributeNS(W_NS, "w:h", "15840");
  sectPr.appendChild(pgSz);
  const pgMar = create(document, W_NS, "w", "pgMar");
  for (const [name, value] of [
    ["top", "1440"],
    ["right", "1800"],
    ["bottom", "1440"],
    ["left", "1800"],
    ["header", "720"],
    ["footer", "720"],
    ["gutter", "0"],
  ])
    pgMar.setAttributeNS(W_NS, `w:${name}`, value);
  sectPr.appendChild(pgMar);
  const cols = create(document, W_NS, "w", "cols");
  cols.setAttributeNS(W_NS, "w:space", "720");
  sectPr.appendChild(cols);
  const docGrid = create(document, W_NS, "w", "docGrid");
  docGrid.setAttributeNS(W_NS, "w:linePitch", "360");
  sectPr.appendChild(docGrid);
  if (includeHeader) {
    const ref = create(document, W_NS, "w", "headerReference");
    ref.setAttributeNS(W_NS, "w:type", "default");
    ref.setAttributeNS(R_NS, "r:id", "rId2");
    sectPr.appendChild(ref);
  }
  body.appendChild(sectPr);
  const styles = `<?xml version="1.0"?><w:styles xmlns:w="${W_NS}"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`;
  const settings = `<?xml version="1.0"?><w:settings xmlns:w="${W_NS}"/>`;
  const rels = `<?xml version="1.0"?><Relationships xmlns="${REL_NS}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  const docRels = includeHeader
    ? `<?xml version="1.0"?><Relationships xmlns="${REL_NS}"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/></Relationships>`
    : `<?xml version="1.0"?><Relationships xmlns="${REL_NS}"/>`;
  const types = `<?xml version="1.0"?><Types xmlns="${CT_NS}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"${includeHeader ? ' /><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' : "/>"} </Types>`;
  return {
    document,
    styles: Buffer.from(styles),
    settings: Buffer.from(settings),
    rels: Buffer.from(rels),
    docRels: Buffer.from(docRels),
    types: Buffer.from(types),
    header: includeHeader
      ? Buffer.from(
          `<?xml version="1.0"?><w:hdr xmlns:w="${W_NS}" xmlns:v="${V_NS}" xmlns:o="${O_NS}"><w:p/></w:hdr>`,
        )
      : null,
  };
}
function watermarkParagraph(doc, text) {
  const p = create(doc, W_NS, "w", "p"),
    r = create(doc, W_NS, "w", "r"),
    pict = create(doc, W_NS, "w", "pict"),
    shape = create(doc, V_NS, "v", "shape");
  shape.setAttribute("id", "PowerPlusWaterMarkObject1");
  shape.setAttributeNS(O_NS, "o:spid", "_x0000_s1025");
  shape.setAttribute("type", "#_x0000_t136");
  shape.setAttribute(
    "style",
    "position:absolute;margin-left:0;margin-top:0;width:468pt;height:234pt;rotation:315",
  );
  shape.setAttribute("fillcolor", "#d0d0d0");
  shape.setAttribute("stroked", "f");
  const fill = create(doc, V_NS, "v", "fill");
  fill.setAttribute("opacity", ".25");
  const textpath = create(doc, V_NS, "v", "textpath");
  textpath.setAttribute("style", "font-family:'Calibri';font-size:1pt");
  textpath.setAttribute("string", text);
  shape.appendChild(fill);
  shape.appendChild(textpath);
  pict.appendChild(shape);
  r.appendChild(pict);
  p.appendChild(r);
  return p;
}
async function writeFixture(file, parts) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", parts.types);
  zip.file("_rels/.rels", parts.rels);
  zip.file("word/document.xml", xmlBytes(parts.document));
  zip.file("word/styles.xml", parts.styles);
  zip.file("word/settings.xml", parts.settings);
  zip.file("word/_rels/document.xml.rels", parts.docRels);
  if (parts.header) zip.file("word/header1.xml", parts.header);
  await fs.writeFile(file, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}
async function makeTracked(file) {
  const parts = baseParts(false);
  const document = parts.document;
  const runs = Array.from(document.documentElement.getElementsByTagNameNS(W_NS, "r"));
  const run = runs.find((item) => item.textContent.includes("REPLACE_ME"));
  if (!run) throw new Error("Could not find marker text REPLACE_ME in generated document.xml");
  const parent = run.parentNode;
  const index = Array.from(parent.childNodes).indexOf(run);
  const full = run.textContent || "";
  const marker = "REPLACE_ME";
  const before = full.slice(0, full.indexOf(marker));
  const after = full.slice(full.indexOf(marker) + marker.length);
  const replacementNodes = [];
  if (before) replacementNodes.push(textParagraph(document, before).firstChild);
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const del = create(document, W_NS, "w", "del");
  del.setAttributeNS(W_NS, "w:id", "1");
  del.setAttributeNS(W_NS, "w:date", now);
  const delRun = create(document, W_NS, "w", "r"),
    delText = create(document, W_NS, "w", "delText");
  delText.appendChild(document.createTextNode(marker));
  delRun.appendChild(delText);
  del.appendChild(delRun);
  replacementNodes.push(del);
  const ins = create(document, W_NS, "w", "ins");
  ins.setAttributeNS(W_NS, "w:id", "2");
  ins.setAttributeNS(W_NS, "w:date", now);
  const insRun = create(document, W_NS, "w", "r"),
    insText = create(document, W_NS, "w", "t");
  insText.appendChild(document.createTextNode("INSERTED_TEXT"));
  insRun.appendChild(insText);
  ins.appendChild(insRun);
  replacementNodes.push(ins);
  if (after) replacementNodes.push(textParagraph(document, after).firstChild);
  parent.removeChild(run);
  for (const [offset, node] of replacementNodes.entries())
    parent.insertBefore(node, parent.childNodes[index + offset] || null);
  const settings = parseXml(parts.settings.toString());
  settings.documentElement.appendChild(create(settings, W_NS, "w", "trackRevisions"));
  parts.settings = xmlBytes(settings);
  await writeFixture(file, parts);
}
async function makeWatermark(file) {
  const parts = baseParts(true);
  const header = parseXml(parts.header.toString());
  header.documentElement.insertBefore(
    watermarkParagraph(header, "DRAFT"),
    header.documentElement.firstChild,
  );
  parts.header = xmlBytes(header);
  await writeFixture(file, parts);
}
async function main() {
  const invocationArgs = process.argv.slice(2);
  if (invocationArgs.includes("--help") || invocationArgs.includes("-h")) {
    process.stdout.write(
      [
        "usage: make_fixtures.mjs [-h] --outdir OUTDIR [--only {tracked,watermark,all}]",
        "",
        "options:",
        "  -h, --help            show this help message and exit",
        "  --outdir OUTDIR       Directory to write fixtures",
        "  --only {tracked,watermark,all}",
        "                        Which fixtures to generate",
        "",
      ].join("\n"),
    );
    return;
  }
  if (invocationArgs.length === 0) {
    process.stderr.write(
      [
        "usage: make_fixtures.mjs [-h] --outdir OUTDIR [--only {tracked,watermark,all}]",
        "make_fixtures.mjs: error: the following arguments are required: --outdir",
        "",
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }
  const args = process.argv.slice(2);
  let outdir = null,
    only = "all";
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--outdir") outdir = args[++i];
    else if (args[i] === "--only") only = args[++i];
    else {
      console.error(`unknown argument: ${args[i]}`);
      process.exitCode = 2;
      return;
    }
  }
  if (!outdir || !["tracked", "watermark", "all"].includes(only)) {
    console.error("usage: make_fixtures.mjs --outdir DIR [--only tracked|watermark|all]");
    process.exitCode = 2;
    return;
  }
  await fs.mkdir(outdir, { recursive: true });
  if (only === "tracked" || only === "all") {
    const file = path.join(outdir, "tracked_changes_fixture.docx");
    await makeTracked(file);
    console.log(`[OK] wrote ${file}`);
  }
  if (only === "watermark" || only === "all") {
    const file = path.join(outdir, "watermark_fixture.docx");
    await makeWatermark(file);
    console.log(`[OK] wrote ${file}`);
  }
}
main().catch((error) => {
  console.error(`[ERROR] ${error.message}`);
  process.exitCode = 2;
});
