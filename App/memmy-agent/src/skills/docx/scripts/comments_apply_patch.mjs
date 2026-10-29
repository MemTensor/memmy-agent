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
function wAttr(node, name) {
  return node?.getAttributeNS(W_NS, name) || node?.getAttribute(`w:${name}`) || "";
}
function appendParagraph(comment, text) {
  const doc = comment.ownerDocument;
  const p = doc.createElementNS(W_NS, "w:p");
  const r = doc.createElementNS(W_NS, "w:r");
  const t = doc.createElementNS(W_NS, "w:t");
  t.appendChild(doc.createTextNode(text));
  r.appendChild(t);
  p.appendChild(r);
  comment.appendChild(p);
}
function lines(value) {
  return String(value)
    .split("\n")
    .map((line) => line.replaceAll("\r", "").trim())
    .filter(Boolean);
}
function replaceText(comment, text) {
  for (const child of [...comment.childNodes])
    if (child.nodeType === 1 && localName(child) === "p") comment.removeChild(child);
  const values = lines(text);
  if (!values.length) appendParagraph(comment, "");
  else for (const value of values) appendParagraph(comment, value);
}
async function main() {
  const invocationArgs = process.argv.slice(2);
  if (invocationArgs.includes("--help") || invocationArgs.includes("-h")) {
    process.stdout.write(
      [
        "usage: comments_apply_patch.mjs [-h] --out OUT in_docx patch_json",
        "",
        "Append/replace/resolve existing Word comments",
        "",
        "positional arguments:",
        "  in_docx",
        "  patch_json",
        "",
        "options:",
        "  -h, --help  show this help message and exit",
        "  --out OUT",
        "",
      ].join("\n"),
    );
    return;
  }
  if (invocationArgs.length === 0) {
    process.stderr.write(
      [
        "usage: comments_apply_patch.mjs [-h] --out OUT in_docx patch_json",
        "comments_apply_patch.mjs: error: the following arguments are required: in_docx, patch_json, --out",
        "",
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }
  const args = process.argv.slice(2);
  const input = args[0],
    patchPath = args[1];
  let output = null;
  for (let i = 2; i < args.length; i += 1) {
    if (args[i] === "--out") output = args[++i];
    else {
      console.error(`unknown argument: ${args[i]}`);
      process.exitCode = 2;
      return;
    }
  }
  if (!input || !patchPath || !output) {
    console.error("usage: comments_apply_patch.mjs in.docx patch.json --out out.docx");
    process.exitCode = 2;
    return;
  }
  const patch = JSON.parse(await fs.readFile(patchPath, "utf8"));
  const ops = Array.isArray(patch.ops) ? patch.ops : [];
  const zip = await JSZip.loadAsync(await fs.readFile(input));
  const entry = zip.file("word/comments.xml");
  if (!entry) {
    console.error("[comments_apply_patch] word/comments.xml not found");
    process.exitCode = 1;
    return;
  }
  const doc = parseXml(await entry.async("nodebuffer"));
  let changed = 0;
  const touched = new Set();
  for (const op of ops) {
    if (op.id == null) continue;
    const id = String(op.id);
    const comment = descendants(doc.documentElement, "comment").find(
      (node) => wAttr(node, "id") === id,
    );
    if (!comment) {
      console.log(`[warn] comment id ${id} not found`);
      continue;
    }
    let did = false;
    if (op.replace != null) {
      replaceText(comment, String(op.replace));
      did = true;
    }
    if (op.append != null) {
      for (const value of lines(op.append)) appendParagraph(comment, value);
      did = true;
    }
    if (op.resolved === true) {
      comment.setAttributeNS(W_NS, "w:done", "1");
      comment.setAttributeNS(W_NS, "w:date", new Date().toISOString().replace(/\.\d{3}Z$/, "Z"));
      did = true;
    } else if (op.resolved === false && wAttr(comment, "done")) {
      comment.removeAttributeNS(W_NS, "done");
      comment.removeAttribute("w:done");
      comment.setAttributeNS(W_NS, "w:date", new Date().toISOString().replace(/\.\d{3}Z$/, "Z"));
      did = true;
    }
    if (did) {
      changed += 1;
      touched.add(id);
    }
  }
  const out = new JSZip();
  for (const [name, item] of Object.entries(zip.files))
    out.file(name, name === "word/comments.xml" ? xmlBytes(doc) : await item.async("nodebuffer"), {
      binary: true,
      createFolders: false,
      date: item.date,
      unixPermissions: item.unixPermissions,
    });
  await fs.writeFile(
    output,
    await out.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
  );
  console.log(`[OK] wrote ${output} (comments_touched=${touched.size} ops_applied=${changed})`);
}
main().catch((error) => {
  console.error(`[ERROR] ${error.message}`);
  process.exitCode = 2;
});
