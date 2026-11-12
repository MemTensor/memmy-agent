/** Fetch an immutable, hash-pinned public CI fixture bundle. Never used by Desktop. */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const safeName = name => typeof name === "string" && /^[A-Za-z0-9._/-]+$/u.test(name)
  && !name.startsWith("/") && name.split("/").every(part => part && part !== "." && part !== "..");

export async function fetchFixtures(destination, options = {}) {
  const lock = options.lock ?? JSON.parse(await readFile(new URL("./fixtures.lock.json", import.meta.url), "utf8"));
  const fetchFn = options.fetchFn ?? fetch;
  const { archive, files } = lock;
  const url = new URL(archive.url);
  if (lock.format !== "memmy-texlive-brand-fixtures-v1" || url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || !/^[a-f0-9]{64}$/u.test(archive.sha256) || !Number.isSafeInteger(archive.bytes) || archive.bytes < 1 || archive.bytes > 8 * 1024 * 1024
    || !files || !Object.keys(files).length || Object.entries(files).some(([name, hash]) => !safeName(name) || !/^[a-f0-9]{64}$/u.test(hash))) {
    throw new Error("Invalid fixture lock");
  }
  const response = await fetchFn(url, { redirect: "error", signal: AbortSignal.timeout(60000) });
  if (!response.ok || !response.body) throw new Error(`Fixture download failed: HTTP ${response.status}`);
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > archive.bytes) throw new Error("Fixture archive size mismatch");
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  if (bytes !== archive.bytes || digest(buffer) !== archive.sha256) throw new Error("Fixture archive integrity check failed");
  const zip = await JSZip.loadAsync(buffer, { checkCRC32: true });
  const entries = Object.values(zip.files);
  if (entries.length !== Object.keys(files).length) throw new Error("Fixture archive file set mismatch");
  // Validate the full archive before writing any file. JSZip sanitizes traversal
  // names, so check unsafeOriginalName as well as the normalized entry name.
  const verified = [];
  for (const entry of entries) {
    const name = entry.unsafeOriginalName ?? entry.name;
    if (!safeName(name) || name !== entry.name || entry.dir || !Object.hasOwn(files, name)
      || (Number(entry.unixPermissions) & 0xf000) === 0xa000) throw new Error("Unexpected fixture archive entry");
    const data = await entry.async("nodebuffer");
    if (data.length > 8 * 1024 * 1024) throw new Error("Fixture file exceeds size limit");
    if (digest(data) !== files[name]) throw new Error(`Fixture file integrity check failed: ${name}`);
    verified.push([name, data]);
  }
  const target = resolve(destination);
  await mkdir(dirname(target), { recursive: true });
  const staging = await mkdtemp(join(dirname(target), ".texlive-fixtures-"));
  try {
    for (const [name, data] of verified) {
      const path = join(staging, name); await mkdir(dirname(path), { recursive: true });
      await writeFile(path, data, { flag: "wx" });
    }
    await rename(staging, target); // Require a fresh destination, never merge old fixtures.
  } finally { await rm(staging, { recursive: true, force: true }); }
  return { version: lock.version, archiveSha256: archive.sha256, bytes, files: verified.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Required: fresh fixture output directory");
  console.log(JSON.stringify(await fetchFixtures(process.argv[2])));
}
