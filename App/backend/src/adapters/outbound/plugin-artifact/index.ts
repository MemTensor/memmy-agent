/** Verified plugin artifact installation. */
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat
} from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import JSZip, { type JSZipObject } from "jszip";
import type { PluginRelease } from "../plugin-registry/index.js";
import type { PluginArtifactManager } from "./types.js";

const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 250 * 1024 * 1024;
const MAX_FILES = 2_000;

export type { PluginArtifactLocation, PluginArtifactManager } from "./types.js";

export interface CreatePluginArtifactManagerOptions {
  installRoot: string;
  fetchFn?: typeof fetch;
}

export function createPluginArtifactManager(options: CreatePluginArtifactManagerOptions): PluginArtifactManager {
  const configuredInstallRoot = resolve(options.installRoot);
  const fetchFn = options.fetchFn ?? fetch.bind(globalThis);

  return {
    async install(release) {
      if (!release.artifact) return { artifactHash: null, rootPath: null };
      const url = new URL(release.artifact.url);
      assertAllowedArtifactUrl(url);
      const bytes = await downloadArtifact(url, fetchFn);
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== release.artifact.sha256.toLowerCase()) {
        throw Object.assign(new Error("Plugin artifact SHA-256 mismatch"), { code: "plugin_invalid" });
      }

      await mkdir(configuredInstallRoot, { recursive: true });
      const installRoot = await realpath(configuredInstallRoot);
      const target = resolve(installRoot, release.manifest.id, digest);
      assertDescendant(installRoot, target);
      if (await isDirectory(target)) return { artifactHash: digest, rootPath: target };

      const temp = await mkdtemp(join(installRoot, ".install-"));
      const content = join(temp, "content");
      try {
        await mkdir(content);
        await extractZip(bytes, content);
        const pluginRoot = dirname(target);
        await mkdir(pluginRoot, { recursive: true });
        await assertCanonicalDirectory(pluginRoot);
        try {
          await rename(content, target);
        } catch (error) {
          if (!(await isDirectory(target))) throw error;
        }
        return { artifactHash: digest, rootPath: target };
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    },

    async readTextFile(plugin, relativePath, maxBytes) {
      if (!plugin.rootPath) throw new Error("Plugin has no installed artifact");
      const installRoot = await realpath(configuredInstallRoot);
      const root = await realpath(plugin.rootPath);
      assertDescendant(installRoot, root);
      const target = resolve(root, relativePath);
      assertDescendant(root, target);
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Plugin UI entry must be a regular file");
      if (await realpath(target) !== target) throw new Error("Plugin UI entry must not be a symbolic link");
      const content = await readFile(target);
      if (info.size > maxBytes || content.byteLength > maxBytes) throw new Error("Plugin UI entry exceeded size limit");
      return content.toString("utf8");
    },

    async remove(plugin) {
      if (!plugin.rootPath) return;
      const installRoot = await realpath(configuredInstallRoot);
      const target = resolve(plugin.rootPath);
      assertDescendant(installRoot, target);
      const info = await lstat(target).catch(() => null);
      if (!info) return;
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Refusing to remove an invalid plugin artifact path");
      await rm(target, { recursive: true, force: true });
    }
  };
}

async function downloadArtifact(url: URL, fetchFn: typeof fetch): Promise<Buffer> {
  const response = await fetchFn(url, {
    headers: { accept: "application/zip, application/octet-stream" },
    redirect: "error",
    signal: AbortSignal.timeout(60_000)
  });
  if (!response.ok) throw new Error(`Plugin artifact download failed with ${response.status}`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_ARCHIVE_BYTES) throw new Error("Plugin artifact exceeded size limit");
  if (!response.body) throw new Error("Plugin artifact response body is empty");
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > MAX_ARCHIVE_BYTES) throw new Error("Plugin artifact exceeded size limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

async function extractZip(bytes: Buffer, destination: string): Promise<void> {
  const archive = await JSZip.loadAsync(bytes, { checkCRC32: true, createFolders: false });
  const entries = Object.values(archive.files);
  if (entries.length > MAX_FILES) throw new Error("Plugin artifact contains too many files");
  let extractedBytes = 0;
  for (const entry of entries) {
    const relativePath = validateEntry(entry);
    const target = resolve(destination, relativePath);
    assertDescendant(destination, target);
    if (entry.dir) {
      await mkdir(target, { recursive: true });
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        extractedBytes += chunk.byteLength;
        callback(extractedBytes > MAX_EXTRACTED_BYTES ? new Error("Plugin artifact expanded beyond size limit") : null, chunk);
      }
    });
    await pipeline(entry.nodeStream("nodebuffer"), limiter, createWriteStream(target, { flags: "wx", mode: fileMode(entry) }));
    await chmod(target, fileMode(entry));
  }
}

function validateEntry(entry: JSZipObject): string {
  const rawName = entry.unsafeOriginalName ?? entry.name;
  if (entry.unsafeOriginalName && entry.unsafeOriginalName !== entry.name) {
    throw new Error(`Plugin artifact contains an unsafe path: ${rawName}`);
  }
  if (!rawName || rawName.includes("\\") || rawName.includes("\0") || isAbsolute(rawName) || /^[A-Za-z]:/.test(rawName)) {
    throw new Error(`Plugin artifact contains an unsafe path: ${rawName}`);
  }
  const segments = rawName.replace(/\/$/, "").split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Plugin artifact contains an unsafe path: ${rawName}`);
  }
  const mode = numericMode(entry.unixPermissions);
  if ((mode & 0o170000) === 0o120000) throw new Error(`Plugin artifact contains a symbolic link: ${rawName}`);
  return segments.join(sep);
}

function fileMode(entry: JSZipObject): number {
  const declared = numericMode(entry.unixPermissions) & 0o777;
  return declared || 0o600;
}

function numericMode(value: number | string | null): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number.parseInt(value, 8) || 0;
  return 0;
}

function assertAllowedArtifactUrl(url: URL): void {
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Plugin artifact URL must use HTTPS or loopback HTTP");
  }
}

function assertDescendant(parent: string, child: string): void {
  const path = relative(resolve(parent), resolve(child));
  if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error("Plugin artifact path escapes the install root");
  }
}

async function isDirectory(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => null);
  if (!info?.isDirectory()) return false;
  const canonical = await realpath(path);
  return canonical === resolve(path);
}

async function assertCanonicalDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== resolve(path)) {
    throw new Error("Plugin artifact directory must not contain symbolic links");
  }
}
