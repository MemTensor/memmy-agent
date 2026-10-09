#!/usr/bin/env node
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { PNG } from "pngjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RENDER_SCRIPT = path.join(SCRIPT_DIR, "render_with_office.mjs");
const SOURCE_ROOT = path.resolve(SCRIPT_DIR, "../../../../extra-dependencies/office-rendering");
const DIST_ROOT = path.resolve(SCRIPT_DIR, "../../../../dist/extra-dependencies/office-rendering");
const usage = `Usage: make_contact_sheet.mjs --input <deck.pptx|potx> [--output-dir <dir>] [--prefix <name>]
       make_contact_sheet.mjs <deck> [prefix]`;

function parseArgs(argv) {
  const result = { input: null, outputDir: null, prefix: "thumbnails", json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    else if (arg === "--json") result.json = true;
    else if (arg === "--input" || arg === "-i") result.input = argv[++i];
    else if (arg === "--output-dir" || arg === "-o") result.outputDir = argv[++i];
    else if (arg === "--prefix") result.prefix = argv[++i];
    else if (!arg.startsWith("-") && !result.input) result.input = arg;
    else if (!arg.startsWith("-") && result.prefix === "thumbnails") result.prefix = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!result.input) throw new Error("Missing input");
  if (!result.prefix || /[\\/]/.test(result.prefix)) throw new Error("prefix must be a simple file prefix");
  return result;
}

