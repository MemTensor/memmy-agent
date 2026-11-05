/** Generated code runs only here, under Node's permission model and the outer OS sandbox. */
import fs from "node:fs/promises";
import path from "node:path";
import * as docx from "docx";
import ExcelJS from "exceljs";
import PptxGenJS from "pptxgenjs";
import JSZip from "jszip";
import * as PDFLib from "pdf-lib";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

async function main() {
let body = "";
for await (const chunk of process.stdin) {
  body += chunk;
  if (body.length > 200000) throw new Error("Execution request too large");
}
const { code, workspace } = JSON.parse(body);
// Console output cannot forge the parent's capability protocol. Exactly one
// bounded JSON result is returned; diagnostics go to stderr.
console.log = console.info = console.warn = (...args) => console.error(...args);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
try {
  const execute = new AsyncFunction("docx", "ExcelJS", "PptxGenJS", "JSZip", "PDFLib", "DOMParser", "XMLSerializer", "fs", "path", "workspace", code);
  const result = await execute(docx, ExcelJS, PptxGenJS, JSZip, PDFLib, DOMParser, XMLSerializer, fs, path, workspace);
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  console.error(error.stack ?? error);
  process.exitCode = 1;
}
}
main().catch(error => { console.error(error); process.exitCode = 1; });
