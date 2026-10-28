/** Host-owned, user-scoped installation of verified portable runtimes. */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { z } from "zod";
import * as yauzl from "yauzl";

const MAX_ARCHIVE = 1024 * 1024 * 1024;
const MAX_EXPANDED = 4 * 1024 * 1024 * 1024;
const MAX_FILES = 50000;
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export function safeRuntimePath(value: string): boolean {
  return Boolean(value) && value.length < 1000 && !isAbsolute(value) && !/[\\:\0<>"|?*\x01-\x1f]/.test(value)
    && value.split("/").every(p => p && p !== "." && p !== ".." && !/[. ]$/.test(p)
      && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p));
}
const filePath = z.string().refine(safeRuntimePath, "Unsafe runtime path");
export const PortableRuntimeManifestSchema = z.object({
  format: z.string().regex(/^memmy-(office|texlive)-runtime-v1$/),
  target: z.string().regex(/^(darwin|linux|win32)-(x64|arm64)$/),
  version: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,80}$/),
  archive: z.object({ url: z.string(), sha256, bytes: z.number().int().positive().max(MAX_ARCHIVE) }).strict(),
  tools: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), filePath).refine(v => Object.keys(v).length > 0 && Object.keys(v).length <= 16),
  files: z.record(filePath, sha256).refine(v => Object.keys(v).length > 0 && Object.keys(v).length <= MAX_FILES)
}).strict();
export type PortableRuntimeManifest = z.infer<typeof PortableRuntimeManifestSchema>;
export interface InstalledPortableRuntime { root: string; tools: Record<string, string>; version: string }
export interface PortableRuntimeInstallerOptions {
  kind: "office" | "texlive";
  requiredTools: readonly string[];
  cacheRoot: string;
  catalogUrl: string;
  fetchFn?: typeof fetch;
  /** Primarily for progress displays/diagnostics; never contains signed URLs. */
  onProgress?: (stage: string, bytes?: number, total?: number) => void;
}
export interface PortableRuntimeInstaller { ensure(platform: NodeJS.Platform, arch: string): Promise<InstalledPortableRuntime> }
const inFlight = new Map<string, Promise<InstalledPortableRuntime>>();

function allowedURL(value: string, base?: string): URL {
  const url = new URL(value, base);
  if (url.username || url.password || !(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("Portable runtime downloads require HTTPS or loopback HTTP");
  return url;
}
async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function verifyRoot(root: string, manifest: PortableRuntimeManifest): Promise<InstalledPortableRuntime> {
  // Also reject added DLLs/resources that could change native loader behavior.
  let entries = 0;
  async function scan(directory: string, prefix = ""): Promise<void> {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (++entries > 100000) throw new Error("Portable runtime cache has too many entries");
      const name = prefix + item.name;
      if (item.isSymbolicLink()) throw new Error("Portable runtime cache contains a symbolic link");
      if (item.isDirectory()) await scan(join(directory, item.name), name + "/");
      else if (!item.isFile() || (!manifest.files[name] && name !== ".memmy-runtime.json")) throw new Error(`Unexpected Portable runtime cache entry: ${name}`);
    }
  }
  await scan(root);
  for (const [name, expected] of Object.entries(manifest.files)) {
    const file = resolve(root, name);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || await realpath(file) !== file || await hashFile(file) !== expected) throw new Error(`Portable runtime file integrity check failed: ${name}`);
  }
  const tools: Record<string, string> = {};
  for (const name of Object.keys(manifest.tools)) {
    const file = manifest.tools[name]!;
    if (!manifest.files[file]) throw new Error(`Portable runtime tool is not covered by the manifest: ${name}`);
    tools[name] = resolve(root, file);
    if (process.platform !== "win32" && !((await lstat(tools[name]!)).mode & 0o111)) throw new Error(`Portable runtime tool is not executable: ${name}`);
  }
  return { root, tools, version: manifest.version };
}

