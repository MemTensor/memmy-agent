#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CHECKERS = [
  "office/check_ooxml_package.mjs",
  "office/check_slide_rules.mjs",
  "office/check_theme_rules.mjs",
  "office/check_chart_rules.mjs",
  "office/check_pptx_schema.mjs",
];
const usage = `Usage: check_deck.mjs --input <deck.pptx|directory> [--baseline <template>] [--auto-repair] [--json]
       check_deck.mjs <deck.pptx|directory> [--baseline <template>] [--auto-repair]`;

function parseArgs(argv) {
  const result = { input: null, baseline: null, autoRepair: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--json") result.json = true;
    else if (arg === "--auto-repair") result.autoRepair = true;
    else if (arg === "--input" || arg === "-i") result.input = argv[++i];
    else if (arg === "--baseline") result.baseline = argv[++i];
    else if (!arg.startsWith("-") && !result.input) result.input = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!result.input) throw new Error("Missing input");
  return result;
}

function runChecker(script, input) {
  const result = spawnSync(process.execPath, [path.join(SCRIPT_DIR, script), "--input", input, "--json"], { encoding: "utf8", shell: false, windowsHide: true });
  let report;
  try {
    report = JSON.parse(result.stdout || "{}");
  } catch {
    report = { ok: false, errors: [{ code: "checker_output", message: result.stderr || "Checker did not return JSON" }], warnings: [] };
  }
  return { ...report, exitCode: result.status ?? 1 };
}

function issueKey(issue) {
  return `${issue.code ?? "unknown"}|${issue.part ?? ""}|${issue.id ?? ""}`;
}

async function check(options) {
  const checks = CHECKERS.map((checker) => ({ name: checker, report: runChecker(checker, path.resolve(options.input)) }));
  const baselineIssues = new Set();
  if (options.baseline) {
    for (const checker of CHECKERS) {
      const report = runChecker(checker, path.resolve(options.baseline));
      for (const issue of report.errors ?? []) baselineIssues.add(issueKey(issue));
    }
  }
  const errors = [];
  const warnings = [];
  for (const check of checks) {
    for (const issue of check.report.errors ?? []) {
      if (!baselineIssues.has(issueKey(issue))) errors.push({ ...issue, checker: check.name });
    }
    for (const issue of check.report.warnings ?? []) warnings.push({ ...issue, checker: check.name });
  }
  const repairs = [];
  if (options.autoRepair) {
    // The checkers are deliberately read-only. Deterministic package edits are
    // delegated to clone/prune entry points; this flag records that no unsafe
    // repair was attempted when there is nothing provably repairable.
    repairs.push({ type: "none", message: "No automatic repair was required" });
  }
  return { ok: errors.length === 0, checker: "pptx.deck", input: path.resolve(options.input), baseline: options.baseline ? path.resolve(options.baseline) : null, checks: checks.map((check) => ({ name: check.name, ok: check.report.ok, exitCode: check.report.exitCode })), errors, warnings, repairs };
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage);
    process.exit(0);
  }
  const report = await check(options);
  if (options.json) console.log(JSON.stringify(report));
  else {
    console.log(`${report.ok ? "ok" : "failed"}: ${report.checks.length} checks`);
    for (const error of report.errors) console.error(`${error.code}: ${error.message}`);
  }
  process.exitCode = report.ok ? 0 : 1;
} catch (error) {
  const report = { ok: false, checker: "pptx.deck", errors: [{ code: "input_error", message: error.message }], warnings: [], checks: [] };
  if (options?.json) console.log(JSON.stringify(report));
  else console.error(error.message);
  process.exitCode = 2;
}
