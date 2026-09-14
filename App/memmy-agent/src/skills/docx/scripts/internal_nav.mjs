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
function textOf(p) {
  return descendants(p, "t")
    .map((node) => node.textContent || "")
    .join("")
    .trim();
}
function styleOf(p) {
  const props = direct(p, "pPr")[0];
  return wAttr(direct(props, "pStyle")[0], "val");
}
function paragraph(doc, text, style = null) {
  const p = create(doc, "p");
  if (style) {
    const props = create(doc, "pPr"),
      pStyle = create(doc, "pStyle");
    setWAttr(pStyle, "val", style);
    props.appendChild(pStyle);
    p.appendChild(props);
  }
  const run = create(doc, "r"),
    t = create(doc, "t");
  t.appendChild(doc.createTextNode(text));
  if (/^\s|\s$/.test(text)) t.setAttributeNS(XML_NS, "xml:space", "preserve");
  run.appendChild(t);
  p.appendChild(run);
  return p;
}
function hyperlink(doc, anchor, text) {
  const link = create(doc, "hyperlink");
  setWAttr(link, "anchor", anchor);
  const run = create(doc, "r"),
    props = create(doc, "rPr"),
    style = create(doc, "rStyle");
  setWAttr(style, "val", "Hyperlink");
  props.appendChild(style);
  const t = create(doc, "t");
  t.appendChild(doc.createTextNode(text));
  if (/^\s|\s$/.test(text)) t.setAttributeNS(XML_NS, "xml:space", "preserve");
  run.appendChild(props);
  run.appendChild(t);
  link.appendChild(run);
  return link;
}
function bookmark(p, name, id) {
  if (descendants(p, "bookmarkStart").some((node) => wAttr(node, "name") === name)) return;
  const start = create(p.ownerDocument, "bookmarkStart"),
    end = create(p.ownerDocument, "bookmarkEnd");
  setWAttr(start, "id", id);
  setWAttr(start, "name", name);
  setWAttr(end, "id", id);
  p.insertBefore(start, p.firstChild);
  p.appendChild(end);
}
function existingNames(root) {
  return new Set(
    descendants(root, "bookmarkStart")
      .map((node) => wAttr(node, "name"))
      .filter(Boolean),
  );
}
function figureTableNames(root) {
  const names = [...existingNames(root)].sort();
  return {
    figures: names.filter((name) => /^fig\d+$/.test(name)),
    tables: names.filter((name) => /^tbl\d+$/.test(name)),
  };
}
async function main() {
  const invocationArgs = process.argv.slice(2);
  if (invocationArgs.includes("--help") || invocationArgs.includes("-h")) {
    process.stdout.write(
      [
        "usage: internal_nav.mjs [-h] --out OUT [--toc_title TOC_TITLE]",
        "                       [--levels LEVELS [LEVELS ...]] [--no_quicklinks]",
        "                       [--no_back_to_toc] [--no_top_bottom]",
        "                       input_docx",
        "",
        "Add internal navigation links/bookmarks and a static TOC",
        "",
        "positional arguments:",
        "  input_docx",
        "",
        "options:",
        "  -h, --help            show this help message and exit",
        "  --out OUT",
        "  --toc_title TOC_TITLE",
        "  --levels LEVELS [LEVELS ...]",
        "                        Heading levels to include",
        "  --no_quicklinks       Disable quick links bar",
        "  --no_back_to_toc      Do not add back-to-TOC links on headings",
        "  --no_top_bottom       Do not add Top/Bottom bookmarks",
        "",
      ].join("\n"),
    );
    return;
  }
  if (invocationArgs.length === 0) {
    process.stderr.write(
      [
        "usage: internal_nav.mjs [-h] --out OUT [--toc_title TOC_TITLE]",
        "                       [--levels LEVELS [LEVELS ...]] [--no_quicklinks]",
        "                       [--no_back_to_toc] [--no_top_bottom]",
        "                       input_docx",
        "internal_nav.mjs: error: the following arguments are required: input_docx, --out",
        "",
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }
  const args = process.argv.slice(2);
  const input = args[0];
  let output = null,
    title = "Table of Contents",
    levels = [1, 2, 3],
    quick = true,
    back = true,
    topBottom = true;
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === "--out") output = args[++i];
    else if (args[i] === "--toc_title") title = args[++i];
    else if (args[i] === "--levels") {
      levels = [];
      while (i + 1 < args.length && !args[i + 1].startsWith("--")) levels.push(Number(args[++i]));
    } else if (args[i] === "--no_quicklinks") quick = false;
    else if (args[i] === "--no_back_to_toc") back = false;
    else if (args[i] === "--no_top_bottom") topBottom = false;
    else {
      console.error(`unknown argument: ${args[i]}`);
      process.exitCode = 2;
      return;
    }
  }
  if (!input || !output) {
    console.error("usage: internal_nav.mjs input.docx --out out.docx [--levels 1 2 3]");
    process.exitCode = 2;
    return;
  }
  const zip = await JSZip.loadAsync(await fs.readFile(input));
  const entry = zip.file("word/document.xml");
  if (!entry) throw new Error("word/document.xml is missing");
  const doc = parseXml(await entry.async("nodebuffer"));
  const body = direct(doc.documentElement, "body")[0];
  if (!body) throw new Error("word/document.xml missing w:body");
  const paragraphs = direct(body, "p");
  if (!paragraphs.length) throw new Error("No paragraphs found in document body");
  let bookmarkId =
    Math.max(
      0,
      ...descendants(doc.documentElement, "bookmarkStart")
        .concat(descendants(doc.documentElement, "bookmarkEnd"))
        .map((node) => Number(wAttr(node, "id")))
        .filter(Number.isInteger),
    ) + 1;
  if (topBottom) {
    bookmark(paragraphs[0], "Top", bookmarkId++);
    bookmark(paragraphs.at(-1), "Bottom", bookmarkId++);
  }
  const headingInfos = [];
  let section = 0;
  for (const p of paragraphs) {
    const outline = direct(direct(p, "pPr")[0], "outlineLvl")[0];
    let level =
      outline && /^\d+$/.test(wAttr(outline, "val")) ? Number(wAttr(outline, "val")) + 1 : null;
    if (level == null) {
      const match = /^(?:Heading\s*|Heading)(\d+)$/i.exec(styleOf(p));
      if (match) level = Number(match[1]);
    }
    if (level == null || !levels.includes(level)) continue;
    const text = textOf(p);
    if (!text) continue;
    const name = `sec${String(++section).padStart(3, "0")}`;
    bookmark(p, name, bookmarkId++);
    headingInfos.push({ level, text, name, paragraph: p });
  }
  const toc = paragraph(doc, title, "Heading1");
  bookmark(toc, "TOC", bookmarkId++);
  body.insertBefore(toc, body.firstChild);
  let cursor = toc.nextSibling;
  for (const item of headingInfos) {
    const p = create(doc, "p");
    const indent = "  ".repeat(Math.max(1, item.level) - 1);
    if (indent) {
      const run = create(doc, "r"),
        t = create(doc, "t");
      t.appendChild(doc.createTextNode(indent));
      t.setAttributeNS(XML_NS, "xml:space", "preserve");
      run.appendChild(t);
      p.appendChild(run);
    }
    p.appendChild(hyperlink(doc, item.name, item.text));
    body.insertBefore(p, cursor);
  }
  const blank = paragraph(doc, "");
  body.insertBefore(blank, cursor);
  if (quick) {
    const links = create(doc, "p");
    links.appendChild(hyperlink(doc, "Top", "Top"));
    const sep = (text) => {
      const run = create(doc, "r"),
        t = create(doc, "t");
      t.appendChild(doc.createTextNode(text));
      t.setAttributeNS(XML_NS, "xml:space", "preserve");
      run.appendChild(t);
      return run;
    };
    links.appendChild(sep(" | "));
    links.appendChild(hyperlink(doc, "Bottom", "Bottom"));
    links.appendChild(sep(" | "));
    links.appendChild(hyperlink(doc, "TOC", "TOC"));
    const { figures, tables } = figureTableNames(doc.documentElement);
    for (const name of tables) {
      links.appendChild(sep(" | "));
      links.appendChild(hyperlink(doc, name, `Table ${name.slice(3)}`));
    }
    for (const name of figures) {
      links.appendChild(sep(" | "));
      links.appendChild(hyperlink(doc, name, `Figure ${name.slice(3)}`));
    }
    body.insertBefore(links, cursor);
    body.insertBefore(paragraph(doc, ""), cursor);
  }
  if (back)
    for (const item of headingInfos) {
      const run = create(doc, "r"),
        t = create(doc, "t");
      t.appendChild(doc.createTextNode(" "));
      t.setAttributeNS(XML_NS, "xml:space", "preserve");
      run.appendChild(t);
      item.paragraph.appendChild(run);
      item.paragraph.appendChild(hyperlink(doc, "TOC", "Back to TOC"));
    }
  const out = new JSZip();
  for (const [name, item] of Object.entries(zip.files))
    out.file(name, name === "word/document.xml" ? xmlBytes(doc) : await item.async("nodebuffer"), {
      binary: true,
      createFolders: false,
      date: item.date,
      unixPermissions: item.unixPermissions,
    });
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