export function createPortableRuntimeInstaller(options: PortableRuntimeInstallerOptions): PortableRuntimeInstaller {
  if (!isAbsolute(options.cacheRoot)) throw new Error("Portable cache root must be absolute");
  const fetchFn = options.fetchFn ?? fetch;
  const base = allowedURL(options.catalogUrl).href;
  function parseManifest(record: unknown): PortableRuntimeManifest {
    const manifest = PortableRuntimeManifestSchema.parse(record);
    if (manifest.format !== `memmy-${options.kind}-runtime-v1`
      || Object.keys(manifest.tools).sort().join(",") !== [...options.requiredTools].sort().join(",")) {
      throw new Error("Portable runtime kind/tools mismatch");
    }
    return manifest;
  }
  return { ensure(platform, arch) {
    const target = `${platform}-${arch}`;
    if (!/^(darwin|linux|win32)-(x64|arm64)$/.test(target)) return Promise.reject(new Error(`Unsupported Portable runtime target: ${target}`));
    const key = `${resolve(options.cacheRoot)}\0${options.kind}\0${target}\0${base}`;
    const running = inFlight.get(key);
    if (running) return running;
    const result = ensure(target).finally(() => { inFlight.delete(key); });
    inFlight.set(key, result);
    return result;
  } };

  async function ensure(target: string): Promise<InstalledPortableRuntime> {
    await mkdir(options.cacheRoot, { recursive: true });
    const cache = await realpath(options.cacheRoot);
    const pointer = join(cache, `${target}.json`);
    try {
      const record = JSON.parse(await readFile(pointer, "utf8"));
      const manifest = parseManifest(record);
      if (manifest.target !== target) throw new Error("Cached runtime target mismatch");
      const installed = await verifyRoot(join(cache, target, manifest.archive.sha256), manifest);
      options.onProgress?.("cached"); return installed;
    } catch { /* Missing/corrupt caches are repaired by a verified reinstall. */ }
    const lock = join(cache, `${target}.lock`);
    let acquired = false;
    for (let attempt = 0; attempt < 1200; attempt++) {
      try {
        await mkdir(lock); acquired = true;
        await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: process.pid }), { flag: "wx" });
        break;
      }
      catch (error) {
        if (acquired) { await rm(lock, { recursive: true, force: true }); throw error; }
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const info = await lstat(lock).catch(() => null);
        if (info?.isSymbolicLink()) throw new Error("Unsafe Portable installation lock");
        let abandoned = false;
        try {
          const owner = JSON.parse(await readFile(join(lock, "owner.json"), "utf8"));
          if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error("Invalid installation owner");
          try { process.kill(owner.pid, 0); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") abandoned = true; }
        } catch { abandoned = Boolean(info && Date.now() - info.mtimeMs > 30000); }
        if (abandoned) await rm(lock, { recursive: true, force: true });
        await new Promise(ok => setTimeout(ok, 500));
      }
    }
    if (!acquired) throw new Error("Portable runtime installation is already in progress; retry shortly");
    let temporary: string | undefined;
    try {
      // Another Host process may have finished while we waited for the lock.
      try {
        const cached = parseManifest(JSON.parse(await readFile(pointer, "utf8")));
        if (cached.target === target) return await verifyRoot(join(cache, target, cached.archive.sha256), cached);
      } catch { /* fetch a clean manifest */ }
      options.onProgress?.("resolving");
      const url = new URL(base.replace(/\{target\}|%7Btarget%7D/gi, target));
      const response = await fetchFn(url, { redirect: "error", signal: AbortSignal.timeout(30000), headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`Portable runtime catalog returned HTTP ${response.status}`);
      const chunks: Buffer[] = []; let manifestBytes = 0;
      if (!response.body) throw new Error("Portable runtime catalog is empty");
      for await (const chunk of Readable.fromWeb(response.body as never)) {
        manifestBytes += chunk.length; chunks.push(Buffer.from(chunk));
        if (manifestBytes > 16 * 1024 * 1024) throw new Error("Portable runtime manifest exceeds 16 MiB");
      }
      const manifest = parseManifest(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (manifest.target !== target) throw new Error("Portable runtime platform/architecture mismatch");
      const paths = Object.keys(manifest.files);
      if (paths.some(n => n === ".memmy-runtime.json") || new Set(paths.map(n => n.toLowerCase())).size !== paths.length) throw new Error("Duplicate/reserved Portable runtime paths");
      const asset = allowedURL(manifest.archive.url, url.href);
      temporary = await mkdtemp(join(cache, ".portable-install-"));
      const archive = join(temporary, "runtime.zip"), content = join(temporary, "content");
      let lastError: unknown;
      for (let retry = 0; retry < 3; retry++) {
        try {
          options.onProgress?.(retry ? "retrying" : "downloading", 0, manifest.archive.bytes);
          const download = await fetchFn(asset, { redirect: "error", signal: AbortSignal.timeout(10 * 60 * 1000) });
          if (!download.ok || !download.body) throw new Error(`Portable runtime download returned HTTP ${download.status}`);
          let received = 0; const digest = createHash("sha256");
          const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
            received += chunk.length;
            if (received > manifest.archive.bytes || received > MAX_ARCHIVE) { callback(new Error("Portable runtime download exceeds declared size")); return; }
            digest.update(chunk); options.onProgress?.("downloading", received, manifest.archive.bytes); callback(null, chunk);
          } });
          await pipeline(Readable.fromWeb(download.body as never), meter, createWriteStream(archive, { flags: "w", mode: 0o600 }));
          if (received !== manifest.archive.bytes || digest.digest("hex") !== manifest.archive.sha256) throw new Error("Portable runtime archive integrity check failed");
          lastError = undefined; break;
        } catch (error) { lastError = error; await rm(archive, { force: true }); }
      }
      if (lastError) throw lastError;
      options.onProgress?.("extracting");
      await mkdir(content);
      await extractPortableRuntime(archive, content, manifest);
      await verifyRoot(content, manifest);
      await writeFile(join(content, ".memmy-runtime.json"), JSON.stringify(manifest));
      const parent = join(cache, target); await mkdir(parent, { recursive: true });
      if (await realpath(parent) !== parent) throw new Error("Unsafe Portable cache directory");
      const destination = join(parent, manifest.archive.sha256);
      // The lock excludes readers/installers. Replace only this corrupt content-addressed cache.
      await rm(destination, { recursive: true, force: true });
      await rename(content, destination);
      const pending = join(cache, `${target}.${randomUUID()}.tmp`);
      await writeFile(pending, JSON.stringify(manifest), { flag: "wx" }); await rename(pending, pointer);
      options.onProgress?.("installed");
      return await verifyRoot(destination, manifest);
    } finally {
      if (temporary) await rm(temporary, { recursive: true, force: true });
      await rm(lock, { recursive: true, force: true });
    }
  }
}

