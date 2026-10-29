#!/usr/bin/env node
import fs from "node:fs/promises";
import JSZip from "jszip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const COMMENTS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments";
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
function wAttr(node, name) {
  return node?.getAttributeNS(W_NS, name) || node?.getAttribute(`w:${name}`) || "";
}
function create(doc, name) {
  return doc.createElementNS(W_NS, `w:${name}`);
}
function nowUtc() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
function paragraphText(p) {
  return descendants(p)
    .map((node) =>
      ["t", "delText"].includes(localName(node))
        ? node.textContent || ""
        : localName(node) === "tab"
          ? "\t"
          : ["br", "cr"].includes(localName(node))
            ? "\n"
            : "",
    )
    .join("");
}
function appendComment(root, id, text) {
  const comment = root.ownerDocument.createElementNS(W_NS, "w:comment");
  wAttr(comment, "id");
  comment.setAttributeNS(W_NS, "w:id", String(id));
  comment.setAttributeNS(W_NS, "w:date", nowUtc());
  const p = create(root.ownerDocument, "p");
  const r = create(root.ownerDocument, "r");
  const t = create(root.ownerDocument, "t");
  t.appendChild(root.ownerDocument.createTextNode(text));
  r.appendChild(t);
  p.appendChild(r);
  comment.appendChild(p);
  root.appendChild(comment);
}
async function main() {
  const invocationArgs = process.argv.slice(2);
  if (invocationArgs.includes("--help") || invocationArgs.includes("-h")) {
    process.stdout.write(
      [
        "usage: comments_add.mjs [-h] --out OUT [--add ADD] [--ignore_case]",
        "                       [--require_all]",
        "                       in_docx",
        "",
        "Add multiple Word comments by paragraph substring match",
        "",
        "positional arguments:",
        "  in_docx",
        "",
        "options:",
        "  -h, --help     show this help message and exit",
        "  --out OUT",
        "  --add ADD      Add a comment: contains=comment text (repeatable)",
        "  --ignore_case  Case-insensitive substring matching",
        "  --require_all  Fail if any --add pattern does not match a paragraph",
        "",
      ].join("\n"),
    );
    return;
  }
  if (invocationArgs.length === 0) {
    process.stderr.write(
      [
        "usage: comments_add.mjs [-h] --out OUT [--add ADD] [--ignore_case]",
        "                       [--require_all]",
        "                       in_docx",
        "comments_add.mjs: error: the following arguments are required: in_docx, --out",
        "",
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }
  const args = process.argv.slice(2);
  const input = args[0];
  let output = null,
    ignoreCase = false,
    requireAll = false;
  const adds = [];
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === "--out") output = args[++i];
    else if (args[i] === "--add") adds.push(args[++i]);
    else if (args[i] === "--ignore_case") ignoreCase = true;
    else if (args[i] === "--require_all") requireAll = true;
    else {
      console.error(`unknown argument: ${args[i]}`);
      process.exitCode = 2;
      return;
    }
  }
  if (!input || !output || !adds.length) {
    console.error(
      "usage: comments_add.mjs in.docx --out out.docx --add contains=comment [--add ...] [--ignore_case] [--require_all]",
    );
    process.exitCode = 2;
    return;
  }
  const pairs = adds.map((value) => {
    const i = value.indexOf("=");
    if (i < 0) throw new Error("--add must be formatted as contains=comment text");
    return [value.slice(0, i), value.slice(i + 1)];
  });
  const zip = await JSZip.loadAsync(await fs.readFile(input));
  const docEntry = zip.file("word/document.xml");
  if (!docEntry) throw new Error("word/document.xml is missing");
  const doc = parseXml(await docEntry.async("nodebuffer"));
  const commentsEntry = zip.file("word/comments.xml");
  const comments = commentsEntry
    ? parseXml(await commentsEntry.async("nodebuffer"))
    : parseXml(`<?xml version="1.0"?><w:comments xmlns:w="${W_NS}"/>`);
  const usedIds = descendants(comments.documentElement, "comment")
    .map((node) => Number(wAttr(node, "id")))
    .filter(Number.isInteger);
  let nextId = usedIds.length ? Math.max(...usedIds) + 1 : 0;
  const missing = [];
  let used = 0;
  for (const [contains, commentText] of pairs) {
    const needle = ignoreCase ? contains.toLowerCase() : contains;
    const paragraph = descendants(doc.documentElement, "p").find((p) => {
      const text = paragraphText(p);
      return (ignoreCase ? text.toLowerCase() : text).includes(needle);
    });
    if (!paragraph) {
      missing.push(contains);
      console.log(`[warn] no paragraph matched contains='${contains.replaceAll("'", "\\'")}'`);
      continue;
    }
    const id = nextId++;
    const start = create(doc, "commentRangeStart");
    start.setAttributeNS(W_NS, "w:id", String(id));
    paragraph.insertBefore(start, paragraph.firstChild);
    const end = create(doc, "commentRangeEnd");
    end.setAttributeNS(W_NS, "w:id", String(id));
    paragraph.appendChild(end);
    const referenceRun = create(doc, "r");
    const reference = create(doc, "commentReference");
    reference.setAttributeNS(W_NS, "w:id", String(id));
    referenceRun.appendChild(reference);
    paragraph.appendChild(referenceRun);
    appendComment(comments.documentElement, id, commentText);
    used += 1;
  }
  if (requireAll && missing.length) {
    console.error(
      `[comments_add] ${missing.length} patterns were not matched: ${JSON.stringify(missing)}`,
    );
    process.exitCode = 1;
    return;
  }
  const typesEntry = zip.file("[Content_Types].xml");
  if (!typesEntry) throw new Error("[Content_Types].xml is missing");
  const types = parseXml(await typesEntry.async("nodebuffer"));
  if (
    !descendants(types.documentElement, "Override").some(
      (node) => node.getAttribute("PartName") === "/word/comments.xml",
    )
  ) {
    const override = types.createElementNS(CT_NS, "Override");
    override.setAttribute("PartName", "/word/comments.xml");
    override.setAttribute(
      "ContentType",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml",
    );
    types.documentElement.appendChild(override);
  }
  const relsEntry = zip.file("word/_rels/document.xml.rels");
  if (!relsEntry) throw new Error("word/_rels/document.xml.rels is missing");
  const rels = parseXml(await relsEntry.async("nodebuffer"));
  const relNodes = descendants(rels.documentElement, "Relationship");
  if (
    !relNodes.some(
      (node) =>
        node.getAttribute("Type") === COMMENTS_REL &&
        node.getAttribute("Target") === "comments.xml",
    )
  ) {
    const ids = relNodes
      .map((node) => Number((node.getAttribute("Id") || "").replace(/^rId/, "")))
      .filter(Number.isInteger);
    const rel = rels.createElementNS(PKG_REL_NS, "Relationship");
    rel.setAttribute("Id", `rId${ids.length ? Math.max(...ids) + 1 : 1}`);
    rel.setAttribute("Type", COMMENTS_REL);
    rel.setAttribute("Target", "comments.xml");
    rels.documentElement.appendChild(rel);
  }
  const overrides = new Map([
    ["word/document.xml", xmlBytes(doc)],
    ["word/comments.xml", xmlBytes(comments)],
    ["[Content_Types].xml", xmlBytes(types)],
    ["word/_rels/document.xml.rels", xmlBytes(rels)],
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
    if (!zip.files[name]) out.file(name, data, { binary: true });
  await fs.writeFile(
    output,
    await out.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
  );
  console.log(
    `[OK] wrote ${output} (added_comments=${used}, unmatched_patterns=${missing.length})`,
  );
}
main().catch((error) => {
  console.error(`[ERROR] ${error.message}`);
  process.exitCode = 2;
});
