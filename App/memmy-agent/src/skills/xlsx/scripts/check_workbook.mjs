#!/usr/bin/env node
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CHECKERS = [
  "office/check_ooxml_package.mjs",
  "check_formula_rules.mjs",
  "check_layout_rules.mjs",
  "check_drawing_rules.mjs",
];
const usage = `Usage: check_workbook.mjs --input <workbook.xlsx|xlsm|xltx|directory> [--allow-lossy] [--json]
       check_workbook.mjs <workbook>`;

function parseArgs(argv) {
  const result = { input: null, allowLossy: false, json: false };
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

function runChecker(script, input, allowLossy) {
  const args = [path.join(SCRIPT_DIR, script), "--input", input, "--json"];
  if (allowLossy && script === "check_formula_rules.mjs") args.push("--allow-lossy");
  const result = spawnSync(process.execPath, args, { encoding: "utf8", shell: false, windowsHide: true });
  try { return { ...JSON.parse(result.stdout || "{}"), exitCode: result.status ?? 1 }; }
  catch { return { ok: false, errors: [{ code: "checker_output", message: result.stderr || "Checker did not return JSON" }], warnings: [], exitCode: result.status ?? 1 }; }
}

async function check(options) {
  const input = path.resolve(options.input);
  const checks = CHECKERS.map((checker) => ({ name: checker, report: runChecker(checker, input, options.allowLossy) }));
  const errors = [];
  const warnings = [];
  for (const check of checks) {
    for (const issue of check.report.errors ?? []) errors.push({ ...issue, checker: check.name });
    for (const issue of check.report.warnings ?? []) warnings.push({ ...issue, checker: check.name });
  }
  return { ok: errors.length === 0, checker: "xlsx.workbook", input, allowLossy: options.allowLossy, checks: checks.map((check) => ({ name: check.name, ok: check.report.ok, exitCode: check.report.exitCode })), errors, warnings };
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(usage); process.exit(0); }
  const report = await check(options);
  if (options.json) console.log(JSON.stringify(report)); else console.log(`${report.ok ? "ok" : "failed"}: ${report.checks.length} checks`);
  process.exitCode = report.ok ? 0 : 1;
} catch (error) {
  const report = { ok: false, checker: "xlsx.workbook", errors: [{ code: "input_error", message: error.message }], warnings: [] };
  if (options?.json) console.log(JSON.stringify(report)); else console.error(error.message);
  process.exitCode = 2;
}
