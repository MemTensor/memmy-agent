/** Release-build preparation only. End users download the resulting portable archive. */
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, copyFile, cp, mkdir, open, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { buildWindowsConverter } from "./build-windows-converter.mjs";
import { smokeWindowsConverter } from "./smoke-windows-converter.mjs";

const destination = resolve(process.argv[2] ?? "release/runtime-tree");
await mkdir(destination, { recursive: false }); // never merge a new release into stale binaries
const tools = {};
if (process.platform === "win32") {
  const libreoffice = process.env.OFFICE_BUILD_LIBREOFFICE ?? join(process.env.ProgramFiles ?? "C:\\Program Files", "LibreOffice");
  const poppler = process.env.OFFICE_BUILD_POPPLER;
  if (!poppler) throw new Error("OFFICE_BUILD_POPPLER must point to the extracted Poppler root containing Library/bin");
  await cp(libreoffice, join(destination, "LibreOffice"), { recursive: true, dereference: true });
  await cp(poppler, join(destination, "poppler"), { recursive: true, dereference: true });
  await buildWindowsConverter(join(destination, "LibreOffice/program"));
  tools.soffice = "LibreOffice/program/memmy-office-convert.exe";
  for (const name of ["pdfinfo", "pdftoppm", "pdftotext"]) tools[name] = `poppler/Library/bin/${name}.exe`;
  // Portable VC++ runtime: place app-local DLLs next to both tool families.
  // Release operators must retain Microsoft's redistribution terms in notices.
  for (const file of ["msvcp140.dll", "msvcp140_1.dll", "msvcp140_2.dll", "vcruntime140.dll", "vcruntime140_1.dll", "concrt140.dll"]) {
    const source = join(process.env.SystemRoot ?? "C:\\Windows", "System32", file);
    await access(source); // fail the release rather than shipping a partially portable runtime
    for (const bin of ["LibreOffice/program", "poppler/Library/bin"]) await copyFile(source, join(destination, bin, file));
  }
  await smokeWindowsConverter(join(destination, tools.soffice));
} else if (process.platform === "darwin") {
  const libreoffice = process.env.OFFICE_BUILD_LIBREOFFICE ?? "/Applications/LibreOffice.app";
  await cp(libreoffice, join(destination, "LibreOffice.app"), { recursive: true, dereference: true });
  const formulas = ["poppler", ...execFileSync("brew", ["deps", "--formula", "poppler"], { encoding: "utf8" }).trim().split(/\s+/)].filter(Boolean);
  const prefixes = [];
  for (const formula of [...new Set(formulas)]) {
    const prefix = execFileSync("brew", ["--prefix", formula], { encoding: "utf8" }).trim();
    const target = join(destination, "formula", formula);
    await cp(prefix, target, { recursive: true, dereference: true }); prefixes.push({ prefix, target });
    // Homebrew binaries sometimes refer directly to Cellar paths.
    const canonical = execFileSync("realpath", [prefix], { encoding: "utf8" }).trim(); prefixes.push({ prefix: canonical, target });
  }
  const binaries = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else {
        const handle = await open(file, "r"), header = Buffer.alloc(4);
        try { await handle.read(header, 0, 4, 0); } finally { await handle.close(); }
        if (["feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"].includes(header.toString("hex")) && /Mach-O/.test(execFileSync("file", ["-b", file], { encoding: "utf8" }))) binaries.push(file);
      }
    }
  }
  await walk(join(destination, "formula"));
  prefixes.sort((a,b) => b.prefix.length - a.prefix.length);
  for (const binary of binaries) {
    await chmod(binary, 0o755);
    const dependencies = execFileSync("otool", ["-L", binary], { encoding: "utf8" }).split("\n").slice(1).map(l => l.trim().split(" (")[0]).filter(Boolean);
    for (const dependency of dependencies) {
      if (dependency.startsWith("/usr/lib/") || dependency.startsWith("/System/") || dependency.startsWith("@")) continue;
      const mapping = prefixes.find(p => dependency.startsWith(p.prefix + "/"));
      if (!mapping) throw new Error(`Unbundled dependency: ${dependency}`);
      const relocated = join(mapping.target, relative(mapping.prefix, dependency));
      await access(relocated);
      execFileSync("install_name_tool", ["-change", dependency, "@loader_path/" + relative(dirname(binary), relocated), binary], { stdio: "pipe" });
    }
    if (binary.endsWith(".dylib")) execFileSync("install_name_tool", ["-id", "@loader_path/" + relative(dirname(binary), binary), binary], { stdio: "pipe" });
    execFileSync("codesign", ["--force", "--sign", "-", binary], { stdio: "pipe" });
  }
  tools.soffice = "LibreOffice.app/Contents/MacOS/soffice";
  for (const name of ["pdfinfo", "pdftoppm", "pdftotext"]) tools[name] = `formula/poppler/bin/${name}`;
} else throw new Error("Provision an explicit portable root on this platform and use package-runtime.mjs");
for (const file of Object.values(tools)) await access(join(destination, file), constants.X_OK);
await writeFile(join(destination, "runtime-tools.json"), JSON.stringify(tools, null, 2));
console.log(destination);
