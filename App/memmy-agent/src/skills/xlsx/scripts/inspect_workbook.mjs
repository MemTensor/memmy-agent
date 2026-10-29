#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";

const usage = `Usage: inspect_workbook.mjs --input <workbook.xlsx|xlsm|xltx|csv|tsv> [--json]
       inspect_workbook.mjs <workbook>`;

function parseArgs(argv) {
  const result = { input: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--json") result.json = true;
    else if (arg === "--input" || arg === "-i") result.input = argv[++i];
    else if (!arg.startsWith("-") && !result.input) result.input = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!result.input) throw new Error("Missing input");
  return result;
}

function csvRows(text, delimiter) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const character = text[i];
    if (quoted) {
      if (character === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"' && field.length === 0) quoted = true;
    else if (character === delimiter) { row.push(field); field = ""; }
    else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += character;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function cellRecord(cell) {
  const raw = cell.value;
  const formula = raw && typeof raw === "object" && "formula" in raw ? String(raw.formula) : cell.type === 6 ? String(raw ?? "") : null;
  const cached = raw && typeof raw === "object" && "formula" in raw ? raw.result ?? null : raw;
  const error = typeof cached === "string" && /^#(?:REF!|DIV\/0!|VALUE!|NAME\?|N\/A|NUM!|NULL!)/i.test(cached) ? cached : null;
  return { address: cell.address, type: cell.type, formula, value: cached, error, numberFormat: cell.numFmt || null, styleId: cell.styleId ?? null };
}

async function inspect(options) {
  const input = path.resolve(options.input);
  const bytes = await fs.readFile(input).catch(() => null);
  if (!bytes) throw new Error(`Input does not exist: ${input}`);
  const extension = path.extname(input).toLowerCase();
  if (![".xlsx", ".xlsm", ".xltx", ".csv", ".tsv"].includes(extension)) throw new Error(`Unsupported workbook extension: ${extension || "(none)"}`);
  const workbook = new ExcelJS.Workbook();
  if (extension === ".csv" || extension === ".tsv") {
    const text = bytes.toString("utf8").replace(/^\uFEFF/, "");
    const rows = csvRows(text, extension === ".tsv" ? "\t" : ",");
    return { ok: true, input, type: extension.slice(1), sheets: [{ name: "Sheet1", state: "visible", dimensions: { rows: rows.length, columns: Math.max(0, ...rows.map((row) => row.length)) }, rows }], formulas: [], externalLinks: [], macros: false };
  }
  await workbook.xlsx.load(bytes, { ignoreNodes: [] });
  const sheets = [];
  const formulas = [];
  for (const worksheet of workbook.worksheets) {
    let minRow = Infinity; let maxRow = 0; let minColumn = Infinity; let maxColumn = 0;
    const cells = [];
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      minRow = Math.min(minRow, rowNumber); maxRow = Math.max(maxRow, rowNumber);
      row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
        minColumn = Math.min(minColumn, columnNumber); maxColumn = Math.max(maxColumn, columnNumber);
        const record = cellRecord(cell);
        cells.push(record);
        if (record.formula) formulas.push({ sheet: worksheet.name, cell: record.address, formula: record.formula, value: record.value, error: record.error });
      });
    });
    sheets.push({ name: worksheet.name, state: worksheet.state, dimensions: { minRow: Number.isFinite(minRow) ? minRow : 0, maxRow, minColumn: Number.isFinite(minColumn) ? minColumn : 0, maxColumn }, merges: [...(worksheet.model.merges ?? [])].sort(), views: worksheet.views ?? [], cells, rowHeights: Object.fromEntries(Object.entries(worksheet._rows ?? {}).filter(([, row]) => row?.height).map(([number, row]) => [number, row.height])), columnWidths: Object.fromEntries(Object.entries(worksheet.columns ?? {}).filter(([, column]) => column?.width).map(([number, column]) => [number, column.width])) });
  }
  const externalLinks = [...workbook._externalLinks ?? []].map((link) => link.target || link.path || "external");
  const macros = extension === ".xlsm" || workbook.vbaProject !== undefined;
  return { ok: true, input, type: extension.slice(1), sheets, formulas, externalLinks, macros };
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(usage); process.exit(0); }
  const report = await inspect(options);
  if (options.json) console.log(JSON.stringify(report));
  else console.log(`${report.ok ? "ok" : "failed"}: ${report.sheets.length} sheets, ${report.formulas.length} formulas`);
} catch (error) {
  if (options?.json) console.log(JSON.stringify({ ok: false, error: { code: "input_error", message: error.message } }));
  else console.error(error.message);
  process.exitCode = 1;
}
