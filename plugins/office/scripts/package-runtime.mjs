/** Stream a provisioned portable runtime into a separately distributed, verified ZIP.
 * No renderer binaries are included in the App or MPP. */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const hashFile = async file => { const hash = createHash("sha256"); for await (const b of createReadStream(file)) hash.update(b); return hash.digest("hex"); };
export async function packageRuntime({ root, destination, target, version, tools, setDefault = false, kind = "office" }) {
  if (!["office", "texlive"].includes(kind)) throw new Error("Invalid runtime kind");
  if (!/^(darwin|linux|win32)-(x64|arm64)$/.test(target) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,80}$/.test(version)) throw new Error("Invalid target/version");
  root = await realpath(root); destination = resolve(destination);
  if (!relative(root, destination).startsWith("..")) throw new Error("Output must be outside the provisioned runtime");
  const zip = new JSZip(), files = {}; let count = 0, expanded = 0;
  const safe = name => name && !isAbsolute(name) && !/[\\:\0<>"|?*\x01-\x1f]/.test(name) && name.split("/").every(p => p && p !== "." && p !== ".." && !/[. ]$/.test(p) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p));
  const names = new Set();
  async function walk(directory, prefix = "") {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name, "en"))) {
      const name = prefix + entry.name, file = join(directory, entry.name), info = await lstat(file);
      if (!safe(name) || name === ".memmy-runtime.json" || names.has(name.toLowerCase()) || info.isSymbolicLink()) throw new Error(`Unsafe runtime entry: ${name}; provision a dereferenced portable tree first`);
      names.add(name.toLowerCase());
      if (info.isDirectory()) await walk(file, name + "/");
      else if (info.isFile()) {
        if (++count > 50000 || (expanded += info.size) > 4 * 1024 ** 3) throw new Error("Runtime exceeds Host limits");
        files[name] = await hashFile(file);
        zip.file(name, Readable.from((async function* () { for await (const chunk of createReadStream(file)) yield chunk; })()), { date: new Date("1980-01-01T00:00:00Z"), createFolders: false, unixPermissions: 0o100000 | (info.mode & 0o111 ? 0o755 : 0o644) });
      } else throw new Error(`Unsupported runtime entry: ${name}`);
    }
  }
  await walk(root);
  if (Object.keys(tools).sort().join(",") !== (kind === "office" ? "pdfinfo,pdftoppm,pdftotext,soffice" : "kpsewhich,xelatex") || Object.values(tools).some(p => !files[p])) throw new Error("All runtime tools must be covered by the file manifest");
  await mkdir(destination, { recursive: true });
  const temporary = join(destination, `.runtime-${process.pid}-${Date.now()}.tmp`);
  try {
    await pipeline(zip.generateNodeStream({ platform: "UNIX", streamFiles: true, compression: "DEFLATE", compressionOptions: { level: 6 } }), createWriteStream(temporary, { flags: "wx" }));
    const bytes = (await lstat(temporary)).size;
    if (bytes > 1024 ** 3) throw new Error("Runtime archive exceeds 1 GiB");
    const sha256 = await hashFile(temporary), file = `${kind}-runtime-${target}-${sha256}.zip`;
    const manifest = { format: `memmy-${kind}-runtime-v1`, target, version, archive: { url: file, sha256, bytes }, tools, files };
    const descriptor = `${kind}-runtime-${target}-${version}.json`, encoded = JSON.stringify(manifest) + "\n";
    const previous = await readFile(join(destination, descriptor), "utf8").catch(e => { if (e.code !== "ENOENT") throw e; return null; });
    if (previous && previous !== encoded) throw new Error("Runtime releases are immutable; bump the runtime version");
    const exists = await lstat(join(destination, file)).catch(() => null);
    if (exists) { if (await hashFile(join(destination, file)) !== sha256) throw new Error("Published runtime archive is corrupt"); await rm(temporary); }
    else await rename(temporary, join(destination, file));
    if (!previous) await writeFile(join(destination, descriptor), encoded, { flag: "wx" });
    if (setDefault) { const pointer = `${temporary}.json`; await writeFile(pointer, encoded, { flag: "wx" }); await rename(pointer, join(destination, `${kind}-runtime-${target}.json`)); }
    return manifest;
  } finally { await rm(temporary, { force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = {}; for (let i = 2; i < process.argv.length; i++) { const key = process.argv[i]; if (key === "--set-default") args.setDefault = true; else if (["--root", "--destination", "--target", "--version", "--tools"].includes(key)) args[key.slice(2)] = process.argv[++i]; else throw new Error(`Unknown flag ${key}`); }
  if (!args.root || !args.destination || !args.target || !args.version || !args.tools) throw new Error("Required: --root --destination --target --version --tools TOOLS.json [--set-default]");
  args.tools = JSON.parse(await readFile(args.tools, "utf8"));
  const result = await packageRuntime(args); console.log(JSON.stringify({ target: result.target, archive: result.archive, files: Object.keys(result.files).length }));
}
