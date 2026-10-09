#!/usr/bin/env node
import fs from "node:fs/promises";
import JSZip from "jszip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const REL_TYPES = {
  footnote: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes",
  endnote: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes",
};
const CONTENT_TYPES = {
  footnote: "application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml",
  endnote: "application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml",
};
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
  if (value.startsWith("<?xml"))
    value = value.replace(
      /^<\?xml[^?]*\?>/,
      "<?xml version='1.0' encoding='UTF-8' standalone='yes'?>",
    );
  else value = "<?xml version='1.0' encoding='UTF-8' standalone='yes'?>" + value;
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
function nextRid(root) {
  const ids = descendants(root, "Relationship")
    .map((node) => Number((node.getAttribute("Id") || "").replace(/^rId/, "")))
    .filter(Number.isInteger);
  return `rId${ids.length ? Math.max(...ids) + 1 : 1}`;
}
function emptyNotes(kind) {
  const doc = parseXml(`<?xml version="1.0"?><w:${kind}s xmlns:w="${W_NS}" xmlns:r="${R_NS}"/>`);
  const root = doc.documentElement;
  for (const [id, tag] of [
    ["-1", "separator"],
    ["0", "continuationSeparator"],
  ]) {
    const note = create(doc, kind);
    setWAttr(note, "id", id);
    const p = create(doc, "p"),
      r = create(doc, "r"),
      separator = create(doc, tag);
    r.appendChild(separator);
    p.appendChild(r);
    note.appendChild(p);
    root.appendChild(note);
  }
  return doc;
}
function nextNoteId(root, kind) {
  const ids = descendants(root, kind)
    .map((node) => Number(wAttr(node, "id")))
    .filter((id) => Number.isInteger(id) && id >= 1);
  return ids.length ? Math.max(...ids) + 1 : 1;
}
function appendNote(root, kind, id, text) {
  const doc = root.ownerDocument;
  const note = create(doc, kind);
  setWAttr(note, "id", id);
  const p = create(doc, "p");
  const refRun = create(doc, "r");
  refRun.appendChild(create(doc, kind === "endnote" ? "endnoteRef" : "footnoteRef"));
  const textRun = create(doc, "r");
  const t = create(doc, "t");
  t.appendChild(doc.createTextNode(` ${text}`));
  textRun.appendChild(t);
  p.appendChild(refRun);
  p.appendChild(textRun);
  note.appendChild(p);
  root.appendChild(note);
}
async function main() {
  const invocationArgs = process.argv.slice(2);
  if (invocationArgs.includes("--help") || invocationArgs.includes("-h")) {
    process.stdout.write(
      [
        "usage: insert_note.mjs [-h] --kind {footnote,endnote} --text TEXT",
        "                      [--marker MARKER] --out OUT",
        "                      in_docx",
        "",
        "positional arguments:",
        "  in_docx",
        "",
        "options:",
        "  -h, --help            show this help message and exit",
        "  --kind {footnote,endnote}",
        "  --text TEXT",
        "  --marker MARKER",
        "  --out OUT",
        "",
      ].join("\n"),
    );
    return;
  }
  if (invocationArgs.length === 0) {
    process.stderr.write(
      [
        "usage: insert_note.mjs [-h] --kind {footnote,endnote} --text TEXT",
        "                      [--marker MARKER] --out OUT",
        "                      in_docx",
        "insert_note.mjs: error: the following arguments are required: in_docx, --kind, --text, --out",
        "",
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }
  const args = process.argv.slice(2);
  const input = args[0];
  let kind = null,
    text = null,
    marker = "[[NOTE]]",
    output = null;
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === "--kind") kind = args[++i];
    else if (args[i] === "--text") text = args[++i];
    else if (args[i] === "--marker") marker = args[++i];
    else if (args[i] === "--out") output = args[++i];
    else {
      console.error(`unknown argument: ${args[i]}`);
      process.exitCode = 2;
      return;
    }
  }
  if (!input || !["footnote", "endnote"].includes(kind) || text == null || !output) {
    console.error(
      "usage: insert_note.mjs in.docx --kind footnote|endnote --text TEXT --marker [[NOTE]] --out out.docx",
    );
    process.exitCode = 2;
    return;
  }
  const partName = `word/${kind}s.xml`;
  const zip = await JSZip.loadAsync(await fs.readFile(input));
  const documentEntry = zip.file("word/document.xml");
  if (!documentEntry) throw new Error("word/document.xml is missing");
  const document = parseXml(await documentEntry.async("nodebuffer"));
  const notesEntry = zip.file(partName);
  const notes = notesEntry ? parseXml(await notesEntry.async("nodebuffer")) : emptyNotes(kind);
  const id = nextNoteId(notes.documentElement, kind);
  appendNote(notes.documentElement, kind, id, text);
  let inserted = false;
  for (const node of descendants(document.documentElement, "t")) {
    const value = node.textContent || "";
    if (!value.includes(marker)) continue;
    node.textContent = value.replace(marker, "");
    const run = node.parentNode;
    const parent = run?.parentNode;
    if (!run || localName(run) !== "r" || !parent) continue;
    const referenceRun = create(document, "r");
    const reference = create(
      document,
      kind === "footnote" ? "footnoteReference" : "endnoteReference",
    );
    setWAttr(reference, "id", id);
    referenceRun.appendChild(reference);
    parent.insertBefore(referenceRun, run.nextSibling);
    inserted = true;
    break;
  }
  if (!inserted) {
    const body = direct(document.documentElement, "body")[0];
    if (!body) throw new Error("No w:body in document.xml");
    const p = create(document, "p"),
      run = create(document, "r"),
      ref = create(document, kind === "footnote" ? "footnoteReference" : "endnoteReference");
    setWAttr(ref, "id", id);
    run.appendChild(ref);
    p.appendChild(run);
    const sectPr = direct(body, "sectPr")[0];
    if (sectPr) body.insertBefore(p, sectPr);
    else body.appendChild(p);
  }
  const relsEntry = zip.file("word/_rels/document.xml.rels");
  if (!relsEntry) throw new Error("word/_rels/document.xml.rels is missing");
  const rels = parseXml(await relsEntry.async("nodebuffer"));
  if (
    !descendants(rels.documentElement, "Relationship").some(
      (node) => node.getAttribute("Type") === REL_TYPES[kind],
    )
  ) {
    const rel = rels.createElementNS(REL_NS, "Relationship");
    rel.setAttribute("Id", nextRid(rels.documentElement));
    rel.setAttribute("Type", REL_TYPES[kind]);
    rel.setAttribute("Target", `${kind}s.xml`);
    rels.documentElement.appendChild(rel);
  }
  const typesEntry = zip.file("[Content_Types].xml");
  if (!typesEntry) throw new Error("[Content_Types].xml is missing");
  const types = parseXml(await typesEntry.async("nodebuffer"));
  if (
    !descendants(types.documentElement, "Override").some(
      (node) => node.getAttribute("PartName") === `/${partName}`,
    )
  ) {
    const override = types.createElementNS(CT_NS, "Override");
    override.setAttribute("PartName", `/${partName}`);
    override.setAttribute("ContentType", CONTENT_TYPES[kind]);
    types.documentElement.appendChild(override);
  }
  const overrides = new Map([
    ["word/document.xml", xmlBytes(document)],
    [partName, xmlBytes(notes)],
    ["word/_rels/document.xml.rels", xmlBytes(rels)],
    ["[Content_Types].xml", xmlBytes(types)],
  ]);
  const out = new JSZip();
  for (const [name, entry] of Object.entries(zip.files))
    out.file(name, overrides.has(name) ? overrides.get(name) : await entry.async("nodebuffer"), {
      binary: true,
      createFolders: false,
      date: entry.date,
      unixPermissions: entry.unixPermissions,
    });
  for (const [name, data] of overrides)
    if (!zip.files[name]) out.file(name, data, { binary: true, createFolders: false });
  await fs.writeFile(
    output,
    await out.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
  );
  console.log(`[OK] inserted ${kind} and wrote ${output}`);
}
main().catch((error) => {
  console.error(`[ERROR] ${error.message}`);
  process.exitCode = 2;
});
