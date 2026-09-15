#!/usr/bin/env node
import fs from "node:fs/promises";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";
import { PNG } from "pngjs";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const DEFAULT_RENDER = path.join(path.dirname(fileURLToPath(import.meta.url)), "render_docx.mjs");
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
async function runRender(script, docx, output) {
  await fs.mkdir(output, { recursive: true });
  const result = spawnSync(process.execPath, [script, docx, "--output_dir", output], {
    stdio: "inherit",
    shell: false,
    windowsHide: true,
  });
  if (result.status !== 0)
    throw new Error(`render failed for ${docx} with exit code ${result.status ?? 1}`);
}
async function listPages(directory) {
  return (await fs.readdir(directory))
    .filter((name) => /^page-\d+\.png$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
    .map((name) => path.join(directory, name));
}
function readPng(file) {
  return PNG.sync.read(readFileSync(file));
}
function diffImages(aPath, bPath, outPath) {
  const a = readPng(aPath),
    b = readPng(bPath);
  const width = Math.max(a.width, b.width),
    height = Math.max(a.height, b.height);
  const diff = new PNG({ width, height });
  let changed = false;
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const ai = x < a.width && y < a.height ? (y * a.width + x) * 4 : -1;
      const bi = x < b.width && y < b.height ? (y * b.width + x) * 4 : -1;
      const ar = ai < 0 ? 255 : a.data[ai],
        ag = ai < 0 ? 255 : a.data[ai + 1],
        ab = ai < 0 ? 255 : a.data[ai + 2];
      const br = bi < 0 ? 255 : b.data[bi],
        bg = bi < 0 ? 255 : b.data[bi + 1],
        bb = bi < 0 ? 255 : b.data[bi + 2];
      const di = (y * width + x) * 4;
      diff.data[di] = Math.abs(ar - br);
      diff.data[di + 1] = Math.abs(ag - bg);
      diff.data[di + 2] = Math.abs(ab - bb);
      diff.data[di + 3] = 255;
      if (ar !== br || ag !== bg || ab !== bb) changed = true;
    }
  if (changed) {
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, PNG.sync.write(diff));
  }
  return changed;
}
async function extractText(file) {
  const zip = await JSZip.loadAsync(await fs.readFile(file));
  const entry = zip.file("word/document.xml");
  if (!entry) throw new Error("word/document.xml is missing");
  const root = parseXml(await entry.async("nodebuffer")).documentElement;
  const paragraphs = descendants(root, "p")
    .map((p) =>
      descendants(p, "t")
        .map((node) => node.textContent || "")
        .join(""),
    )
    .filter(Boolean);
  return paragraphs.join("\n") + "\n";
}
function unifiedDiff(a, b) {
  const left = a.split(/(?<=\n)/),
    right = b.split(/(?<=\n)/);
  if (a === b) return "";
  const lines = ["--- a\n", "+++ b\n", `@@ -1,${left.length} +1,${right.length} @@\n`];
  lines.push(...left.filter((line) => !right.includes(line)).map((line) => `-${line}`));
  lines.push(...right.filter((line) => !left.includes(line)).map((line) => `+${line}`));
  return lines.join("");
}
async function main() {
  const invocationArgs = process.argv.slice(2);
  if (invocationArgs.includes("--help") || invocationArgs.includes("-h")) {
    process.stdout.write(
      [
        "usage: render_and_diff.mjs [-h] --outdir OUTDIR [--render_py RENDER_PY]",
        "                          a_docx b_docx",
        "",
        "positional arguments:",
        "  a_docx",
        "  b_docx",
        "",
        "options:",
        "  -h, --help            show this help message and exit",
        "  --outdir OUTDIR",
        "  --render_py RENDER_PY",
        "                        Path to render_docx.mjs",
        "",
      ].join("\n"),
    );
    return;
  }
  if (invocationArgs.length === 0) {
    process.stderr.write(
      [
        "usage: render_and_diff.mjs [-h] --outdir OUTDIR [--render_py RENDER_PY]",
        "                          a_docx b_docx",
        "render_and_diff.mjs: error: the following arguments are required: a_docx, b_docx, --outdir",
        "",
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }
  const args = process.argv.slice(2);
  const aDocx = args[0],
    bDocx = args[1];
  let output = null,
    renderScript = DEFAULT_RENDER;
  for (let i = 2; i < args.length; i += 1) {
    if (args[i] === "--outdir") output = args[++i];
    else if (args[i] === "--render_py") renderScript = args[++i];
    else {
      console.error(`unknown argument: ${args[i]}`);
      process.exitCode = 2;
      return;
    }
  }
  if (!aDocx || !bDocx || !output) {
    console.error(
      "usage: render_and_diff.mjs a.docx b.docx --outdir DIR [--render_py render_docx.mjs]",
    );
    process.exitCode = 2;
    return;
  }
  const aRender = path.join(output, "a_render"),
    bRender = path.join(output, "b_render"),
    diffDir = path.join(output, "diff_pages");
  await runRender(renderScript, aDocx, aRender);
  await runRender(renderScript, bDocx, bRender);
  const aPages = await listPages(aRender),
    bPages = await listPages(bRender);
  const changed = [];
  for (let index = 1; index <= Math.max(aPages.length, bPages.length); index += 1) {
    const a = path.join(aRender, `page-${index}.png`),
      b = path.join(bRender, `page-${index}.png`);
    try {
      await fs.access(a);
      await fs.access(b);
      if (diffImages(a, b, path.join(diffDir, `diff-page-${index}.png`))) changed.push(index);
    } catch {
      changed.push(index);
    }
  }
  const textA = await extractText(aDocx),
    textB = await extractText(bDocx);
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, "text_a.txt"), textA);
  await fs.writeFile(path.join(output, "text_b.txt"), textB);
  await fs.writeFile(path.join(output, "text_diff.txt"), unifiedDiff(textA, textB));
  const summary = {
    a_docx: path.resolve(aDocx),
    b_docx: path.resolve(bDocx),
    pages_a: aPages.length,
    pages_b: bPages.length,
    changed_pages: changed,
    num_changed_pages: changed.length,
  };
  await fs.writeFile(path.join(output, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(`[OK] wrote ${output}`);
  console.log(`[summary] changed_pages=[${changed.join(", ")}]`);
}
main().catch((error) => {
  console.error(`[ERROR] ${error.message}`);
  process.exitCode = 2;
});
