#!/usr/bin/env node
import fs from "node:fs/promises";
import JSZip from "jszip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
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
function heading(style) {
  return /^heading/i.test(style || "");
}
async function main() {
  const invocationArgs = process.argv.slice(2);
  if (invocationArgs.includes("--help") || invocationArgs.includes("-h")) {
    process.stdout.write(
      [
        "usage: style_normalize.mjs [-h] [--out OUT] [--clear_paragraph_format]",
        "                          [--enforce_heading_spacing]",
        "                          input_docx [output_docx]",
        "",
        "positional arguments:",
        "  input_docx",
        "  output_docx           Output DOCX path (positional)",
        "",
        "options:",
        "  -h, --help            show this help message and exit",
        "  --out OUT             Output DOCX path (alias for positional output_docx)",
        "  --clear_paragraph_format",
        "                        Also clear paragraph-level direct formatting overrides",
        "                        (more invasive).",
        "  --enforce_heading_spacing",
        "                        Enforce a simple heading spacing rule (space-after =",
        "                        6pt).",
        "",
      ].join("\n"),
    );
    return;
  }
  if (invocationArgs.length === 0) {
    process.stderr.write(
      [
        "usage: style_normalize.mjs [-h] [--out OUT] [--clear_paragraph_format]",
        "                          [--enforce_heading_spacing]",
        "                          input_docx [output_docx]",
        "style_normalize.mjs: error: the following arguments are required: input_docx",
        "",
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }
  const args = process.argv.slice(2);
  const input = args[0];
  let positional = null,
    output = null,
    clearPara = false,
    enforce = false;
  for (let i = 1; i < args.length; i += 1) {
    if (!args[i].startsWith("--") && !positional) positional = args[i];
    else if (args[i] === "--out") output = args[++i];
    else if (args[i] === "--clear_paragraph_format") clearPara = true;
    else if (args[i] === "--enforce_heading_spacing") enforce = true;
    else {
      console.error(`unknown argument: ${args[i]}`);
      process.exitCode = 2;
      return;
    }
  }
  output ||= positional;
  if (!input || !output) {
    console.error("usage: style_normalize.mjs in.docx [out.docx] [--out out.docx]");
    process.exitCode = 2;
    return;
  }
  const zip = await JSZip.loadAsync(await fs.readFile(input));
  const entry = zip.file("word/document.xml");
  if (!entry) throw new Error("word/document.xml is missing");
  const doc = parseXml(await entry.async("nodebuffer"));
  const root = doc.documentElement;
  let runChanges = 0,
    paraChanges = 0,
    headingChanges = 0;
  for (const run of descendants(root, "r")) {
    const props = direct(run, "rPr")[0];
    if (!props) continue;
    let changed = false;
    for (const name of ["rFonts", "sz", "b", "i", "u", "color"])
      for (const node of direct(props, name)) {
        props.removeChild(node);
        changed = true;
      }
    if (changed) runChanges += 1;
  }
  for (const p of descendants(root, "p")) {
    const props = direct(p, "pPr")[0];
    if (props && clearPara) {
      for (const name of ["ind", "spacing"])
        for (const node of direct(props, name)) {
          const attrs = node.attributes
            ? Array.from(node.attributes).filter(
                (attribute) => attribute.name.startsWith("w:") || attribute.namespaceURI === W_NS,
              )
            : [];
          paraChanges += Math.max(1, attrs.length);
          props.removeChild(node);
        }
    }
    if (
      enforce &&
      heading(wAttr(direct(p, "pPr")[0] && direct(direct(p, "pPr")[0], "pStyle")[0], "val"))
    ) {
      let pPr = props;
      if (!pPr) {
        pPr = doc.createElementNS(W_NS, "w:pPr");
        p.insertBefore(pPr, p.firstChild);
      }
      let spacing = direct(pPr, "spacing")[0];
      const old = wAttr(spacing, "after");
      if (old !== "120") {
        if (!spacing) {
          spacing = doc.createElementNS(W_NS, "w:spacing");
          pPr.appendChild(spacing);
        }
        setWAttr(spacing, "after", "120");
        headingChanges += 1;
      }
    }
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
  console.log(
    `[OK] wrote ${output} | run_overrides_cleared=${runChanges} para_overrides_cleared=${paraChanges} heading_spacing_updates=${headingChanges}`,
  );
}
main().catch((error) => {
  console.error(`[ERROR] ${error.message}`);
  process.exitCode = 2;
});
