#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
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
function direct(root, name) {
  return descendants(root, name).filter((node) => node.parentNode === root);
}
function wAttr(node, name) {
  return node?.getAttributeNS(W_NS, name) || node?.getAttribute(`w:${name}`) || "";
}
function textOf(p) {
  return descendants(p, "t")
    .map((node) => node.textContent || "")
    .join("");
}
function styleOf(p) {
  return wAttr(direct(p, "pPr")[0] && direct(direct(p, "pPr")[0], "pStyle")[0], "val");
}
function hasDirectRunFormatting(run) {
  const props = direct(run, "rPr")[0];
  if (!props) return false;
  return ["b", "i", "u", "rFonts", "sz", "color"].some((name) => Boolean(direct(props, name)[0]));
}
function hasDirectParaFormatting(p) {
  const props = direct(p, "pPr")[0];
  if (!props) return false;
  return ["ind", "spacing"].some((name) => Boolean(direct(props, name)[0]));
}
function looksLikeHeading(p) {
  const text = textOf(p).trim();
  if (!text || text.length > 80 || /[.;:]$/.test(text)) return false;
  return descendants(p, "b").length > 0;
}
function paragraphParts(zip) {
  return Object.keys(zip.files).filter((name) =>
    /^word\/(?:document|header\d+|footer\d+)\.xml$/.test(name),
  );
}
async function main() {
  const invocationArgs = process.argv.slice(2);
  if (invocationArgs.includes("--help") || invocationArgs.includes("-h")) {
    process.stdout.write(
      [
        "usage: style_lint.mjs [-h] [--json JSON_OUT] input_docx",
        "",
        "Lint a DOCX for common style/formatting issues",
        "",
        "positional arguments:",
        "  input_docx",
        "",
        "options:",
        "  -h, --help       show this help message and exit",
        "  --json JSON_OUT  Write a JSON report to this path",
        "",
      ].join("\n"),
    );
    return;
  }
  if (invocationArgs.length === 0) {
    process.stderr.write(
      [
        "usage: style_lint.mjs [-h] [--json JSON_OUT] input_docx",
        "style_lint.mjs: error: the following arguments are required: input_docx",
        "",
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }
  const args = process.argv.slice(2);
  const input = args[0];
  let jsonOut = null;
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === "--json") jsonOut = args[++i];
    else {
      console.error(`unknown argument: ${args[i]}`);
      process.exitCode = 2;
      return;
    }
  }
  if (!input) {
    console.error("usage: style_lint.mjs input.docx [--json report.json]");
    process.exitCode = 2;
    return;
  }
  const zip = await JSZip.loadAsync(await fs.readFile(input));
  const fontCounts = new Map();
  let directRuns = 0,
    directParas = 0;
  const headingIssues = [];
  const examples = { direct_paragraph_formatting: [], direct_run_formatting: [] };
  let paraIndex = 0;
  for (const name of paragraphParts(zip)) {
    const root = parseXml(await zip.file(name).async("nodebuffer")).documentElement;
    for (const p of descendants(root, "p")) {
      paraIndex += 1;
      const style = styleOf(p);
      const text = textOf(p);
      if (hasDirectParaFormatting(p)) {
        directParas += 1;
        if (examples.direct_paragraph_formatting.length < 5)
          examples.direct_paragraph_formatting.push({
            para_index: paraIndex,
            text: text.slice(0, 120),
            style,
          });
      }
      if (looksLikeHeading(p) && !style.startsWith("Heading"))
        headingIssues.push({ para_index: paraIndex, text: text.slice(0, 120), style });
      for (const run of descendants(p, "r")) {
        const runText = textOf(run);
        const rPr = direct(run, "rPr")[0];
        const fonts = rPr && direct(rPr, "rFonts")[0];
        if (runText) {
          const font =
            fonts &&
            (wAttr(fonts, "ascii") ||
              wAttr(fonts, "hAnsi") ||
              wAttr(fonts, "eastAsia") ||
              wAttr(fonts, "cs"));
          if (font) fontCounts.set(font, (fontCounts.get(font) || 0) + runText.length);
        }
        if (hasDirectRunFormatting(run)) {
          directRuns += 1;
          if (examples.direct_run_formatting.length < 5)
            examples.direct_run_formatting.push({
              para_index: paraIndex,
              run_text: runText.slice(0, 80),
              style,
            });
        }
      }
    }
  }
  const fontsByCharCount = Object.fromEntries(
    [...fontCounts.entries()].sort((a, b) => b[1] - a[1]),
  );
  const report = {
    input: path.resolve(input),
    fonts_by_char_count: fontsByCharCount,
    direct_run_formatting_runs: directRuns,
    direct_paragraph_formatting_paragraphs: directParas,
    heading_like_paragraphs_not_heading_style: headingIssues.slice(0, 20),
  };
  report.examples = Object.fromEntries(
    Object.entries(examples).filter(([, values]) => values.length > 0),
  );
  report.notes = [
    "Direct formatting is not always wrong, but it often causes inconsistent output when templates change.",
    "Heading-like paragraphs not using Heading styles can break TOC and accessibility.",
  ];
  if (jsonOut) await fs.writeFile(jsonOut, JSON.stringify(report, null, 2));
  console.log("[style_lint] direct run-formatting runs:", directRuns);
  console.log("[style_lint] direct paragraph-formatting paragraphs:", directParas);
  const top = Object.entries(fontsByCharCount)
    .slice(0, 5)
    .map(([name, count]) => `${name}(${count})`)
    .join(", ");
  if (top) console.log("[style_lint] top fonts by char count:", top);
  if (headingIssues.length) {
    console.log("[style_lint] heading-like paragraphs not using Heading styles (first 10):");
    for (const item of headingIssues.slice(0, 10))
      console.log(`  - #${item.para_index}: style='${item.style}' text='${item.text}'`);
  }
}
main().catch((error) => {
  console.error(`[ERROR] ${error.message}`);
  process.exitCode = 2;
});
