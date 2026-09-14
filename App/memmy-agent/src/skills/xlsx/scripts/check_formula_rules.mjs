#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";

const usage = `Usage: check_formula_rules.mjs --input <workbook.xlsx|xlsm|xltx> [--json] [--allow-lossy]
       check_formula_rules.mjs <workbook>`;
const dynamicFunctions = /\b(?:XLOOKUP|XMATCH|SORT|FILTER|UNIQUE|SEQUENCE|RANDARRAY|LET|LAMBDA)\s*\(/i;
const stableFunctions = /\b(?:SUMIFS|INDEX|MATCH|IFERROR|SUMPRODUCT)\s*\(/i;

function parseArgs(argv) {
  const result = { input: null, json: false, allowLossy: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--json") result.json = true;
    else if (arg === "--allow-lossy") result.allowLossy = true;
    else if (arg === "--input" || arg === "-i") result.input = argv[++i];
    else if (!arg.startsWith("-") && !result.input) result.input = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!result.input) throw new Error("Missing input");
  return result;
}

function formulaOf(cell) {
  const value = cell.value;
  return value && typeof value === "object" && "formula" in value ? String(value.formula) : cell.type === 6 ? String(value ?? "") : null;
}

function errorOf(cell) {
  const value = cell.value;
  const cached = value && typeof value === "object" && "formula" in value ? value.result : value;
  return typeof cached === "string" && /^#(?:REF!|DIV\/0!|VALUE!|NAME\?|N\/A|NUM!|NULL!)/i.test(cached) ? cached : null;
}

async function check(options) {
  const input = path.resolve(options.input);
  const bytes = await fs.readFile(input).catch(() => null);
  if (!bytes) throw new Error(`Input does not exist: ${input}`);
  if (![".xlsx", ".xlsm", ".xltx"].includes(path.extname(input).toLowerCase())) throw new Error("Formula checker requires an OOXML workbook");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes, { ignoreNodes: [] });
  const errors = [];
  const warnings = [];
  const formulas = [];
  const formulaByAddress = new Map();
  for (const worksheet of workbook.worksheets) worksheet.eachRow({ includeEmpty: false }, (row) => row.eachCell({ includeEmpty: false }, (cell) => {
    const formula = formulaOf(cell);
    if (!formula) return;
    const record = { sheet: worksheet.name, cell: cell.address, formula, value: cell.value?.result ?? null, error: errorOf(cell), compatibility: "standard" };
    if (dynamicFunctions.test(formula)) { record.compatibility = "dynamic-array"; warnings.push({ code: "dynamic_array_function", ...record, message: "Dynamic-array function requires an engine capability check" }); }
    else if (stableFunctions.test(formula)) record.compatibility = "stable";
    if (/\[[^\]]+\]/.test(formula)) warnings.push({ code: "external_workbook_reference", ...record, message: "Formula references an external workbook" });
    if (record.error) errors.push({ code: "formula_error", sheet: worksheet.name, cell: cell.address, formula, error: record.error, message: `Formula cache contains ${record.error}` });
    formulas.push(record);
    formulaByAddress.set(`${worksheet.name}!${cell.address}`, formula);
  }));
  for (const record of formulas) {
    const selfReference = new RegExp(`(?:^|[^A-Z0-9_])${record.cell}(?:[^A-Z0-9_]|$)`, "i").test(record.formula.replace(/\$/g, ""));
    if (selfReference) errors.push({ code: "circular_reference", sheet: record.sheet, cell: record.cell, formula: record.formula, message: "Formula references itself" });
  }
  const externalLinks = [...workbook._externalLinks ?? []];
  if (externalLinks.length && !options.allowLossy) errors.push({ code: "external_links_present", message: "Workbook contains external links; pass --allow-lossy only when the caller accepts the risk" });
  return { ok: errors.length === 0, checker: "xlsx.formulas", input, status: errors.length === 0 ? "ok" : "errors_found", total_formulas: formulas.length, total_errors: errors.length, errors, warnings, formulas, errors_found: errors.length > 0, locations_truncated: 0, allowLossy: options.allowLossy };
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(usage); process.exit(0); }
  const report = await check(options);
  if (options.json) console.log(JSON.stringify(report));
  else console.log(`${report.ok ? "ok" : "failed"}: ${report.total_formulas} formulas, ${report.total_errors} errors`);
  process.exitCode = report.ok ? 0 : 1;
} catch (error) {
  const report = { ok: false, checker: "xlsx.formulas", errors: [{ code: "input_error", message: error.message }], warnings: [] };
  if (options?.json) console.log(JSON.stringify(report)); else console.error(error.message);
  process.exitCode = 2;
}
