#!/usr/bin/env node
import fs from "node:fs/promises";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const DEFAULT_TABLE_INDENT_DXA = 120;
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
async function main() {
  const invocationArgs = process.argv.slice(2);
  if (invocationArgs.includes("--help") || invocationArgs.includes("-h")) {
    process.stdout.write(
      [
        "usage: table_geometry.mjs [-h] docx",
        "",
        "Audit exact DOCX table geometry",
        "",
        "positional arguments:",
        "  docx",
        "",
        "options:",
        "  -h, --help  show this help message and exit",
        "",
      ].join("\n"),
    );
    return;
  }
  if (invocationArgs.length === 0) {
    process.stderr.write(
      [
        "usage: table_geometry.mjs [-h] docx",
        "table_geometry.mjs: error: the following arguments are required: docx",
        "",
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }
  const input = process.argv[2];
  if (!input) {
    console.error("usage: table_geometry.mjs input.docx");
    process.exitCode = 2;
    return;
  }
  const zip = await JSZip.loadAsync(await fs.readFile(input));
  const entry = zip.file("word/document.xml");
  if (!entry) throw new Error("word/document.xml is missing");
  const root = parseXml(await entry.async("nodebuffer")).documentElement;
  let issues = 0;
  descendants(root, "tbl").forEach((table, tableIndex) => {
    const props = direct(table, "tblPr")[0];
    const tableWidth = direct(props, "tblW")[0];
    const tableIndent = direct(props, "tblInd")[0];
    const grid = direct(direct(table, "tblGrid")[0], "gridCol").map(
      (node) => Number(wAttr(node, "w")) || 0,
    );
    const width = Number(wAttr(tableWidth, "w")) || 0;
    const indent = tableIndent ? Number(wAttr(tableIndent, "w")) || 0 : null;
    const margins = descendants(table, "start")
      .filter((node) => node.parentNode?.parentNode?.parentNode === table)
      .map((node) => Number(wAttr(node, "w")) || 0);
    const expectedIndent = margins.length ? margins[0] : DEFAULT_TABLE_INDENT_DXA;
    console.log(
      `table ${tableIndex + 1}: tblW=${wAttr(tableWidth, "type") || "None"}:${width} tblInd=${wAttr(tableIndent, "type") || "None"}:${indent ?? "None"} grid_sum=${grid.reduce((a, b) => a + b, 0)} grid=[${grid.join(", ")}]`,
    );
    if (wAttr(tableWidth, "type") !== "dxa" || width <= 0) {
      console.log("  ISSUE: table width is missing or not DXA");
      issues += 1;
    }
    if (wAttr(tableIndent, "type") !== "dxa" || indent == null) {
      console.log("  ISSUE: table indent is missing or not DXA");
      issues += 1;
    } else if (indent !== expectedIndent) {
      console.log(
        `  ISSUE: table indent should match start cell margin (${expectedIndent} DXA) so the visible border aligns with body text`,
      );
      issues += 1;
    }
    if (new Set(margins).size > 1) {
      console.log("  ISSUE: start cell margins are inconsistent within the table");
      issues += 1;
    }
    if (grid.reduce((a, b) => a + b, 0) !== width) {
      console.log("  ISSUE: grid column sum does not equal table width");
      issues += 1;
    }
    for (const [rowIndex, row] of direct(table, "tr").entries()) {
      const cellWidths = direct(row, "tc").map(
        (cell) => Number(wAttr(direct(direct(cell, "tcPr")[0], "tcW")[0], "w")) || 0,
      );
      console.log(
        `  row ${rowIndex + 1}: tcW=[${cellWidths.join(", ")}] sum=${cellWidths.reduce((a, b) => a + b, 0)}`,
      );
      if (JSON.stringify(cellWidths) !== JSON.stringify(grid)) {
        console.log("  ISSUE: row cell widths do not match grid columns");
        issues += 1;
      }
    }
  });
  if (!issues) console.log("OK: all tables have matching tblW, tblInd, tblGrid, and tcW");
  else console.log(`ISSUES: ${issues}`);
  process.exitCode = issues ? 1 : 0;
}
main().catch((error) => {
  console.error(`[ERROR] ${error.message}`);
  process.exitCode = 2;
});
