#!/usr/bin/env node
import fs from "node:fs/promises";
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
function runText(doc, text) {
  const run = create(doc, "r"),
    t = create(doc, "t");
  t.appendChild(doc.createTextNode(text));
  if (/^\s|\s$/.test(text)) t.setAttributeNS(XML_NS, "xml:space", "preserve");
  run.appendChild(t);
  return run;
}
function caption(doc, label, text, sequence) {
  const p = create(doc, "p"),
    props = create(doc, "pPr"),
    style = create(doc, "pStyle");
  setWAttr(style, "val", "Caption");
  props.appendChild(style);
  p.appendChild(props);
  p.appendChild(runText(doc, `${label} `));
  const begin = create(doc, "r"),
    beginChar = create(doc, "fldChar");
  setWAttr(beginChar, "fldCharType", "begin");
  begin.appendChild(beginChar);
  const instr = create(doc, "r"),
    instrText = create(doc, "instrText");
  instrText.setAttributeNS(XML_NS, "xml:space", "preserve");
  instrText.appendChild(doc.createTextNode(` SEQ ${sequence} \\* ARABIC `));
  instr.appendChild(instrText);
  const separate = create(doc, "r"),
    separateChar = create(doc, "fldChar");
  setWAttr(separateChar, "fldCharType", "separate");
  separate.appendChild(separateChar);
  const result = runText(doc, "0");
  const end = create(doc, "r"),
    endChar = create(doc, "fldChar");
  setWAttr(endChar, "fldCharType", "end");
  end.appendChild(endChar);
  p.appendChild(begin);
  p.appendChild(instr);
  p.appendChild(separate);
  p.appendChild(result);
  p.appendChild(end);
  if (text) p.appendChild(runText(doc, `: ${text}`));
  return p;
}
function nextElement(node) {
  for (let current = node?.nextSibling; current; current = current.nextSibling)
    if (current.nodeType === 1) return current;
  return null;
}
function hasFollowingCaption(node, label) {
  const next = nextElement(node);
  if (!next || localName(next) !== "p") return false;
  const props = direct(next, "pPr")[0],
    style = wAttr(direct(props, "pStyle")[0], "val");
  return (
    style === "Caption" &&
    descendants(next, "t")
      .map((item) => item.textContent || "")
      .join("")
      .trim()
      .startsWith(label)
  );
}
function bookmarkAroundNumber(p, name, id) {
  const runs = descendants(p, "r");
  let separate = false,
    target = null;
  for (const run of runs) {
    const field = direct(run, "fldChar")[0];
    if (field && wAttr(field, "fldCharType") === "separate") {
      separate = true;
      continue;
    }
    if (separate && direct(run, "t")[0]) {
      target = run;
      break;
    }
  }
  if (!target) return;
  const start = create(p.ownerDocument, "bookmarkStart");
  setWAttr(start, "id", id);
  setWAttr(start, "name", name);
  const end = create(p.ownerDocument, "bookmarkEnd");
  setWAttr(end, "id", id);
  const parent = target.parentNode;
  parent.insertBefore(start, target);
  parent.insertBefore(end, target.nextSibling);
}
function bookmarks(root) {
  const stack = [],
    result = {};
  for (const node of descendants(root)) {
    if (localName(node) === "bookmarkStart")
      stack.push({ id: wAttr(node, "id"), name: wAttr(node, "name"), text: "" });
    else if (localName(node) === "bookmarkEnd") {
      const index = [...stack].reverse().findIndex((item) => item.id === wAttr(node, "id"));
      if (index >= 0) {
        const actual = stack.length - 1 - index,
          item = stack.splice(actual, 1)[0];
        if (item.name) result[item.name] = item.text;
      }
    } else if (localName(node) === "t")
      for (const item of stack) item.text += node.textContent || "";
  }
  return result;
}
function materialize(root) {
  let total = 0;
  const seq = {},
    bms = bookmarks(root);
  for (const p of descendants(root, "p")) {
    let active = false,
      separated = false,
      instr = "",
      result = [];
    for (const run of descendants(p, "r")) {
      const fld = direct(run, "fldChar")[0],
        kind = wAttr(fld, "fldCharType");
      if (kind === "begin") {
        active = true;
        separated = false;
        instr = "";
        result = [];
        continue;
      }
      if (active && kind === "separate") {
        separated = true;
        continue;
      }
      if (active && kind === "end") {
        const normalized = instr.replace(/\s+/g, " ").trim();
        const seqMatch = /\bSEQ\s+([A-Za-z0-9_]+)/i.exec(normalized),
          refMatch = /\bREF\s+([A-Za-z0-9_:.\-]+)/i.exec(normalized);
        let value = null;
        if (seqMatch) {
          seq[seqMatch[1]] = (seq[seqMatch[1]] || 0) + 1;
          value = String(seq[seqMatch[1]]);
        } else if (refMatch && Object.prototype.hasOwnProperty.call(bms, refMatch[1]))
          value = bms[refMatch[1]];
        if (value != null && result.length) {
          result[0].textContent = value;
          for (const extra of result.slice(1)) extra.textContent = "";
          total += 1;
        }
        active = false;
        separated = false;
        instr = "";
        result = [];
        continue;
      }
      if (!active) continue;
      if (!separated) for (const node of direct(run, "instrText")) instr += node.textContent || "";
      else result.push(...descendants(run, "t"));
    }
  }
  return total;
}
async function main() {
  const invocationArgs = process.argv.slice(2);
  if (invocationArgs.includes("--help") || invocationArgs.includes("-h")) {
    process.stdout.write(
      [
        "usage: captions_and_crossrefs.mjs [-h] [--tables] [--figures]",
        "                                 [--caption_text CAPTION_TEXT] [--bookmarks]",
        "                                 [--materialize]",
        "                                 input_docx output_docx",
        "",
        "Insert simple captions (Figure/Table) and optional cross-references. This is a",
        "pragmatic OOXML-level helper for: - Adding Figure/Table captions using SEQ",
        "fields - (Optional) adding bookmarks around the caption number for later REF",
        "fields - (Optional) materializing SEQ/REF fields so headless renders show",
        "correct numbers It targets common automation needs, not the full Word caption",
        "feature set.",
        "",
        "positional arguments:",
        "  input_docx",
        "  output_docx",
        "",
        "options:",
        "  -h, --help            show this help message and exit",
        "  --tables              Add table captions.",
        "  --figures             Add figure captions.",
        "  --caption_text CAPTION_TEXT",
        "                        Text appended after the caption number, e.g. 'Results",
        "                        by category'.",
        "  --bookmarks           Add bookmarks around caption numbers (tbl1, tbl2,",
        "                        fig1...).",
        "  --materialize         Materialize SEQ/REF fields so headless renders show",
        "                        correct numbers.",
        "",
      ].join("\n"),
    );
    return;
  }
  if (invocationArgs.length === 0) {
    process.stderr.write(
      [
        "usage: captions_and_crossrefs.mjs [-h] [--tables] [--figures]",
        "                                 [--caption_text CAPTION_TEXT] [--bookmarks]",
        "                                 [--materialize]",
        "                                 input_docx output_docx",
        "captions_and_crossrefs.mjs: error: the following arguments are required: input_docx, output_docx",
        "",
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }
  const args = process.argv.slice(2);
  const input = args[0],
    output = args[1];
  let tables = false,
    figures = false,
    text = "",
    bookmarksEnabled = false,
    materializeEnabled = false;
  for (let i = 2; i < args.length; i += 1) {
    if (args[i] === "--tables") tables = true;
    else if (args[i] === "--figures") figures = true;
    else if (args[i] === "--caption_text") text = args[++i];
    else if (args[i] === "--bookmarks") bookmarksEnabled = true;
    else if (args[i] === "--materialize") materializeEnabled = true;
    else {
      console.error(`unknown argument: ${args[i]}`);
      process.exitCode = 2;
      return;
    }
  }
  if (!input || !output || (!tables && !figures)) {
    console.error(
      "usage: captions_and_crossrefs.mjs input.docx output.docx --tables|--figures [--caption_text TEXT] [--bookmarks] [--materialize]",
    );
    process.exitCode = 2;
    return;
  }
  const zip = await JSZip.loadAsync(await fs.readFile(input));
  const out = new JSZip();
  for (const [name, entry] of Object.entries(zip.files)) {
    if (!/^word\/(?:document|header\d+|footer\d+)\.xml$/.test(name)) {
      out.file(name, await entry.async("nodebuffer"), {
        binary: true,
        createFolders: false,
        date: entry.date,
        unixPermissions: entry.unixPermissions,
      });
      continue;
    }
    const doc = parseXml(await entry.async("nodebuffer"));
    const root = doc.documentElement;
    let bookmarkId =
      Math.max(
        0,
        ...descendants(root, "bookmarkStart")
          .concat(descendants(root, "bookmarkEnd"))
          .map((node) => Number(wAttr(node, "id")))
          .filter(Number.isInteger),
      ) + 1;
    let tableNumber = 0,
      figureNumber = 0;
    if (tables)
      for (const table of descendants(root, "tbl"))
        if (!hasFollowingCaption(table, "Table")) {
          tableNumber += 1;
          const item = caption(doc, "Table", text, "Table");
          table.parentNode.insertBefore(item, table.nextSibling);
          if (bookmarksEnabled) {
            bookmarkAroundNumber(item, `tbl${tableNumber}`, bookmarkId);
            bookmarkId += 1;
          }
        }
    if (figures)
      for (const paragraph of descendants(root, "p"))
        if (
          (descendants(paragraph, "drawing").length || descendants(paragraph, "pict").length) &&
          !hasFollowingCaption(paragraph, "Figure")
        ) {
          figureNumber += 1;
          const item = caption(doc, "Figure", text, "Figure");
          paragraph.parentNode.insertBefore(item, paragraph.nextSibling);
          if (bookmarksEnabled) {
            bookmarkAroundNumber(item, `fig${figureNumber}`, bookmarkId);
            bookmarkId += 1;
          }
        }
    if (materializeEnabled) materialize(root);
    out.file(name, xmlBytes(doc), {
      binary: true,
      createFolders: false,
      date: entry.date,
      unixPermissions: entry.unixPermissions,
    });
  }
  await fs.writeFile(
    output,
    await out.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
  );
  console.log(`[OK] wrote ${output}`);
}
main().catch((error) => {
  console.error(`[ERROR] ${error.message}`);
  process.exitCode = 2;
});
