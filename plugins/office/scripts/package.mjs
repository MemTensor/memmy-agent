import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const manifest = JSON.parse(await readFile(join(dist, "plugin.json"), "utf8"));
const zip = new JSZip();
let files = 0, expanded = 0;
async function add(directory, prefix = "") {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = join(directory, entry.name), name = prefix + entry.name;
    if ((await lstat(file)).isSymbolicLink()) throw new Error(`Symlink in package: ${name}`);
    if (entry.isDirectory()) await add(file, name + "/");
    else {
      const bytes = await readFile(file); expanded += bytes.length; files++;
      zip.file(name, bytes, { date: new Date("1980-01-01T00:00:00Z"), createFolders: false,
        unixPermissions: name.endsWith(".mjs") ? 0o100755 : 0o100644 });
    }
  }
}
await add(dist);
const bytes = await zip.generateAsync({ type: "nodebuffer", platform: "UNIX", compression: "DEFLATE", compressionOptions: { level: 9 } });
if (bytes.length > 50 * 1024 * 1024 || expanded > 250 * 1024 * 1024 || files > 2000) throw new Error("Office exceeds Host package limits");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const file = `${manifest.id}-${manifest.version}.mpp.zip`;
const release = { manifest, artifact: { file, sha256, bytes: bytes.length, files } };
const destination = join(root, "release");
await mkdir(destination, { recursive: true });
// Releases are immutable: changing inputs requires a new plugin version.
async function immutable(name, content) {
  const target = join(destination, name);
  try { await writeFile(target, content, { flag: "wx" }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (!(await readFile(target)).equals(Buffer.from(content))) throw new Error(`Refusing to overwrite release ${name}; bump the version`);
  }
}
await immutable(file, bytes);
await immutable(`${manifest.id}-${manifest.version}.release.json`, JSON.stringify(release, null, 2) + "\n");
await writeFile(join(destination, "catalog.json"), JSON.stringify([{ pluginId: manifest.id, version: manifest.version }], null, 2) + "\n");
console.log(JSON.stringify(release.artifact));
