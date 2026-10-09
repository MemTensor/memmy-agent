#!/usr/bin/env node
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONVERT_SCRIPT = path.join(SCRIPT_DIR, "office/office_convert.mjs");
const SOURCE_ROOT = path.resolve(SCRIPT_DIR, "../../../../extra-dependencies/office-rendering");
const DIST_ROOT = path.resolve(SCRIPT_DIR, "../../../../dist/extra-dependencies/office-rendering");
const usage = `Usage: render_with_office.mjs --input <workbook> [--output-dir <dir>] [--format pdf|png] [--timeout-seconds <n>]
       render_with_office.mjs <workbook> [--output-dir <dir>]`;

function parseArgs(argv) {
  const result = { input: null, outputDir: null, format: "pdf", timeout: 120, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    else if (arg === "--json") result.json = true;
    else if (arg === "--input" || arg === "-i") result.input = argv[++i];
    else if (arg === "--output-dir" || arg === "-o") result.outputDir = argv[++i];
    else if (arg === "--format") result.format = String(argv[++i] || "").toLowerCase();
    else if (arg === "--timeout-seconds") result.timeout = Number(argv[++i]);
    else if (!arg.startsWith("-") && !result.input) result.input = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!result.input) throw new Error("Missing input");
  if (!["pdf", "png"].includes(result.format)) throw new Error("format must be pdf or png");
  if (!Number.isFinite(result.timeout) || result.timeout <= 0) throw new Error("timeout-seconds must be positive");
  return result;
}

function run(command, options, timeout) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { ...options, shell: false, windowsHide: true });
    let stdout = ""; let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Command timed out: ${command[0]}`)); }, timeout * 1000);
    child.stdout?.on("data", (chunk) => { stdout += chunk; }); child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(timer); if (code !== 0) reject(new Error(`Command failed (${code ?? signal}): ${stderr.trim()}`)); else resolve({ stdout, stderr }); });
  });
}

function unpackedRoot(root) {
  const marker = `${path.sep}app.asar${path.sep}`; const index = root.indexOf(marker);
  return index < 0 ? null : `${root.slice(0, index)}${path.sep}app.asar.unpacked${root.slice(index + marker.length - 1)}`;
}

async function resolvePoppler() {
  const roots = [];
  for (const name of ["MEMMY_OFFICE_RENDERING_ROOT", "MEMMY_DOCX_RENDERING_ROOT"]) if (process.env[name]?.trim()) roots.push(path.resolve(process.env[name].trim()));
  roots.push(DIST_ROOT, SOURCE_ROOT);
  for (const root of [...roots]) { const unpacked = unpackedRoot(root); if (unpacked) roots.push(unpacked); }
  const key = `${process.platform}-${process.arch}`;
  const binary = process.platform === "win32" ? "pdftoppm.exe" : "pdftoppm";
  for (const root of roots) {
    const directory = path.join(root, key); const manifest = path.join(directory, "OFFICE-RENDERING-MANIFEST.json");
    if (!(await fs.stat(manifest).catch(() => null))?.isFile()) continue;
    const pdftoppm = path.join(directory, "bin", binary);
    if ((await fs.stat(pdftoppm).catch(() => null))?.isFile()) return { pdftoppm, manifest };
  }
  throw new Error(`Office renderer bundle is unavailable for platform=${process.platform} arch=${process.arch}`);
}

async function render(options) {
  const input = path.resolve(options.input);
  if (!existsSync(input)) throw new Error(`Input does not exist: ${input}`);
  const outputDir = path.resolve(options.outputDir || path.dirname(input));
  await fs.mkdir(outputDir, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "memmy-xlsx-render-"));
  try {
    const pdf = path.join(temporary, `${path.basename(input, path.extname(input))}.pdf`);
    const converted = await run([process.execPath, CONVERT_SCRIPT, "--input", input, "--output", pdf, "--format", "pdf", "--timeout-seconds", String(options.timeout)], { env: process.env }, options.timeout + 10);
    const report = JSON.parse(converted.stdout.trim());
    if (options.format === "pdf") {
      const output = path.join(outputDir, path.basename(pdf));
      await fs.copyFile(pdf, output);
      return { ok: true, format: "pdf", output: path.resolve(output), renderer: report.renderer };
    }
    const renderer = await resolvePoppler();
    const prefix = path.join(temporary, "sheet");
    await run([renderer.pdftoppm, "-png", pdf, prefix], { env: process.env }, options.timeout);
    const pages = (await fs.readdir(temporary)).filter((name) => /^sheet-\d+\.png$/i.test(name)).sort();
    if (pages.length === 0) throw new Error("Poppler did not produce PNG pages");
    const outputs = [];
    for (const page of pages) { const target = path.join(outputDir, `${path.basename(input, path.extname(input))}-${page}`); await fs.copyFile(path.join(temporary, page), target); outputs.push(path.resolve(target)); }
    return { ok: true, format: "png", pages: outputs.length, outputs, renderer: renderer.manifest };
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(usage); process.exit(0); }
  console.log(JSON.stringify(await render(options)));
} catch (error) {
  if (options?.json) console.log(JSON.stringify({ ok: false, checker: "xlsx.render", errors: [{ code: error.message.includes("timed out") ? "timeout" : "render_failure", message: error.message }] }));
  else console.error(error.message);
  process.exitCode = error.message.includes("timed out") ? 124 : 1;
}
