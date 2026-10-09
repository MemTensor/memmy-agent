#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";

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
    .join("");
}
function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
async function main() {
  const invocationArgs = process.argv.slice(2);
  if (invocationArgs.includes("--help") || invocationArgs.includes("-h")) {
    process.stdout.write(
      [
        "usage: docx_table_to_csv.mjs [-h] [--table_index TABLE_INDEX] --out OUT docx",
        "",
        "Export a DOCX table to CSV",
        "",
        "positional arguments:",
        "  docx",
        "",
        "options:",
        "  -h, --help            show this help message and exit",
        "  --table_index TABLE_INDEX",
        "  --out OUT",
        "",
      ].join("\n"),
    );
    return;
  }
  if (invocationArgs.length === 0) {
    process.stderr.write(
      [
        "usage: docx_table_to_csv.mjs [-h] [--table_index TABLE_INDEX] --out OUT docx",
        "docx_table_to_csv.mjs: error: the following arguments are required: docx, --out",
        "",
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }
  const args = process.argv.slice(2);
  const input = args[0];
  let index = 0,
    output = null;
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === "--table_index") index = Number(args[++i]);
    else if (args[i] === "--out") output = args[++i];
    else {
      console.error(`unknown argument: ${args[i]}`);
      process.exitCode = 2;
      return;
    }
  }
  if (!input || !output) {
    console.error("usage: docx_table_to_csv.mjs input.docx --table_index 0 --out table.csv");
    process.exitCode = 2;
    return;
  }
  const zip = await JSZip.loadAsync(await fs.readFile(input));
  const entry = zip.file("word/document.xml");
  if (!entry) throw new Error("word/document.xml is missing");
  const root = parseXml(await entry.async("nodebuffer")).documentElement;
  const tables = descendants(root, "tbl");
  if (!tables.length) throw new Error("No tables found in DOCX");
  if (!Number.isInteger(index) || index < 0 || index >= tables.length)
    throw new Error(`table_index out of range (0..${tables.length - 1})`);
  const rows = direct(tables[index], "tr").map((row) =>
    direct(row, "tc").map((cell) =>
      direct(cell, "p")
        .map(paragraphText)
        .filter((text) => text.replaceAll("\n", "").length > 0)
        .join("\n"),
    ),
  );
  await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
  await fs.writeFile(
    output,
    rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + (rows.length ? "\r\n" : ""),
  );
  console.log(`[OK] Exported table ${index} → ${output}`);
}
main().catch((error) => {
  console.error(`[ERROR] ${error.message}`);
  process.exitCode = 2;
});
