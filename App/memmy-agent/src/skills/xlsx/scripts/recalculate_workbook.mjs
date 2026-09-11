#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import ExcelJS from "exceljs";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONVERT_SCRIPT = path.join(SCRIPT_DIR, "office/office_convert.mjs");
const usage = `Usage: recalculate_workbook.mjs --input <workbook> --output <workbook> [--timeout-seconds <n>] [--json]
       recalculate_workbook.mjs <input> [timeout_seconds]`;

function parseArgs(argv) {
  const result = { input: null, output: null, timeout: 120, json: false, allowLossy: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--json") result.json = true;
    else if (arg === "--allow-lossy") result.allowLossy = true;
    else if (arg === "--input" || arg === "-i") result.input = argv[++i];
    else if (arg === "--output" || arg === "-o") result.output = argv[++i];
    else if (arg === "--timeout-seconds") result.timeout = Number(argv[++i]);
    else if (!arg.startsWith("-") && !result.input) result.input = arg;
    else if (!arg.startsWith("-") && result.timeout === 120) result.timeout = Number(arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!result.input) throw new Error("Missing input");
  if (!Number.isFinite(result.timeout) || result.timeout <= 0) throw new Error("timeout-seconds must be positive");
  return result;
}

function run(command, timeout) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { shell: false, windowsHide: true, env: process.env });
    let stdout = ""; let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Command timed out: ${command[0]}`)); }, timeout * 1000);
    child.stdout?.on("data", (chunk) => { stdout += chunk; }); child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(timer); if (code !== 0) reject(new Error(`Command failed (${code ?? signal}): ${stderr.trim()}`)); else resolve({ stdout, stderr }); });
  });
}

function formulaError(value) {
  const cached = value && typeof value === "object" && "formula" in value ? value.result : value;
  return typeof cached === "string" && /^#(?:REF!|DIV\/0!|VALUE!|NAME\?|N\/A|NUM!|NULL!)/i.test(cached) ? cached : null;
}

async function scan(file) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await fs.readFile(file), { ignoreNodes: [] });
  const formulas = []; const errors = new Map();
  for (const worksheet of workbook.worksheets) worksheet.eachRow({ includeEmpty: false }, (row) => row.eachCell({ includeEmpty: false }, (cell) => {
    const value = cell.value;
    const formula = value && typeof value === "object" && "formula" in value ? String(value.formula) : cell.type === 6 ? String(value ?? "") : null;
    if (!formula) return;
    const error = formulaError(value);
    const record = { sheet: worksheet.name, cell: cell.address, formula, value: value?.result ?? null, error };
    formulas.push(record);
    if (error) {
      if (!errors.has(error)) errors.set(error, []);
      if (errors.get(error).length < 100) errors.get(error).push({ sheet: worksheet.name, cell: cell.address });
    }
  }));
  const errorTypes = Object.fromEntries([...errors.entries()].map(([type, locations]) => [type, locations]));
  const locationsTruncated = [...errors.entries()].reduce((count, [type, locations]) => count + (formulas.filter((record) => record.error === type).length - locations.length), 0);
  return { formulas, errorTypes, locationsTruncated };
}

async function recalculate(options) {
  const input = path.resolve(options.input);
  const original = await fs.readFile(input).catch(() => null);
  if (!original) throw new Error(`Input does not exist: ${input}`);
  const extension = path.extname(input).toLowerCase();
  if (![".xlsx", ".xlsm", ".xltx"].includes(extension)) throw new Error("Recalculation requires an OOXML workbook");
  const output = path.resolve(options.output || path.join(path.dirname(input), `${path.basename(input, extension)}.recalculated${extension}`));
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "memmy-xlsx-recalc-"));
  const recalculated = path.join(temporary, `${path.basename(input, extension)}${extension}`);
  try {
    const converted = await run([process.execPath, CONVERT_SCRIPT, "--input", input, "--output", recalculated, "--format", extension.slice(1), "--timeout-seconds", String(options.timeout)], options.timeout + 15);
    const officeReport = JSON.parse(converted.stdout.trim());
    const scanned = await scan(recalculated);
    await fs.mkdir(path.dirname(output), { recursive: true });
    const temporaryOutput = `${output}.tmp-${process.pid}`;
    await fs.copyFile(recalculated, temporaryOutput);
    await fs.rename(temporaryOutput, output);
    const totalErrors = Object.values(scanned.errorTypes).reduce((sum, locations) => sum + locations.length, 0) + scanned.locationsTruncated;
    return { ok: totalErrors === 0, checker: "xlsx.recalculate", input, output, status: totalErrors === 0 ? "ok" : "errors_found", total_formulas: scanned.formulas.length, total_errors: totalErrors, errors: scanned.errorTypes, locations_truncated: scanned.locationsTruncated, office: officeReport };
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(usage); process.exit(0); }
  const report = await recalculate(options);
  console.log(JSON.stringify(report));
  process.exitCode = report.ok ? 0 : 3;
} catch (error) {
  if (options?.json) console.log(JSON.stringify({ ok: false, checker: "xlsx.recalculate", errors: [{ code: error.message.includes("timed out") ? "timeout" : "process_failure", message: error.message }] }));
  else console.error(error.message);
  process.exitCode = error.message.includes("timed out") ? 124 : 1;
}
