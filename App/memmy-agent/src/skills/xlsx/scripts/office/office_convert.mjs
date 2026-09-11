#!/usr/bin/env node
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = path.resolve(SCRIPT_DIR, "../../../../../extra-dependencies/office-rendering");
const DIST_ROOT = path.resolve(SCRIPT_DIR, "../../../../../dist/extra-dependencies/office-rendering");
const usage = `Usage: office_convert.mjs --input <file> --output <file> [--format xlsx|xlsm|xltx|pdf] [--timeout-seconds <n>]
       office_convert.mjs <input> <output>`;

function parseArgs(argv) {
  const result = { input: null, output: null, format: null, timeout: 120, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    else if (arg === "--json") result.json = true;
    else if (arg === "--input" || arg === "-i") result.input = argv[++i];
    else if (arg === "--output" || arg === "-o") result.output = argv[++i];
    else if (arg === "--format") result.format = String(argv[++i] || "").toLowerCase();
    else if (arg === "--timeout-seconds") result.timeout = Number(argv[++i]);
    else if (!arg.startsWith("-") && !result.input) result.input = arg;
    else if (!arg.startsWith("-") && !result.output) result.output = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!result.input || !result.output) throw new Error("Input and output are required");
  if (!Number.isFinite(result.timeout) || result.timeout <= 0) throw new Error("timeout-seconds must be positive");
  result.format ??= path.extname(result.output).slice(1).toLowerCase();
  if (!["xlsx", "xlsm", "xltx", "pdf"].includes(result.format)) throw new Error(`Unsupported output format: ${result.format}`);
  return result;
}

function asarUnpacked(root) {
  const marker = `${path.sep}app.asar${path.sep}`;
  const index = root.indexOf(marker);
  return index < 0 ? null : `${root.slice(0, index)}${path.sep}app.asar.unpacked${root.slice(index + marker.length - 1)}`;
}

async function resolveRenderer() {
  const roots = [];
  for (const name of ["MEMMY_OFFICE_RENDERING_ROOT", "MEMMY_DOCX_RENDERING_ROOT"]) if (process.env[name]?.trim()) roots.push(path.resolve(process.env[name].trim()));
  roots.push(DIST_ROOT, SOURCE_ROOT);
  for (const root of [...roots]) { const unpacked = asarUnpacked(root); if (unpacked) roots.push(unpacked); }
  const key = `${process.platform}-${process.arch}`;
  const names = process.platform === "win32" ? { soffice: "soffice.exe" } : { soffice: "soffice" };
  const tried = [];
  for (const root of roots) {
    const directory = path.join(root, key);
    const manifest = path.join(directory, "OFFICE-RENDERING-MANIFEST.json");
    tried.push(directory);
    if (!(await fs.stat(manifest).catch(() => null))?.isFile()) continue;
    const value = path.join(directory, "bin", names.soffice);
    if ((await fs.stat(value).catch(() => null))?.isFile()) return { soffice: value, manifest };
  }
  throw new Error(`Office renderer bundle is unavailable for platform=${process.platform} arch=${process.arch}. Tried: ${tried.join(", ")}`);
}

function run(command, options, timeout) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { ...options, shell: false, windowsHide: true });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Command timed out: ${command[0]}`)); }, timeout * 1000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(timer); if (code !== 0) reject(new Error(`Command failed (${code ?? signal}): ${stderr.trim()}`)); else resolve(); });
  });
}

async function convert(options) {
  const input = path.resolve(options.input);
  if (!existsSync(input)) throw new Error(`Input does not exist: ${input}`);
  const output = path.resolve(options.output);
  const renderer = await resolveRenderer();
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "memmy-xlsx-convert-"));
  const profile = path.join(temporary, "profile");
  const profileArg = `-env:UserInstallation=${pathToFileURL(profile).href}`;
  try {
    await run([renderer.soffice, profileArg, "--invisible", "--headless", "--norestore", "--convert-to", options.format, "--outdir", temporary, input], { env: { ...process.env, HOME: temporary, XDG_CONFIG_HOME: path.join(temporary, "config"), XDG_CACHE_HOME: path.join(temporary, "cache") } }, options.timeout);
    const generated = path.join(temporary, `${path.basename(input, path.extname(input))}.${options.format}`);
    if (!(await fs.stat(generated).catch(() => null))?.isFile()) throw new Error(`Office did not create ${path.basename(generated)}`);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.rm(output, { force: true });
    await fs.rename(generated, output);
    return { ok: true, input, output, format: options.format, renderer: renderer.manifest };
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(usage); process.exit(0); }
  console.log(JSON.stringify(await convert(options)));
} catch (error) {
  if (options?.json) console.log(JSON.stringify({ ok: false, checker: "xlsx.office_convert", errors: [{ code: error.message.includes("timed out") ? "timeout" : "convert_failure", message: error.message }] }));
  else console.error(error.message);
  process.exitCode = error.message.includes("timed out") ? 124 : 1;
}
