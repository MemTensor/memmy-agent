#!/usr/bin/env node
import fs from "node:fs/promises";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";

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
function children(root, name) {
  return descendants(root).filter(
    (node) => node.parentNode === root && (!name || localName(node) === name),
  );
}
function wAttr(node, name) {
  return node?.getAttributeNS(W_NS, name) || node?.getAttribute(`w:${name}`) || null;
}
function paragraphText(paragraph) {
  return descendants(paragraph)
    .map((node) =>
      localName(node) === "t"
        ? node.textContent || ""
        : localName(node) === "tab"
          ? "\t"
          : ["br", "cr"].includes(localName(node))
            ? "\n"
            : "",
    )
    .join("")
    .trim();
}
function commentText(comment) {
  const paragraphs = children(comment, "p").map(paragraphText).filter(Boolean);
  return paragraphs.length
    ? paragraphs.join("\n").trim()
    : descendants(comment, "t")
        .map((node) => node.textContent || "")
        .join("")
        .trim();
}
function storyParts(zip) {
  return [
    "word/document.xml",
    ...Object.keys(zip.files).filter((name) => /^word\/(?:header|footer)\d+\.xml$/.test(name)),
  ];
}
async function main() {
  const invocationArgs = process.argv.slice(2);
  if (invocationArgs.includes("--help") || invocationArgs.includes("-h")) {
    process.stdout.write(
      [
        "usage: comments_extract.mjs [-h] --out OUT in_docx",
        "",
        "Extract DOCX comments into JSON",
        "",
        "positional arguments:",
        "  in_docx",
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
        "usage: comments_extract.mjs [-h] --out OUT in_docx",
        "comments_extract.mjs: error: the following arguments are required: in_docx, --out",
        "",
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }
  const args = process.argv.slice(2);
  const input = args[0];
  let output = null;
  if (args[1] !== "--out" || !args[2]) {
    console.error("usage: comments_extract.mjs input.docx --out comments.json");
    process.exitCode = 2;
    return;
  }
  output = args[2];
  const zip = await JSZip.loadAsync(await fs.readFile(input));
  const comments = new Map();
  const part = zip.file("word/comments.xml");
  if (part) {
    const root = parseXml(await part.async("nodebuffer"));
    for (const comment of descendants(root, "comment")) {
      const id = wAttr(comment, "id");
      if (!id) continue;
      comments.set(id, {
        id,
        author: wAttr(comment, "author"),
        date: wAttr(comment, "date"),
        initials: wAttr(comment, "initials"),
        resolved: wAttr(comment, "done") === "1",
        text: commentText(comment),
      });
    }
  }
  const anchors = new Map([...comments.keys()].map((id) => [id, []]));
  for (const name of storyParts(zip)) {
    const entry = zip.file(name);
    if (!entry) continue;
    const root = parseXml(await entry.async("nodebuffer"));
    for (const paragraph of descendants(root, "p")) {
      const text = paragraphText(paragraph);
      for (const marker of [
        ...descendants(paragraph, "commentRangeStart"),
        ...descendants(paragraph, "commentRangeEnd"),
      ]) {
        const id = wAttr(marker, "id");
        if (!id) continue;
        const where = localName(marker) === "commentRangeStart" ? "start" : "end";
        if (!anchors.has(id)) anchors.set(id, []);
        const existing = anchors.get(id).find((item) => item.part === name);
        if (existing) existing.paragraphs.push({ where, text: text.slice(0, 200) });
        else
          anchors.get(id).push({ part: name, paragraphs: [{ where, text: text.slice(0, 200) }] });
      }
    }
  }
  const sorted = [...comments.values()].sort((a, b) =>
    /^\d+$/.test(a.id) && /^\d+$/.test(b.id)
      ? Number(a.id) - Number(b.id)
      : a.id.localeCompare(b.id),
  );
  const report = {
    file: input,
    comment_count: comments.size,
    comments: sorted.map((comment) => ({ ...comment, anchors: anchors.get(comment.id) || [] })),
  };
  await fs.writeFile(output, JSON.stringify(report, null, 2));
  console.log(`[OK] wrote ${output} (${report.comment_count} comments)`);
}
main().catch((error) => {
  console.error(`[ERROR] ${error.message}`);
  process.exitCode = 2;
});
