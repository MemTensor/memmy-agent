#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";

const usage = `Usage: check_chart_rules.mjs --input <deck.pptx|directory> [--json]
       check_chart_rules.mjs <deck.pptx|directory> [--json]`;

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

function parseXml(bytes, name) {
  let issue = "";
  const doc = new DOMParser({ errorHandler: { warning() {}, error(message) { issue = message; }, fatalError(message) { issue = message; } } }).parseFromString(bytes.toString("utf8"), "application/xml");
  if (issue || !doc?.documentElement) throw new Error(`${name}: invalid XML`);
  return doc;
}

async function readFiles(input) {
  const stat = await fs.stat(input).catch(() => null);
  if (!stat) throw new Error(`Input does not exist: ${input}`);
  if (stat.isDirectory()) {
    const result = new Map();
    const visit = async (directory) => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(file);
        else result.set(path.relative(input, file).split(path.sep).join("/"), await fs.readFile(file));
      }
    };
    await visit(input);
    return result;
  }
  const zip = await JSZip.loadAsync(await fs.readFile(input), { checkCRC32: true });
  const result = new Map();
  for (const [name, entry] of Object.entries(zip.files)) if (!entry.dir) result.set(path.posix.normalize(name), await entry.async("nodebuffer"));
  return result;
}

function nodes(root, wanted) {
  const result = [];
  const visit = (node) => {
    for (let child = node?.firstChild; child; child = child.nextSibling) {
      if (child.nodeType !== 1) continue;
      const local = child.localName || child.nodeName.split(":").pop();
      if (local === wanted) result.push(child);
      visit(child);
    }
  };
  visit(root);
  return result;
}

async function check(input) {
  const files = await readFiles(input);
  const errors = [];
  const warnings = [];
  const chartNames = [...files.keys()].filter((name) => /^ppt\/charts\/chart\d+\.xml$/i.test(name)).sort();
  for (const name of chartNames) {
    try {
      const root = parseXml(files.get(name), name).documentElement;
      const axes = nodes(root, "axId");
      if (axes.length < 2) errors.push({ code: "chart_axes_missing", part: name, message: "A chart must declare both category and value axes" });
      const series = nodes(root, "ser");
      if (series.length === 0) errors.push({ code: "chart_series_missing", part: name, message: "Chart has no series" });
      const hasStacked = nodes(root, "grouping").some((node) => /stacked/i.test(node.getAttribute("val")));
      if (hasStacked) {
        const labels = nodes(root, "dLblPos");
        if (labels.some((node) => !["ctr", "inBase", "inEnd", "outEnd"].includes(node.getAttribute("val")))) errors.push({ code: "stacked_label_position", part: name, message: "Stacked chart has an unsupported data-label position" });
      }
      const chartType = [...root.childNodes].find((node) => node.nodeType === 1 && /Chart$/.test(node.localName || node.nodeName.split(":").pop()));
      if (!chartType) warnings.push({ code: "unknown_chart_type", part: name, message: "No recognized chart type element was found" });
    } catch (error) {
      errors.push({ code: "invalid_chart_xml", part: name, message: error.message });
    }
  }
  return { ok: errors.length === 0, checker: "pptx.chart", input: path.resolve(input), chartCount: chartNames.length, errors, warnings };
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage);
    process.exit(0);
  }
  const report = await check(options.input);
  if (options.json) console.log(JSON.stringify(report));
  else {
    console.log(`${report.ok ? "ok" : "failed"}: ${report.chartCount} charts`);
    for (const error of report.errors) console.error(`${error.code}: ${error.message}`);
  }
  process.exitCode = report.ok ? 0 : 1;
} catch (error) {
  const report = { ok: false, checker: "pptx.chart", errors: [{ code: "input_error", message: error.message }], warnings: [] };
  if (options?.json) console.log(JSON.stringify(report));
  else console.error(error.message);
  process.exitCode = 2;
}
