#!/usr/bin/env node
import fs from "node:fs/promises";
import JSZip from "jszip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const RT = {
  comments: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments",
  hyperlink: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
  header: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/header",
  footer: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer",
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
function nowUtc() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
function repr(value) {
  return `'${String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
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
function nextRid(root) {
  const ids = descendants(root, "Relationship")
    .map((node) => Number((node.getAttribute("Id") || "").replace(/^rId/, "")))
    .filter(Number.isInteger);
  return `rId${ids.length ? Math.max(...ids) + 1 : 1}`;
}
function ensureTrack(settings) {
  if (descendants(settings.documentElement, "trackRevisions").length) return false;
  settings.documentElement.insertBefore(
    create(settings, "trackRevisions"),
    settings.documentElement.firstChild,
  );
  return true;
}
function nextId(root) {
  const ids = descendants(root)
    .map((node) => Number(wAttr(node, "id")))
    .filter(Number.isInteger);
  return ids.length ? Math.max(...ids) + 1 : 1;
}
function trackedReplace(root, targetId, newText, delId, insId, date) {
  let target = descendants(root, "ins").find((node) => wAttr(node, "id") === String(targetId));
  if (!target) throw new Error(`Could not find <w:ins w:id='${targetId}'> in document.xml`);
  const existing = descendants(root)
    .map((node) => Number(wAttr(node, "id")))
    .filter(Number.isInteger);
  const maximum = existing.length ? Math.max(...existing) : 0;
  const deletionId = delId === "auto" ? String(maximum + 1) : String(delId);
  const insertionId =
    insId === "auto" ? String(Math.max(maximum, Number(deletionId) || maximum) + 1) : String(insId);
  const deletion = create(root.ownerDocument, "del");
  for (const attribute of Array.from(target.attributes || []))
    deletion.setAttributeNS(attribute.namespaceURI || null, attribute.name, attribute.value);
  for (const child of Array.from(target.childNodes || [])) deletion.appendChild(child);
  target.parentNode.replaceChild(deletion, target);
  target = deletion;
  setWAttr(target, "id", deletionId);
  target.removeAttributeNS(W_NS, "author");
  target.removeAttribute("w:author");
  setWAttr(target, "date", date);
  for (const textNode of descendants(target, "t")) {
    const replacement = create(root.ownerDocument, "delText");
    for (const attribute of Array.from(textNode.attributes || []))
      replacement.setAttributeNS(attribute.namespaceURI || null, attribute.name, attribute.value);
    while (textNode.firstChild) replacement.appendChild(textNode.firstChild);
    textNode.parentNode.replaceChild(replacement, textNode);
  }
  const insertion = create(root.ownerDocument, "ins");
  setWAttr(insertion, "id", insertionId);
  setWAttr(insertion, "date", date);
  const run = create(root.ownerDocument, "r"),
    text = create(root.ownerDocument, "t");
  text.appendChild(root.ownerDocument.createTextNode(newText));
  run.appendChild(text);
  insertion.appendChild(run);
  target.parentNode.insertBefore(insertion, target.nextSibling);
}
function makeComment(root, id, text, date) {
  const doc = root.ownerDocument,
    comment = create(doc, "comment");
  setWAttr(comment, "id", id);
  setWAttr(comment, "date", date);
  const p = create(doc, "p"),
    r = create(doc, "r"),
    t = create(doc, "t");
  t.appendChild(doc.createTextNode(text));
  r.appendChild(t);
  p.appendChild(r);
  comment.appendChild(p);
  root.appendChild(comment);
}
function ensureHyperlinkRelation(rels, url) {
  const existing = descendants(rels.documentElement, "Relationship").find(
    (node) => node.getAttribute("Type") === RT.hyperlink && node.getAttribute("Target") === url,
  );
  if (existing) return existing.getAttribute("Id");
  const id = nextRid(rels.documentElement);
  const rel = rels.createElementNS(PKG_REL_NS, "Relationship");
  rel.setAttribute("Id", id);
  rel.setAttribute("Type", RT.hyperlink);
  rel.setAttribute("Target", url);
  rel.setAttribute("TargetMode", "External");
  rels.documentElement.appendChild(rel);
  return id;
}
function setParagraphText(doc, p, text, alignment = null) {
  for (const child of Array.from(p.childNodes))
    if (!(child.nodeType === 1 && localName(child) === "pPr")) p.removeChild(child);
  let props = direct(p, "pPr")[0];
  if (alignment) {
    if (!props) {
      props = create(doc, "pPr");
      p.insertBefore(props, p.firstChild);
    }
    let jc = direct(props, "jc")[0];
    if (!jc) {
      jc = create(doc, "jc");
      props.appendChild(jc);
    }
    setWAttr(jc, "val", alignment);
  }
  const run = create(doc, "r"),
    t = create(doc, "t");
  t.appendChild(doc.createTextNode(text));
  run.appendChild(t);
  p.appendChild(run);
}
function fieldParagraph(doc, alignment = "center") {
  const p = create(doc, "p"),
    props = create(doc, "pPr"),
    jc = create(doc, "jc");
  setWAttr(jc, "val", alignment);
  props.appendChild(jc);
  p.appendChild(props);
  const run = create(doc, "r");
  for (const [name, value] of [
    ["fldChar", "begin"],
    ["instrText", " PAGE \\* MERGEFORMAT "],
    ["fldChar", "separate"],
    ["t", "1"],
    ["fldChar", "end"],
  ]) {
    const node = create(doc, name);
    if (name === "fldChar") setWAttr(node, "fldCharType", value);
    else {
      if (name === "instrText")
        node.setAttributeNS("http://www.w3.org/XML/1998/namespace", "xml:space", "preserve");
      node.appendChild(doc.createTextNode(value));
    }
    run.appendChild(node);
  }
  p.appendChild(run);
  return p;
}
function partTarget(relsRoot, type) {
  const rel = descendants(relsRoot, "Relationship").find(
    (node) => node.getAttribute("Type") === type,
  );
  return rel ? { id: rel.getAttribute("Id"), target: rel.getAttribute("Target") } : null;
}
async function main() {
  const invocationArgs = process.argv.slice(2);
  if (invocationArgs.includes("--help") || invocationArgs.includes("-h")) {
    process.stdout.write(
      [
        "usage: docx_ooxml_patch.mjs [-h] [--out OUT] [--enable-track] [--date DATE]",
        "                           [--tracked-replace-ins-id TRACKED_REPLACE_INS_ID]",
        "                           [--new-text NEW_TEXT] [--del-id DEL_ID]",
        "                           [--ins-id INS_ID] [--add-comment]",
        "                           [--comment-text COMMENT_TEXT]",
        "                           [--indent-left-twips INDENT_LEFT_TWIPS]",
        "                           [--contains CONTAINS] [--comment-id COMMENT_ID]",
        "                           [--header-date HEADER_DATE] [--add-page-numbers]",
        "                           [--hyperlink-first HYPERLINK_FIRST]",
        "                           docx",
        "",
        "DOCX patch helper (OOXML + OOXML utilities)",
        "",
        "positional arguments:",
        "  docx                  Input DOCX",
        "",
        "options:",
        "  -h, --help            show this help message and exit",
        "  --out OUT             Output DOCX (default: overwrite input)",
        "  --enable-track        Enable <w:trackRevisions/> in settings.xml",
        "  --date DATE           ISO date for metadata (default: now)",
        "  --tracked-replace-ins-id TRACKED_REPLACE_INS_ID",
        "                        Convert <w:ins w:id=...> into delete+insert",
        "  --new-text NEW_TEXT   New text for tracked insertion",
        "  --del-id DEL_ID       w:id for the deletion (default: auto-pick a non-",
        "                        colliding id)",
        "  --ins-id INS_ID       w:id for the new insertion (default: auto-pick a non-",
        "                        colliding id)",
        "  --add-comment         Add a Word comment via comments.xml",
        "  --comment-text COMMENT_TEXT",
        "                        Comment body",
        "  --indent-left-twips INDENT_LEFT_TWIPS",
        "                        Match paragraphs by indentation left (twips)",
        "  --contains CONTAINS   Require substring in paragraph text",
        "  --comment-id COMMENT_ID",
        "                        Comment id (default: auto-pick a non-colliding id)",
        "  --header-date HEADER_DATE",
        "                        Set first section header to this text (right aligned)",
        "  --add-page-numbers    Add a centered page number field to footer",
        "  --hyperlink-first HYPERLINK_FIRST",
        "                        Add hyperlink to first paragraph text to this URL",
        "",
      ].join("\n"),
    );
    return;
  }
  if (invocationArgs.length === 0) {
    process.stderr.write(
      [
        "usage: docx_ooxml_patch.mjs [-h] [--out OUT] [--enable-track] [--date DATE]",
        "                           [--tracked-replace-ins-id TRACKED_REPLACE_INS_ID]",
        "                           [--new-text NEW_TEXT] [--del-id DEL_ID]",
        "                           [--ins-id INS_ID] [--add-comment]",
        "                           [--comment-text COMMENT_TEXT]",
        "                           [--indent-left-twips INDENT_LEFT_TWIPS]",
        "                           [--contains CONTAINS] [--comment-id COMMENT_ID]",
        "                           [--header-date HEADER_DATE] [--add-page-numbers]",
        "                           [--hyperlink-first HYPERLINK_FIRST]",
        "                           docx",
        "docx_ooxml_patch.mjs: error: the following arguments are required: docx",
        "",
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }
  const args = process.argv.slice(2);
  const input = args[0];
  let output = null,
    date = null,
    newText = "",
    delId = "auto",
    insId = "auto",
    commentTextValue = "",
    indent = null,
    contains = null,
    commentId = "auto",
    headerDate = null,
    hyperlinkUrl = null,
    enableTrack = false,
    trackedId = null,
    addComment = false,
    pageNumbers = false;
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--out") output = args[++i];
    else if (arg === "--enable-track") enableTrack = true;
    else if (arg === "--date") date = args[++i];
    else if (arg === "--tracked-replace-ins-id") trackedId = args[++i];
    else if (arg === "--new-text") newText = args[++i];
    else if (arg === "--del-id") delId = args[++i];
    else if (arg === "--ins-id") insId = args[++i];
    else if (arg === "--add-comment") addComment = true;
    else if (arg === "--comment-text") commentTextValue = args[++i];
    else if (arg === "--indent-left-twips") indent = Number(args[++i]);
    else if (arg === "--contains") contains = args[++i];
    else if (arg === "--comment-id") commentId = args[++i];
    else if (arg === "--header-date") headerDate = args[++i];
    else if (arg === "--add-page-numbers") pageNumbers = true;
    else if (arg === "--hyperlink-first") hyperlinkUrl = args[++i];
    else {
      console.error(`unknown argument: ${arg}`);
      process.exitCode = 2;
      return;
    }
  }
  if (!input) {
    console.error("usage: docx_ooxml_patch.mjs input.docx [--out out.docx] [operations]");
    process.exitCode = 2;
    return;
  }
  output ||= input;
  const zip = await JSZip.loadAsync(await fs.readFile(input));
  const documentEntry = zip.file("word/document.xml");
  if (!documentEntry) throw new Error("word/document.xml is missing");
  const document = parseXml(await documentEntry.async("nodebuffer"));
  const operations = [];
  const effectiveDate = date || nowUtc();
  if (headerDate != null || pageNumbers || hyperlinkUrl != null) {
    const relsEntry = zip.file("word/_rels/document.xml.rels");
    if (!relsEntry) throw new Error("word/_rels/document.xml.rels is missing");
    const rels = parseXml(await relsEntry.async("nodebuffer"));
    const replacements = new Map();
    if (headerDate != null) {
      const target = partTarget(rels.documentElement, RT.header);
      if (!target) throw new Error("Could not locate a header part");
      const name = `word/${target.target.replace(/^\.?\//, "")}`;
      const entry = zip.file(name);
      if (!entry) throw new Error(`Missing header part ${name}`);
      const header = parseXml(await entry.async("nodebuffer"));
      const p =
        descendants(header.documentElement, "p")[0] ||
        header.documentElement.appendChild(create(header, "p"));
      setParagraphText(header, p, headerDate, "right");
      replacements.set(name, xmlBytes(header));
      operations.push(`header-date=${repr(headerDate)}`);
    }
    if (pageNumbers) {
      const target = partTarget(rels.documentElement, RT.footer);
      if (!target) throw new Error("Could not locate a footer part");
      const name = `word/${target.target.replace(/^\.?\//, "")}`;
      const entry = zip.file(name);
      if (!entry) throw new Error(`Missing footer part ${name}`);
      const footer = parseXml(await entry.async("nodebuffer"));
      footer.documentElement.appendChild(fieldParagraph(footer));
      replacements.set(name, xmlBytes(footer));
      operations.push("add-page-numbers");
    }
    if (hyperlinkUrl != null) {
      const p = descendants(document.documentElement, "p")[0];
      if (!p) throw new Error("Document has no paragraphs");
      const visible = paragraphText(p);
      for (const child of Array.from(p.childNodes))
        if (!(child.nodeType === 1 && localName(child) === "pPr")) p.removeChild(child);
      const id = ensureHyperlinkRelation(rels, hyperlinkUrl);
      const link = create(document, "hyperlink");
      link.setAttributeNS(R_NS, "r:id", id);
      const run = create(document, "r"),
        props = create(document, "rPr"),
        color = create(document, "color"),
        underline = create(document, "u");
      setWAttr(color, "val", "0000FF");
      setWAttr(underline, "val", "single");
      props.appendChild(color);
      props.appendChild(underline);
      const t = create(document, "t");
      t.appendChild(document.createTextNode(visible));
      run.appendChild(props);
      run.appendChild(t);
      link.appendChild(run);
      p.appendChild(link);
      operations.push(`hyperlink-first=${repr(hyperlinkUrl)}`);
      replacements.set("word/_rels/document.xml.rels", xmlBytes(rels));
    }
    for (const [name, data] of replacements)
      zip.file(name, data, { binary: true, createFolders: false });
  }
  if (enableTrack || trackedId != null || addComment) {
    const settingsEntry = zip.file("word/settings.xml");
    const settings = settingsEntry
      ? parseXml(await settingsEntry.async("nodebuffer"))
      : parseXml(`<?xml version="1.0"?><w:settings xmlns:w="${W_NS}"/>`);
    if (enableTrack) {
      ensureTrack(settings);
      operations.push("enable-track");
    }
    if (settingsEntry || enableTrack)
      zip.file("word/settings.xml", xmlBytes(settings), { binary: true, createFolders: false });
    if (trackedId != null) {
      trackedReplace(document.documentElement, trackedId, newText, delId, insId, effectiveDate);
      operations.push(`tracked-replace-ins-id=${repr(trackedId)}`);
    }
    if (addComment) {
      const commentsEntry = zip.file("word/comments.xml");
      const comments = commentsEntry
        ? parseXml(await commentsEntry.async("nodebuffer"))
        : parseXml(`<?xml version="1.0"?><w:comments xmlns:w="${W_NS}"/>`);
      const used = descendants(comments.documentElement, "comment")
        .map((node) => Number(wAttr(node, "id")))
        .filter(Number.isInteger);
      const id =
        commentId === "auto" ? String(used.length ? Math.max(...used) + 1 : 0) : String(commentId);
      const paragraphs = descendants(document.documentElement, "p");
      const target = paragraphs.find(
        (p) =>
          (indent == null ||
            wAttr(direct(direct(p, "pPr")[0], "ind")[0], "left") === String(indent)) &&
          (contains == null || paragraphText(p).includes(contains)),
      );
      if (!target) throw new Error("Could not find paragraph matching predicate");
      const start = create(document, "commentRangeStart"),
        end = create(document, "commentRangeEnd"),
        refRun = create(document, "r"),
        ref = create(document, "commentReference");
      setWAttr(start, "id", id);
      setWAttr(end, "id", id);
      setWAttr(ref, "id", id);
      target.insertBefore(start, target.firstChild);
      target.appendChild(end);
      refRun.appendChild(ref);
      target.appendChild(refRun);
      makeComment(comments.documentElement, id, commentTextValue, effectiveDate);
      zip.file("word/comments.xml", xmlBytes(comments), { binary: true, createFolders: false });
      operations.push("add-comment");
      const relsEntry = zip.file("word/_rels/document.xml.rels");
      if (!relsEntry) throw new Error("word/_rels/document.xml.rels is missing");
      const rels = parseXml(await relsEntry.async("nodebuffer"));
      if (
        !descendants(rels.documentElement, "Relationship").some(
          (node) => node.getAttribute("Type") === RT.comments,
        )
      ) {
        const rel = rels.createElementNS(PKG_REL_NS, "Relationship");
        rel.setAttribute("Id", nextRid(rels.documentElement));
        rel.setAttribute("Type", RT.comments);
        rel.setAttribute("Target", "comments.xml");
        rels.documentElement.appendChild(rel);
        zip.file("word/_rels/document.xml.rels", xmlBytes(rels), {
          binary: true,
          createFolders: false,
        });
      }
      const typesEntry = zip.file("[Content_Types].xml");
      if (!typesEntry) throw new Error("[Content_Types].xml is missing");
      const types = parseXml(await typesEntry.async("nodebuffer"));
      if (
        !descendants(types.documentElement, "Override").some(
          (node) => node.getAttribute("PartName") === "/word/comments.xml",
        )
      ) {
        const ov = types.createElementNS(CT_NS, "Override");
        ov.setAttribute("PartName", "/word/comments.xml");
        ov.setAttribute(
          "ContentType",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml",
        );
        types.documentElement.appendChild(ov);
        zip.file("[Content_Types].xml", xmlBytes(types), { binary: true, createFolders: false });
      }
    }
    zip.file("word/document.xml", xmlBytes(document), { binary: true, createFolders: false });
  } else if (headerDate == null && !pageNumbers && hyperlinkUrl == null)
    zip.file("word/document.xml", xmlBytes(document), { binary: true, createFolders: false });
  if (!operations.length) console.log("[OK] No changes requested (nothing to do)");
  else {
    console.log(`[OK] Patched -> ${output}`);
    for (const operation of operations) console.log(`  - ${operation}`);
  }
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) delete zip.files[name];
  }
  await fs.writeFile(
    output,
    await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
  );
}
main().catch((error) => {
  console.error(`[ERROR] ${error.message}`);
  process.exitCode = 2;
});
