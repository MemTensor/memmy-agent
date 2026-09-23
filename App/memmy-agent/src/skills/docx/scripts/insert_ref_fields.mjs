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
function create(doc, name) {
  return doc.createElementNS(W_NS, `w:${name}`);
}
function textRun(doc, text) {
  const run = create(doc, "r");
  const t = create(doc, "t");
  t.appendChild(doc.createTextNode(text));
  if (/^\s|\s$/.test(text)) t.setAttributeNS(XML_NS, "xml:space", "preserve");
  run.appendChild(t);
  return run;
}
function fieldRuns(doc, bookmark) {
  const begin = create(doc, "r");
  const beginChar = create(doc, "fldChar");
  beginChar.setAttributeNS(W_NS, "w:fldCharType", "begin");
  begin.appendChild(beginChar);
  const instr = create(doc, "r");
  const instrText = create(doc, "instrText");
  instrText.setAttributeNS(XML_NS, "xml:space", "preserve");
  instrText.appendChild(doc.createTextNode(` REF ${bookmark} \\h `));
  instr.appendChild(instrText);
  const separate = create(doc, "r");
  const separateChar = create(doc, "fldChar");
  separateChar.setAttributeNS(W_NS, "w:fldCharType", "separate");
  separate.appendChild(separateChar);
  const result = textRun(doc, "0");
  const end = create(doc, "r");
  const endChar = create(doc, "fldChar");
  endChar.setAttributeNS(W_NS, "w:fldCharType", "end");
  end.appendChild(endChar);
  return [begin, instr, separate, result, end];
}
function replacePart(doc, regex, prefix) {
  let count = 0;
  for (const t of descendants(doc.documentElement, "t")) {
    const value = t.textContent;
    if (!value) continue;
    regex.lastIndex = 0;
    const matches = [...value.matchAll(regex)];
    if (!matches.length) continue;
    const run = t.parentNode;
    const parent = run?.parentNode;
    if (!run || localName(run) !== "r" || !parent) continue;
    const position = Array.from(parent.childNodes).indexOf(run);
    const replacement = [];
    let cursor = 0;
    for (const match of matches) {
      if (match.index > cursor) replacement.push(textRun(doc, value.slice(cursor, match.index)));
      if (prefix) replacement.push(textRun(doc, prefix));
      replacement.push(...fieldRuns(doc, match.groups?.bookmark || match[1] || ""));
      cursor = match.index + match[0].length;
      count += 1;
    }
    if (cursor < value.length) replacement.push(textRun(doc, value.slice(cursor)));
    parent.removeChild(run);
    replacement.forEach((node, index) =>
      parent.insertBefore(node, parent.childNodes[position + index] || null),
    );
  }
  return count;
}
async function main() {
  const invocationArgs = process.argv.slice(2);
  if (invocationArgs.includes("--help") || invocationArgs.includes("-h")) {
    process.stdout.write(
      [
        "usage: insert_ref_fields.mjs [-h] [--pattern PATTERN] [--prefix PREFIX]",
        "                            input_docx output_docx",
        "",
        "Insert Word cross-references (REF fields) by replacing lightweight markers.",
        "Why this exists -------------- Word cross-references are implemented as `REF`",
        "fields that point at a bookmark. `OOXML` does not expose a first-class",
        "API for these fields. This helper lets you author docs with simple markers",
        'like: "See [[REF:tbl1]] for details." …and then replace those markers with',
        "real `REF` fields in OOXML. Design goals ------------ - Minimal,",
        "deterministic, local-runtime friendly. - Works on document.xml +",
        "headers/footers. - Keeps implementation small and easy to reuse/import.",
        "Limitations ----------- - The marker must be fully contained in a single",
        "`<w:t>` node. (If Word splits it across runs, retype the marker as a single",
        "contiguous token.) - This does *not* create bookmarks. Pair with",
        "`captions_and_crossrefs.mjs --bookmarks`. - For stable headless QA, run",
        "`fields_materialize.mjs` afterwards. Example ------- 1) Add captions +",
        "bookmarks: node scripts/captions_and_crossrefs.mjs in.docx out_caps.docx",
        "--tables --bookmarks 2) Replace markers with REF fields: node",
        "scripts/insert_ref_fields.mjs out_caps.docx out_refs.docx 3) Materialize:",
        "node scripts/fields_materialize.mjs out_refs.docx --out out_refs_mat.docx",
        "",
        "positional arguments:",
        "  input_docx",
        "  output_docx",
        "",
        "options:",
        "  -h, --help         show this help message and exit",
        "  --pattern PATTERN  Regex for markers. Must contain a named group 'bookmark'.",
        "                     Default matches [[REF:tbl1]].",
        "  --prefix PREFIX    Optional text inserted immediately before the REF field.",
        "",
      ].join("\n"),
    );
    return;
  }
  if (invocationArgs.length === 0) {
    process.stderr.write(
      [
        "usage: insert_ref_fields.mjs [-h] [--pattern PATTERN] [--prefix PREFIX]",
        "                            input_docx output_docx",
        "insert_ref_fields.mjs: error: the following arguments are required: input_docx, output_docx",
        "",
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }
  const args = process.argv.slice(2);
  const input = args[0],
    output = args[1];
  let pattern = "\\[\\[REF:(?<bookmark>[A-Za-z0-9_:\\-]+)\\]\\]",
    prefix = "";
  for (let i = 2; i < args.length; i += 1) {
    if (args[i] === "--pattern") pattern = args[++i];
    else if (args[i] === "--prefix") prefix = args[++i];
    else {
      console.error(`unknown argument: ${args[i]}`);
      process.exitCode = 2;
      return;
    }
  }
  if (!input || !output) {
    console.error(
      "usage: insert_ref_fields.mjs input.docx output.docx [--pattern REGEX] [--prefix TEXT]",
    );
    process.exitCode = 2;
    return;
  }
  pattern = pattern.replace(/\(\?P<([A-Za-z0-9_]+)>/g, "(?<$1>");
  let regex;
  try {
    regex = new RegExp(pattern, "g");
  } catch (error) {
    console.error(`[ERROR] invalid --pattern: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  const zip = await JSZip.loadAsync(await fs.readFile(input));
  const out = new JSZip();
  let total = 0;
  for (const [name, entry] of Object.entries(zip.files)) {
    if (/^word\/(?:document|header\d+|footer\d+)\.xml$/.test(name)) {
      const doc = parseXml(await entry.async("nodebuffer"));
      total += replacePart(doc, regex, prefix);
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
  await fs.writeFile(
    output,
    await out.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
  );
  console.log(`[OK] wrote ${output} | markers_replaced=${total}`);
}
main().catch((error) => {
  console.error(`[ERROR] ${error.message}`);
  process.exitCode = 2;
});
