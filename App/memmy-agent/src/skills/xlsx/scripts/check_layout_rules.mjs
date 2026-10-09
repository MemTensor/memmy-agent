#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";

const usage = `Usage: check_layout_rules.mjs --input <workbook.xlsx|xlsm|xltx> [--json]
       check_layout_rules.mjs <workbook>`;

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

async function check(options) {
  const input = path.resolve(options.input);
  const bytes = await fs.readFile(input).catch(() => null);
  if (!bytes) throw new Error(`Input does not exist: ${input}`);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes, { ignoreNodes: [] });
  const errors = [];
  const warnings = [];
  const sheets = [];
  for (const worksheet of workbook.worksheets) {
    const merges = [...(worksheet.model.merges ?? [])].sort();
    const hidden = worksheet.state !== "visible";
    if (hidden) warnings.push({ code: "hidden_sheet", sheet: worksheet.name, state: worksheet.state, message: "Sheet is hidden and must be preserved" });
    for (const merge of merges) if (!/^[A-Z]+\d+:[A-Z]+\d+$/i.test(merge)) errors.push({ code: "invalid_merge", sheet: worksheet.name, merge, message: `Invalid merge range: ${merge}` });
    const rows = [];
    worksheet.eachRow({ includeEmpty: false }, (row, number) => {
      const cells = [];
      row.eachCell({ includeEmpty: false }, (cell) => {
        cells.push({ address: cell.address, styleId: cell.styleId ?? null, numberFormat: cell.numFmt || null, font: cell.font ? { name: cell.font.name || null, size: cell.font.size || null, bold: !!cell.font.bold, italic: !!cell.font.italic } : null, alignment: cell.alignment || null });
      });
      if (cells.length) rows.push({ number, cells });
    });
    const columns = [];
    worksheet.columns.forEach((column, index) => {
      if (column.width !== undefined || column.hidden || column.outlineLevel) columns.push({ number: index + 1, width: column.width ?? null, hidden: !!column.hidden, outlineLevel: column.outlineLevel ?? 0 });
    });
    sheets.push({ name: worksheet.name, state: worksheet.state, merges, views: worksheet.views ?? [], rows, columns, conditionalFormats: Object.keys(worksheet.conditionalFormattings ?? {}).length, dataValidations: Object.keys(worksheet.dataValidations?.model?.dataValidation ?? {}).length });
  }
  return { ok: errors.length === 0, checker: "xlsx.layout", input, sheets, errors, warnings };
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(usage); process.exit(0); }
  const report = await check(options);
  if (options.json) console.log(JSON.stringify(report)); else console.log(`${report.ok ? "ok" : "failed"}: ${report.sheets.length} sheets checked`);
  process.exitCode = report.ok ? 0 : 1;
} catch (error) {
  const report = { ok: false, checker: "xlsx.layout", errors: [{ code: "input_error", message: error.message }], warnings: [] };
  if (options?.json) console.log(JSON.stringify(report)); else console.error(error.message);
  process.exitCode = 2;
}
