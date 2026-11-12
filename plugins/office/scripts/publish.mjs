/** Prepare an immutable registry directory; deploy artifacts before its catalog. */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, rename, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import JSZip from "jszip";

const options = {};
for (let i = 2; i < process.argv.length; i++) {
  const flag = process.argv[i];
  if (flag === "--help") { console.log("Usage: publish.mjs --root DIR --descriptor RELEASE.json --artifact PACKAGE.zip [--set-default]"); process.exit(0); }
  if (flag === "--set-default") options.setDefault = true;
  else if (["--root", "--descriptor", "--artifact"].includes(flag)) options[flag.slice(2)] = process.argv[++i];
  else throw new Error(`Unknown flag: ${flag}`);
}
if (!options.root || !options.descriptor || !options.artifact) throw new Error("root, descriptor and artifact are required");
const release = JSON.parse(await readFile(options.descriptor, "utf8"));
const bytes = await readFile(options.artifact);
const manifest = release.manifest;
if (manifest?.id !== "office" || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(manifest.version)) throw new Error("Expected a versioned Office manifest");
const sha256 = createHash("sha256").update(bytes).digest("hex");
if (release.artifact.sha256 !== sha256 || !bytes.length || bytes.length > 50 * 1024 * 1024) throw new Error("Artifact size/hash mismatch");
const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
if (JSON.stringify(JSON.parse(await zip.file("plugin.json").async("string"))) !== JSON.stringify(manifest)) throw new Error("Packaged manifest mismatch");
let expanded = 0;
if (Object.keys(zip.files).length > 2000) throw new Error("Too many files");
for (const entry of Object.values(zip.files)) {
  const name = entry.unsafeOriginalName ?? entry.name;
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name) || /[\\\0]/.test(name) || name.split("/").some(p => p === ".." || p === ".")
    || (Number(entry.unixPermissions) & 0o170000) === 0o120000) throw new Error("Unsafe archive entry");
  expanded += entry._data?.uncompressedSize ?? 0;
  if (expanded > 250 * 1024 * 1024) throw new Error("Expanded archive exceeds Host limits");
}
const root = resolve(options.root);
await mkdir(root, { recursive: true });
const lock = join(root, ".office-publish-lock");
await mkdir(lock); // Atomic inter-process lock; concurrent publishers must retry.
try {
  const file = `office-${manifest.version}-${sha256.slice(0, 16)}.zip`;
  const record = { ...release, pluginId: "office", version: manifest.version, artifact: { file, sha256 } };
  const catalogPath = join(root, "catalog.json");
  let catalog;
  try { catalog = JSON.parse(await readFile(catalogPath, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; catalog = []; }
  if (!Array.isArray(catalog) || catalog.some(entry => entry.pluginId !== "office")) throw new Error("Office registry cannot contain other plugins");
  const immutable = async (name, content) => {
    const target = join(root, name);
    try { await writeFile(target, content, { flag: "wx" }); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (!(await readFile(target)).equals(Buffer.from(content))) throw new Error(`Published version cannot be overwritten: ${name}`);
    }
  };
  // Descriptor first checked for conflicts before writing any artifact.
  const recordName = `office-${manifest.version}.release.json`;
  const encoded = JSON.stringify(record, null, 2) + "\n";
  const previous = await readFile(join(root, recordName)).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
  if (previous && !previous.equals(Buffer.from(encoded))) throw new Error("Published version cannot be overwritten");
  await immutable(file, bytes);
  await immutable(recordName, encoded);
  if (options.setDefault) {
    const temporary = join(root, `${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify([{ pluginId: "office", version: manifest.version }], null, 2) + "\n");
    await rename(temporary, catalogPath);
  }
  console.log(join(root, recordName));
} finally { await rm(lock, { recursive: true }); }