export async function extractPortableRuntime(archive: string, root: string, manifest: PortableRuntimeManifest): Promise<void> {
  const zip = await new Promise<yauzl.ZipFile>((ok, reject) => yauzl.open(archive, { lazyEntries: true, autoClose: true, validateEntrySizes: true }, (error, file) => error ? reject(error) : ok(file!)));
  const seen = new Set<string>(); let expanded = 0, files = 0, entries = 0;
  await new Promise<void>((ok, reject) => {
    let failed = false;
    const abort = (error: unknown) => { if (failed) return; failed = true; zip.close(); reject(error); };
    zip.on("error", abort); zip.once("end", () => { if (!failed) ok(); });
    zip.on("entry", (entry: yauzl.Entry) => {
      void (async () => {
        if (++entries > 100000) throw new Error("Portable runtime ZIP has too many entries");
        const name = entry.fileName.replace(/\/$/, "");
        if (!safeRuntimePath(name) || ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000) throw new Error("Unsafe Portable runtime ZIP entry");
        if (entry.fileName.endsWith("/")) { zip.readEntry(); return; }
        if (++files > MAX_FILES || seen.has(name.toLowerCase()) || !manifest.files[name] || entry.uncompressedSize > MAX_EXPANDED - expanded) throw new Error("Unexpected/oversized Portable runtime ZIP entry");
        seen.add(name.toLowerCase()); expanded += entry.uncompressedSize;
        const target = resolve(root, name); await mkdir(dirname(target), { recursive: true });
        const stream = await new Promise<NodeJS.ReadableStream>((yes, no) => zip.openReadStream(entry, (error, value) => error ? no(error) : yes(value!)));
        let size = 0; const hash = createHash("sha256");
        const check = new Transform({ transform(chunk: Buffer, _encoding, cb) {
          size += chunk.length;
          if (size > entry.uncompressedSize || size > MAX_EXPANDED) { cb(new Error("Portable runtime ZIP expansion limit exceeded")); return; }
          hash.update(chunk); cb(null, chunk);
        } });
        await pipeline(stream, check, createWriteStream(target, { flags: "wx", mode: 0o600 }));
        if (size !== entry.uncompressedSize || hash.digest("hex") !== manifest.files[name]) throw new Error(`Portable runtime file digest mismatch: ${name}`);
        await chmod(target, ((entry.externalFileAttributes >>> 16) & 0o111) ? 0o755 : 0o644);
        zip.readEntry();
      })().catch(abort);
    });
    zip.readEntry();
  });
  if (seen.size !== Object.keys(manifest.files).length) throw new Error("Portable runtime archive is incomplete");
}