function run(command, options, timeout = 180000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { ...options, shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Command timed out: ${command[0]}`));
    }, timeout);
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`Command failed (${code}): ${stderr.trim() || command[0]}`));
      else resolve({ stdout, stderr });
    });
  });
}

function unpackedRoot(root) {
  const marker = `${path.sep}app.asar${path.sep}`;
  const index = root.indexOf(marker);
  return index < 0 ? null : `${root.slice(0, index)}${path.sep}app.asar.unpacked${root.slice(index + marker.length - 1)}`;
}

async function renderer() {
  const roots = [];
  for (const name of ["MEMMY_OFFICE_RENDERING_ROOT", "MEMMY_DOCX_RENDERING_ROOT"]) if (process.env[name]?.trim()) roots.push(path.resolve(process.env[name].trim()));
  roots.push(DIST_ROOT, SOURCE_ROOT);
  for (const root of [...roots]) {
    const unpacked = unpackedRoot(root);
    if (unpacked) roots.push(unpacked);
  }
  const key = `${process.platform}-${process.arch}`;
  const names = process.platform === "win32" ? { soffice: "soffice.exe", pdftoppm: "pdftoppm.exe" } : { soffice: "soffice", pdftoppm: "pdftoppm" };
  for (const root of roots) {
    const directory = path.join(root, key);
    const manifest = path.join(directory, "OFFICE-RENDERING-MANIFEST.json");
    const valid = await fs.stat(manifest).catch(() => null);
    if (!valid?.isFile()) continue;
    const soffice = path.join(directory, "bin", names.soffice);
    const pdftoppm = path.join(directory, "bin", names.pdftoppm);
    if ((await fs.stat(soffice).catch(() => null))?.isFile() && (await fs.stat(pdftoppm).catch(() => null))?.isFile()) return { pdftoppm, manifest };
  }
  throw new Error(`Office renderer bundle is unavailable for platform=${process.platform} arch=${process.arch}`);
}

async function deckHiddenPages(input) {
  try {
    const zip = await JSZip.loadAsync(await fs.readFile(input), { checkCRC32: true });
    const values = [];
    for (const [name, entry] of Object.entries(zip.files)) if (/^ppt\/slides\/slide\d+\.xml$/i.test(name) && !entry.dir) values.push({ number: Number(name.match(/\d+/)?.[0] ?? 0), hidden: /\bshow=["'](?:0|false)["']/i.test(await entry.async("string")) });
    return values.sort((a, b) => a.number - b.number).map((entry) => entry.hidden);
  } catch {
    return [];
  }
}

function resize(source, width, height) {
  const target = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    const sy = ((y + 0.5) * source.height) / height - 0.5;
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(source.height - 1, y0 + 1);
    const fy = Math.max(0, sy - y0);
    for (let x = 0; x < width; x += 1) {
      const sx = ((x + 0.5) * source.width) / width - 0.5;
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(source.width - 1, x0 + 1);
      const fx = Math.max(0, sx - x0);
      const destination = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        const a = source.data[(y0 * source.width + x0) * 4 + channel] * (1 - fx) + source.data[(y0 * source.width + x1) * 4 + channel] * fx;
        const b = source.data[(y1 * source.width + x0) * 4 + channel] * (1 - fx) + source.data[(y1 * source.width + x1) * 4 + channel] * fx;
        target.data[destination + channel] = Math.round(a * (1 - fy) + b * fy);
      }
    }
  }
  return target;
}

async function make(options) {
  const input = path.resolve(options.input);
  if (!existsSync(input)) throw new Error(`Input does not exist: ${input}`);
  const outputDir = path.resolve(options.outputDir || path.dirname(input));
  await fs.mkdir(outputDir, { recursive: true });
  for (const name of await fs.readdir(outputDir)) if (name.startsWith(`${options.prefix}-`) && name.endsWith(".png")) await fs.rm(path.join(outputDir, name), { force: true });
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "memmy-pptx-sheet-"));
  try {
    const render = await run([process.execPath, RENDER_SCRIPT, "--input", input, "--output-dir", temporary, "--convert-to", "pdf", "--headless"], { env: process.env });
    const rendered = JSON.parse(render.stdout.trim());
    const pdf = rendered.output;
    const tools = await renderer();
    const prefix = path.join(temporary, "page");
    await run(tools.pdftoppm ? [tools.pdftoppm, "-png", pdf, prefix] : [], { env: process.env });
    const pages = (await fs.readdir(temporary)).filter((name) => /^page-\d+\.png$/i.test(name)).sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]));
    if (pages.length === 0) throw new Error("Poppler did not produce page PNGs");
    const hidden = await deckHiddenPages(input);
    const outputs = [];
    const thumbWidth = 320;
    const thumbHeight = 180;
    const gap = 16;
    const cols = 4;
    const rows = 3;
    for (let offset = 0; offset < pages.length; offset += cols * rows) {
      const chunk = pages.slice(offset, offset + cols * rows);
      const sheet = new PNG({ width: cols * thumbWidth + (cols + 1) * gap, height: rows * thumbHeight + (rows + 1) * gap });
      sheet.data.fill(245);
      for (let i = 0; i < chunk.length; i += 1) {
        const thumbnail = resize(PNG.sync.read(await fs.readFile(path.join(temporary, chunk[i]))), thumbWidth, thumbHeight);
        const x = gap + (i % cols) * (thumbWidth + gap);
        const y = gap + Math.floor(i / cols) * (thumbHeight + gap);
        PNG.bitblt(thumbnail, sheet, 0, 0, thumbWidth, thumbHeight, x, y);
        if (hidden[offset + i]) for (let px = x; px < x + thumbWidth; px += 1) for (let py = y; py < Math.min(y + 5, sheet.height); py += 1) {
          const index = (py * sheet.width + px) * 4;
          sheet.data[index] = 220; sheet.data[index + 1] = 60; sheet.data[index + 2] = 60; sheet.data[index + 3] = 255;
        }
      }
      const destination = path.join(outputDir, `${options.prefix}-${String(offset / (cols * rows) + 1).padStart(2, "0")}.png`);
      await fs.writeFile(destination, PNG.sync.write(sheet));
      outputs.push(destination);
    }
    return { ok: true, pages: pages.length, outputs: outputs.map((file) => path.resolve(file)), renderer: tools.manifest };
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
  console.log(JSON.stringify(await make(options)));
} catch (error) {
  if (options?.json) console.log(JSON.stringify({ ok: false, checker: "pptx.contact_sheet", errors: [{ code: error.message.includes("timed out") ? "timeout" : "render_failure", message: error.message }] }));
  else console.error(error.message);
  process.exitCode = error.message.includes("timed out") ? 124 : 1;
}
