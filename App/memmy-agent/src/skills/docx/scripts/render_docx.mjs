#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const TWIPS_PER_INCH = 1440;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_RENDERING_ROOT = path.resolve(
  SCRIPT_DIR,
  "../../../../extra-dependencies/office-rendering",
);
const DIST_RENDERING_ROOT = path.resolve(
  SCRIPT_DIR,
  "../../../../dist/extra-dependencies/office-rendering",
);
function parseXml(bytes) {
  return new DOMParser({
    errorHandler: {
      warning() {},
      error(message) {
        throw new Error(message);
      },
      fatalError(message) {
        throw new Error(message);
      },
    },
  }).parseFromString(Buffer.from(bytes).toString("utf8"), "application/xml");
}
function localName(node) {
  return node?.localName || node?.nodeName?.split(":").pop();
}
function descendants(root, name) {
  const out = [];
  const visit = (node) => {
    for (let child = node?.firstChild; child; child = child.nextSibling) {
      if (child.nodeType !== 1) continue;
      if (!name || localName(child) === name) out.push(child);
      visit(child);
    }
  };
  visit(root);
  return out;
}
function wAttr(node, name) {
  return node?.getAttributeNS(W_NS, name) || node?.getAttribute(`w:${name}`) || "";
}
function commandResult(command, env, verbose, timeout = 120000) {
  if (verbose) console.log("[render_docx] $ " + command.join(" "));
  const result = spawnSync(command[0], command.slice(1), {
    env,
    encoding: "utf8",
    shell: false,
    timeout,
    windowsHide: true,
  });
  if (result.error && result.error.code === "ETIMEDOUT")
    throw new Error(`Command timed out: ${command[0]}`);
  if (verbose) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stdout.write(result.stderr);
  }
  return { status: result.status ?? 1, stdout: result.stdout || "", stderr: result.stderr || "" };
}
function platformKey() {
  return `${process.platform}-${process.arch}`;
}
async function existingDirectory(directory) {
  try {
    return (await fs.stat(directory)).isDirectory();
  } catch {
    return false;
  }
}
function asarUnpackedRoot(root) {
  const marker = `${path.sep}app.asar${path.sep}`;
  const index = root.indexOf(marker);
  if (index < 0) return null;
  return `${root.slice(0, index)}${path.sep}app.asar.unpacked${root.slice(index + marker.length - 1)}`;
}
async function validManifest(directory, key) {
  try {
    const manifest = JSON.parse(
      await fs.readFile(path.join(directory, "OFFICE-RENDERING-MANIFEST.json"), "utf8"),
    );
    return (
      `${manifest.platform}-${manifest.arch}` === key &&
      JSON.stringify(manifest.binaries) ===
        JSON.stringify(
          process.platform === "win32"
            ? ["bin/soffice.exe", "bin/pdfinfo.exe", "bin/pdftoppm.exe"]
            : ["bin/soffice", "bin/pdfinfo", "bin/pdftoppm"],
        )
    );
  } catch {
    return false;
  }
}
async function resolveRenderer() {
  const key = platformKey();
  const configured = process.env.MEMMY_DOCX_RENDERING_ROOT?.trim();
  const roots = [];
  const officeConfigured = process.env.MEMMY_OFFICE_RENDERING_ROOT?.trim();
  if (officeConfigured) roots.push(path.resolve(officeConfigured));
  if (configured) roots.push(path.resolve(configured));
  roots.push(DIST_RENDERING_ROOT, SOURCE_RENDERING_ROOT);
  for (const root of [...roots]) {
    const unpacked = asarUnpackedRoot(root);
    if (unpacked) roots.push(unpacked);
  }
  const allowSystem = process.env.MEMMY_DOCX_ALLOW_SYSTEM_RENDERER === "1";
  const attempted = [];
  for (const root of roots) {
    const directory = path.join(root, key);
    const names =
      process.platform === "win32"
        ? { soffice: "soffice.exe", pdfinfo: "pdfinfo.exe", pdftoppm: "pdftoppm.exe" }
        : { soffice: "soffice", pdfinfo: "pdfinfo", pdftoppm: "pdftoppm" };
    const binaries = Object.fromEntries(
      Object.entries(names).map(([name, binary]) => [name, path.join(directory, "bin", binary)]),
    );
    attempted.push(directory);
    if (
      (await existingDirectory(directory)) &&
      (await validManifest(directory, key)) &&
      (await Promise.all(
        Object.values(binaries).map(async (file) => {
          try {
            return (await fs.stat(file)).isFile();
          } catch {
            return false;
          }
        }),
      ).then((values) => values.every(Boolean)))
    )
      return { root: directory, ...binaries };
  }
  if (allowSystem)
    return {
      root: "system PATH",
      soffice: process.platform === "win32" ? "soffice.exe" : "soffice",
      pdfinfo: process.platform === "win32" ? "pdfinfo.exe" : "pdfinfo",
      pdftoppm: process.platform === "win32" ? "pdftoppm.exe" : "pdftoppm",
    };
  throw new Error(
    `Office renderer bundle is unavailable for platform=${process.platform} arch=${process.arch}. Tried roots: ${attempted.join(", ") || "(none)"}. Missing soffice, pdfinfo or pdftoppm. Set MEMMY_OFFICE_RENDERING_ROOT (or the legacy MEMMY_DOCX_RENDERING_ROOT during migration) for a bundled parent directory, or MEMMY_DOCX_ALLOW_SYSTEM_RENDERER=1 only for development diagnostics.`,
  );
}
function rendererEnv(profile) {
  const env = {
    ...process.env,
    HOME: profile,
    XDG_CONFIG_HOME: path.join(profile, "xdg_config"),
    XDG_CACHE_HOME: path.join(profile, "xdg_cache"),
  };
  if (
    process.platform === "darwin" &&
    process.env.TMPDIR !== "/private/tmp" &&
    existsSync("/private/tmp")
  ) {
    env.TMPDIR = "/private/tmp";
    env.TEMP = "/private/tmp";
    env.TMP = "/private/tmp";
  }
  return env;
}
function parsePageSize(root) {
  const page = descendants(root, "pgSz")[0];
  const width = Number(wAttr(page, "w")),
    height = Number(wAttr(page, "h"));
  if (!width || !height) throw new Error("Page size attributes missing in pgSz");
  return [width / TWIPS_PER_INCH, height / TWIPS_PER_INCH];
}
async function dpiFromDocx(input, maxWidth, maxHeight) {
  const zip = await JSZip.loadAsync(await fs.readFile(input));
  const entry = zip.file("word/document.xml");
  if (!entry) throw new Error("word/document.xml is missing");
  const [width, height] = parsePageSize(parseXml(await entry.async("nodebuffer")).documentElement);
  if (width <= 0 || height <= 0) throw new Error("Invalid page size values in document.xml");
  return Math.round(Math.min(maxWidth / width, maxHeight / height));
}
function nonempty(file) {
  try {
    return statSync(file).size > 0;
  } catch {
    return false;
  }
}
function convertToPdf(input, renderer, profile, convertDir, verbose) {
  const env = rendererEnv(profile);
  const profileArgument = `-env:UserInstallation=${pathToFileURL(profile).href}`;
  const stem = path.basename(input, path.extname(input));
  const pdf = path.join(convertDir, `${stem}.pdf`);
  const logs = [];
  const logResult = (label, command, result) => {
    logs.push(`--- ${label} ---`, `CMD: ${command.join(" ")}`, `EXIT: ${result.status}`);
    if (result.stdout) logs.push(`STDOUT:\n${result.stdout.trim()}`);
    if (result.stderr) logs.push(`STDERR:\n${result.stderr.trim()}`);
  };
  const direct = [
    renderer.soffice,
    profileArgument,
    "--invisible",
    "--headless",
    "--norestore",
    "--convert-to",
    "pdf",
    "--outdir",
    convertDir,
    input,
  ];
  const first = commandResult(direct, env, verbose);
  logResult("DOCX->PDF", direct, first);
  if (nonempty(pdf)) return { pdf, logs: logs.join("\n") };
  let candidate = readdirSync(convertDir)
    .filter((name) => name.toLowerCase().endsWith(".pdf"))
    .sort()[0];
  if (candidate && nonempty(path.join(convertDir, candidate)))
    return { pdf: path.join(convertDir, candidate), logs: logs.join("\n") };
  const odt = [
    renderer.soffice,
    profileArgument,
    "--invisible",
    "--headless",
    "--norestore",
    "--convert-to",
    "odt",
    "--outdir",
    convertDir,
    input,
  ];
  const second = commandResult(odt, env, verbose);
  logResult("DOCX->ODT", odt, second);
  const odtPath = path.join(convertDir, `${stem}.odt`);
  if (nonempty(odtPath)) {
    const odtPdf = [
      renderer.soffice,
      profileArgument,
      "--invisible",
      "--headless",
      "--norestore",
      "--convert-to",
      "pdf",
      "--outdir",
      convertDir,
      odtPath,
    ];
    const third = commandResult(odtPdf, env, verbose);
    logResult("ODT->PDF", odtPdf, third);
    if (nonempty(pdf)) return { pdf, logs: logs.join("\n") };
    candidate = readdirSync(convertDir)
      .filter((name) => name.toLowerCase().endsWith(".pdf"))
      .sort()[0];
    if (candidate && nonempty(path.join(convertDir, candidate)))
      return { pdf: path.join(convertDir, candidate), logs: logs.join("\n") };
  }
  throw new Error(
    "Failed to produce PDF for rasterization (direct and ODT fallback).\n" + logs.join("\n"),
  );
}
function pdfPageSize(pdf, renderer, env, verbose) {
  const result = commandResult([renderer.pdfinfo, pdf], env, verbose);
  if (result.status !== 0) throw new Error(`pdfinfo failed: ${result.stderr}`);
  const match = /Page size:\s*([\d.]+)\s*x\s*([\d.]+)\s*pts/i.exec(result.stdout);
  if (!match) throw new Error("Unrecognized PDF page size format.");
  return [Number(match[1]) / 72, Number(match[2]) / 72];
}
async function dpiFromPdf(input, maxWidth, maxHeight, renderer, verbose) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "soffice_profile_"));
  const convertDir = await fs.mkdtemp(path.join(os.tmpdir(), "soffice_convert_"));
  try {
    const env = rendererEnv(profile);
    const { pdf } = convertToPdf(input, renderer, profile, convertDir, verbose);
    const [width, height] = pdfPageSize(pdf, renderer, env, verbose);
    return Math.round(Math.min(maxWidth / width, maxHeight / height));
  } finally {
    await fs.rm(profile, { recursive: true, force: true });
    await fs.rm(convertDir, { recursive: true, force: true });
  }
}
async function rasterize(input, outputDir, dpi, renderer, verbose, emitPdf) {
  await fs.mkdir(outputDir, { recursive: true });
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "soffice_profile_"));
  const convertDir = await fs.mkdtemp(path.join(os.tmpdir(), "soffice_convert_"));
  try {
    const { pdf } = convertToPdf(path.resolve(input), renderer, profile, convertDir, verbose);
    if (emitPdf)
      await fs.copyFile(
        pdf,
        path.join(outputDir, `${path.basename(input, path.extname(input))}.pdf`),
      );
    const prefix = path.join(convertDir, "page");
    const env = rendererEnv(profile);
    const result = commandResult(
      [renderer.pdftoppm, "-r", String(dpi), "-png", pdf, prefix],
      env,
      verbose,
    );
    if (result.status !== 0) throw new Error(`pdftoppm failed: ${result.stderr}`);
    const files = (await fs.readdir(convertDir))
      .filter((name) => /^page-\d+\.png$/.test(name))
      .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
    if (!files.length) throw new Error("pdftoppm produced no PNG pages");
    for (const [index, name] of files.entries())
      await fs.rename(path.join(convertDir, name), path.join(outputDir, `page-${index + 1}.png`));
    return files.map((_, index) => path.join(outputDir, `page-${index + 1}.png`));
  } finally {
    await fs.rm(profile, { recursive: true, force: true });
    await fs.rm(convertDir, { recursive: true, force: true });
  }
}
async function main() {
  const invocationArgs = process.argv.slice(2);
  if (invocationArgs.includes("--help") || invocationArgs.includes("-h")) {
    process.stdout.write(
      [
        "usage: render_docx.mjs [-h] [--output_dir OUTPUT_DIR] [--width WIDTH]",
        "                      [--height HEIGHT] [--dpi DPI] [--emit_pdf] [--verbose]",
        "                      input_path",
        "",
        "Render DOCX-like file to PNG images (internal DOCX -> PDF -> PNG).",
        "",
        "positional arguments:",
        "  input_path            Path to the input DOCX file (or compatible).",
        "",
        "options:",
        "  -h, --help            show this help message and exit",
        "  --output_dir OUTPUT_DIR",
        "                        Output directory for the rendered images. Defaults to",
        "                        a folder next to the input named after the input file",
        "                        (without extension).",
        "  --width WIDTH         Approximate maximum width in pixels after isotropic",
        "                        scaling (default 1600). The actual value may exceed",
        "                        slightly.",
        "  --height HEIGHT       Approximate maximum height in pixels after isotropic",
        "                        scaling (default 2000). The actual value may exceed",
        "                        slightly.",
        "  --dpi DPI             Override computed DPI. If provided, skips DOCX/PDF-",
        "                        based DPI calculation.",
        "  --emit_pdf            Also write an intermediate PDF to --output_dir as",
        "                        <input_stem>.pdf. Default is PNG-only to avoid",
        "                        confusing intermediates with deliverables.",
        "  --verbose             Print LibreOffice commands and captured stdout/stderr",
        "                        (useful for debugging).",
        "",
      ].join("\n"),
    );
    return;
  }
  if (invocationArgs.length === 0) {
    process.stderr.write(
      [
        "usage: render_docx.mjs [-h] [--output_dir OUTPUT_DIR] [--width WIDTH]",
        "                      [--height HEIGHT] [--dpi DPI] [--emit_pdf] [--verbose]",
        "                      input_path",
        "render_docx.mjs: error: the following arguments are required: input_path",
        "",
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }
  const args = process.argv.slice(2);
  const inputArg = args[0];
  let outputArg = null,
    width = 1600,
    height = 2000,
    dpiArg = null,
    emitPdf = false,
    verbose = false;
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === "--output_dir") outputArg = args[++i];
    else if (args[i] === "--width") width = Number(args[++i]);
    else if (args[i] === "--height") height = Number(args[++i]);
    else if (args[i] === "--dpi") dpiArg = Number(args[++i]);
    else if (args[i] === "--emit_pdf") emitPdf = true;
    else if (args[i] === "--verbose") verbose = true;
    else {
      console.error(`unknown argument: ${args[i]}`);
      process.exitCode = 2;
      return;
    }
  }
  if (!inputArg) {
    console.error(
      "usage: render_docx.mjs input.docx [--output_dir DIR] [--width PX] [--height PX] [--dpi DPI] [--emit_pdf] [--verbose]",
    );
    process.exitCode = 2;
    return;
  }
  const input = path.resolve(inputArg);
  const output = path.resolve(
    outputArg || path.join(path.dirname(input), path.basename(input, path.extname(input))),
  );
  const renderer = await resolveRenderer();
  let dpi = dpiArg;
  if (dpi == null) {
    try {
      dpi = /\.(docx|docm|dotx|dotm)$/i.test(input)
        ? await dpiFromDocx(input, width, height)
        : (() => {
            throw new Error("Skip OOXML DPI; not a DOCX container");
          })();
    } catch {
      dpi = await dpiFromPdf(input, width, height, renderer, verbose);
    }
  }
  await rasterize(input, output, dpi, renderer, verbose, emitPdf);
  console.log("Pages rendered to " + output);
}
main().catch((error) => {
  console.error(`[ERROR] ${error.message}`);
  process.exitCode = 2;
});
