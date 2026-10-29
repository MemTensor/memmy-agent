#!/usr/bin/env node
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = path.resolve(SCRIPT_DIR, "../../../../extra-dependencies/office-rendering");
const DIST_ROOT = path.resolve(SCRIPT_DIR, "../../../../dist/extra-dependencies/office-rendering");
const usage = `Usage: render_with_office.mjs --input <deck> --output-dir <dir> [--convert-to pdf|pptx|png] [--timeout-seconds <n>] [--headless]
       render_with_office.mjs --headless --convert-to pdf <deck>`;

function parseArgs(argv) {
  const result = { input: null, outputDir: null, convertTo: "pdf", timeout: 120, headless: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--headless") result.headless = true;
    else if (arg === "--json") result.json = true;
    else if (arg === "--input" || arg === "-i") result.input = argv[++i];
    else if (arg === "--output-dir" || arg === "-o") result.outputDir = argv[++i];
    else if (arg === "--convert-to") result.convertTo = String(argv[++i] || "").toLowerCase();
    else if (arg === "--timeout-seconds") result.timeout = Number(argv[++i]);
    else if (!arg.startsWith("-") && !result.input) result.input = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!result.input) throw new Error("Missing input");
  if (!Number.isFinite(result.timeout) || result.timeout <= 0) throw new Error("timeout-seconds must be positive");
  if (!["pdf", "pptx", "png"].includes(result.convertTo)) throw new Error("convert-to must be pdf, pptx, or png");
  return result;
}

function platformKey() {
  return `${process.platform}-${process.arch}`;
}

function unpackedRoot(root) {
  const marker = `${path.sep}app.asar${path.sep}`;
  const index = root.indexOf(marker);
  return index < 0 ? null : `${root.slice(0, index)}${path.sep}app.asar.unpacked${root.slice(index + marker.length - 1)}`;
}

async function validRoot(directory, key) {
  const manifestPath = path.join(directory, "OFFICE-RENDERING-MANIFEST.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (`${manifest.platform}-${manifest.arch}` !== key) throw new Error(`Office rendering manifest target mismatch: ${manifestPath}`);
  const names = process.platform === "win32" ? ["bin/soffice.exe", "bin/pdfinfo.exe", "bin/pdftoppm.exe"] : ["bin/soffice", "bin/pdfinfo", "bin/pdftoppm"];
  if (JSON.stringify(manifest.binaries) !== JSON.stringify(names)) throw new Error(`Office rendering manifest binary list mismatch: ${manifestPath}`);
  const binaries = Object.fromEntries(names.map((name) => [path.basename(name, path.extname(name)), path.join(directory, name)]));
  for (const file of Object.values(binaries)) {
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) throw new Error(`Missing Office rendering binary: ${file}`);
  }
  return { directory, manifestPath, soffice: binaries.soffice, pdfinfo: binaries.pdfinfo, pdftoppm: binaries.pdftoppm };
}

async function resolveRenderer() {
  const roots = [];
  for (const name of ["MEMMY_OFFICE_RENDERING_ROOT", "MEMMY_DOCX_RENDERING_ROOT"]) {
    const value = process.env[name]?.trim();
    if (value) roots.push(path.resolve(value));
  }
  roots.push(DIST_ROOT, SOURCE_ROOT);
  for (const root of [...roots]) {
    const unpacked = unpackedRoot(root);
    if (unpacked) roots.push(unpacked);
  }
  const attempted = [];
  for (const root of roots) {
    const directory = path.join(root, platformKey());
    attempted.push(directory);
    try {
      return await validRoot(directory, platformKey());
    } catch {
      // Continue through explicitly ordered bundled roots. PATH is not a fallback.
    }
  }
  throw new Error(`Office renderer bundle is unavailable for platform=${process.platform} arch=${process.arch}. Tried: ${attempted.join(", ")}`);
}

function run(command, options, timeout) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { ...options, shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Command timed out: ${command[0]}`));
    }, timeout * 1000);
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`Command failed (${code ?? signal}): ${command[0]}${stderr ? `: ${stderr.trim()}` : ""}`));
      else resolve({ stdout, stderr });
    });
  });
}

async function render(options) {
  const input = path.resolve(options.input);
  if (!existsSync(input)) throw new Error(`Input does not exist: ${input}`);
  const renderer = await resolveRenderer();
  const outputDir = path.resolve(options.outputDir || path.dirname(input));
  await fs.mkdir(outputDir, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "memmy-pptx-office-"));
  const profile = path.join(temporary, "profile");
  const destination = path.join(temporary, "converted");
  await fs.mkdir(destination, { recursive: true });
  const extension = options.convertTo === "png" ? "pdf" : options.convertTo;
  const outputName = `${path.basename(input, path.extname(input))}.${extension}`;
  const output = path.join(outputDir, outputName);
  const profileArg = `-env:UserInstallation=${pathToFileURL(profile).href}`;
  const command = [renderer.soffice, profileArg, "--invisible", "--headless", "--norestore", "--convert-to", extension, "--outdir", destination, input];
  try {
    await run(command, { env: { ...process.env, HOME: temporary, XDG_CONFIG_HOME: path.join(temporary, "config"), XDG_CACHE_HOME: path.join(temporary, "cache") } }, options.timeout);
    const produced = path.join(destination, outputName);
    if (!(await fs.stat(produced).catch(() => null))?.isFile()) throw new Error(`Office did not create ${outputName}`);
    await fs.rm(output, { force: true });
    if (options.convertTo === "png") {
      const prefix = path.join(destination, "page");
      await run([renderer.pdftoppm, "-png", produced, prefix], { env: process.env }, options.timeout);
      const pages = (await fs.readdir(destination)).filter((name) => name.startsWith("page-") && name.endsWith(".png")).sort();
      const outputs = [];
      for (const page of pages) {
        const target = path.join(outputDir, `${path.basename(input, path.extname(input))}-${page}`);
        await fs.copyFile(path.join(destination, page), target);
        outputs.push(target);
      }
      return { ok: true, format: "png", outputs: outputs.map((file) => path.resolve(file)), renderer: renderer.manifestPath };
    }
    await fs.rename(produced, output);
    return { ok: true, format: options.convertTo, output: path.resolve(output), renderer: renderer.manifestPath };
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage);
    process.exit(0);
  }
  console.log(JSON.stringify(await render(options)));
} catch (error) {
  if (options?.json) console.log(JSON.stringify({ ok: false, checker: "pptx.render", errors: [{ code: error.message.includes("timed out") ? "timeout" : "render_failure", message: error.message }] }));
  else console.error(error.message);
  process.exitCode = error.message.includes("timed out") ? 124 : 1;
}
