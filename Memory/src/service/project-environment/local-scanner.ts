import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import createIgnore from "ignore";
import {
  canonicalJson,
  isLocalWorkspaceUri,
  type WorkspaceUri
} from "@memmy/local-api-contracts";
import {
  PROJECT_ENVIRONMENT_SCAN_POLICY,
  deterministicReadCandidates,
  isDeterministicCandidate,
  isSensitivePath,
  requiredRuntimeProbes,
  validateWorkspaceRelativePath
} from "./scan-policy.js";
import type {
  InventoryEntry,
  ProjectEnvironmentScanResult,
  ProjectEnvironmentTextFile,
  RuntimeProbe,
  RuntimeProbeResult
} from "./types.js";

const execFileAsync = promisify(execFile);

const FIXED_EXCLUDES = new Set([
  ".git", "node_modules", "vendor", ".venv", "venv", "env", "dist", "build", "out",
  "coverage", ".cache", ".next", ".nuxt", "target", "__pycache__", ".pytest_cache", ".mypy_cache"
]);

const BINARY_EXTENSIONS = new Set([
  ".7z", ".a", ".avi", ".bin", ".bmp", ".class", ".dll", ".dylib", ".exe",
  ".gif", ".gz", ".ico", ".jar", ".jpeg", ".jpg", ".mov", ".mp3", ".mp4",
  ".o", ".obj", ".pdf", ".png", ".so", ".tar", ".tgz", ".wav", ".webm",
  ".webp", ".woff", ".woff2", ".xz", ".zip"
]);

const PROBE_SPEC: Record<RuntimeProbe, { executable: string; args: string[]; pattern: RegExp }> = {
  node_version: { executable: "node", args: ["--version"], pattern: /^v\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u },
  python_version: { executable: "python3", args: ["--version"], pattern: /^Python \d+\.\d+\.\d+(?:[\w.+-]*)$/u },
  go_version: { executable: "go", args: ["version"], pattern: /^go version go\d+\.\d+(?:\.\d+)?\b.*$/u },
  rust_version: { executable: "rustc", args: ["--version"], pattern: /^rustc \d+\.\d+\.\d+\b.*$/u },
  java_version: { executable: "java", args: ["-version"], pattern: /^(?:openjdk|java) version "[^"\r\n]+".*$/u }
};

interface InventorySnapshot {
  entries: InventoryEntry[];
  omittedCount: number;
}

export async function scanLocalProject(workspaceUri: WorkspaceUri): Promise<ProjectEnvironmentScanResult> {
  const root = await resolveLocalWorkspaceRoot(workspaceUri);
  let stable = await scanInventory(root);
  let next = await scanInventory(root);
  if (inventorySnapshot(stable) !== inventorySnapshot(next)) {
    stable = await scanInventory(root);
    next = await scanInventory(root);
    if (inventorySnapshot(stable) !== inventorySnapshot(next)) throw new Error("unstable_workspace");
  }

  const textFiles: ProjectEnvironmentTextFile[] = [];
  for (const candidate of deterministicReadCandidates(stable.entries)) {
    const textFile = await readStableText(root, candidate.relativePath, candidate.sha256, candidate.maxBytes);
    if (textFile) textFiles.push(textFile);
  }
  const runtimeProbes: RuntimeProbeResult[] = [];
  for (const probe of requiredRuntimeProbes(stable.entries)) {
    runtimeProbes.push(await runProbe(root, probe));
  }
  return { ...stable, textFiles, runtimeProbes };
}

export async function resolveLocalWorkspaceRoot(workspaceUri: WorkspaceUri): Promise<string> {
  if (!isLocalWorkspaceUri(workspaceUri)) throw new Error("project_environment_workspace_not_local");
  const requested = fileURLToPath(workspaceUri);
  const root = await realpath(requested);
  const details = await stat(root);
  if (!details.isDirectory()) throw new Error("project_environment_workspace_not_directory");
  const canonicalHome = await realpath(homedir());
  if (root === parse(root).root || root === canonicalHome) throw new Error("project_environment_workspace_root_forbidden");
  if (pathToFileURL(root).toString() !== workspaceUri) throw new Error("project_environment_workspace_not_canonical");
  return root;
}

async function scanInventory(root: string): Promise<InventorySnapshot> {
  const ignored = createIgnore();
  ignored.add(await readFile(resolve(root, ".gitignore"), "utf8").catch(() => ""));
  const collected: InventoryEntry[] = [];

  const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (depth > PROJECT_ENVIRONMENT_SCAN_POLICY.maxDepth) return;
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => compare(left.name, right.name));
    for (const child of children) {
      const relativePath = prefix ? `${prefix}/${child.name}` : child.name;
      if (
        validateWorkspaceRelativePath(relativePath) ||
        FIXED_EXCLUDES.has(child.name) ||
        isSensitivePath(relativePath) ||
        ignored.ignores(relativePath) ||
        (child.isDirectory() && ignored.ignores(`${relativePath}/`))
      ) continue;
      if (child.isSymbolicLink()) continue;
      const absolute = resolve(directory, child.name);
      const details = await lstat(absolute);
      if (details.isDirectory()) {
        collected.push({ relativePath, type: "directory", mtimeMs: floorTime(details.mtimeMs) });
        await walk(absolute, relativePath, depth + 1);
        continue;
      }
      if (!details.isFile() || isBinaryPath(relativePath)) continue;
      const entry: Extract<InventoryEntry, { type: "file" }> = {
        relativePath,
        type: "file",
        size: details.size,
        mtimeMs: floorTime(details.mtimeMs)
      };
      if (isDeterministicCandidate(relativePath) && details.size <= PROJECT_ENVIRONMENT_SCAN_POLICY.maxTextBytes) {
        const bytes = await readStableBytes(absolute, details.size, details.mtimeMs);
        if (bytes) entry.sha256 = createHash("sha256").update(bytes).digest("hex");
      }
      collected.push(entry);
    }
  };

  await walk(root, "", 1);
  const git = await lstat(resolve(root, ".git")).catch(() => null);
  if (git && (git.isDirectory() || git.isFile())) {
    collected.push({ relativePath: ".git", type: "directory", mtimeMs: 0 });
  }
  collected.sort((left, right) => compare(left.relativePath, right.relativePath));
  const omittedCount = Math.max(0, collected.length - PROJECT_ENVIRONMENT_SCAN_POLICY.maxEntries);
  return {
    entries: collected.slice(0, PROJECT_ENVIRONMENT_SCAN_POLICY.maxEntries),
    omittedCount
  };
}

async function readStableText(
  root: string,
  relativePath: string,
  expectedSha256: string,
  maxBytes: number
): Promise<ProjectEnvironmentTextFile | null> {
  const absolute = await safeExistingPath(root, relativePath);
  if (!absolute) return null;
  const before = await lstat(absolute);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) return null;
  const bytes = await readFile(absolute);
  const after = await lstat(absolute);
  if (!sameFileObservation(before, after)) return null;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== expectedSha256) return null;
  try {
    return {
      relativePath,
      sha256,
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    };
  } catch {
    return null;
  }
}

async function readStableBytes(absolute: string, size: number, mtimeMs: number): Promise<Buffer | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = await lstat(absolute);
    if (!before.isFile() || before.isSymbolicLink() || before.size > PROJECT_ENVIRONMENT_SCAN_POLICY.maxTextBytes) return null;
    const bytes = await readFile(absolute);
    const after = await lstat(absolute);
    if (sameFileObservation(before, after) && (attempt > 0 || (size === before.size && floorTime(mtimeMs) === floorTime(before.mtimeMs)))) {
      return bytes;
    }
  }
  return null;
}

async function safeExistingPath(root: string, relativePath: string): Promise<string | null> {
  if (validateWorkspaceRelativePath(relativePath) || isSensitivePath(relativePath)) return null;
  const candidate = resolve(root, ...relativePath.split("/"));
  if (!inside(root, candidate)) return null;
  const observed = await lstat(candidate).catch(() => null);
  if (!observed || observed.isSymbolicLink()) return null;
  const canonical = await realpath(candidate).catch(() => "");
  return canonical && inside(root, canonical) ? canonical : null;
}

async function runProbe(root: string, probe: RuntimeProbe): Promise<RuntimeProbeResult> {
  const spec = PROBE_SPEC[probe];
  const resolved = await findExecutable(spec.executable);
  if (!resolved) return { probe, exitCode: 127, versionText: null };
  const executable = await realpath(resolved);
  if (inside(root, executable)) return { probe, exitCode: 126, versionText: null };
  try {
    const result = await execFileAsync(executable, spec.args, {
      cwd: tmpdir(),
      env: probeEnvironment(),
      timeout: 2000,
      maxBuffer: 4096,
      shell: false,
      windowsHide: true
    });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().slice(0, 256);
    return { probe, exitCode: 0, versionText: spec.pattern.test(output) ? output : null };
  } catch (error) {
    const code = record(error).code;
    return { probe, exitCode: typeof code === "number" ? code : 1, versionText: null };
  }
}

async function findExecutable(name: string): Promise<string | null> {
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = resolve(directory, `${name}${extension}`);
      try {
        await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        if ((await stat(candidate)).isFile()) return candidate;
      } catch {
        // Keep searching the fixed PATH supplied by the Memory process.
      }
    }
  }
  return null;
}

function isBinaryPath(value: string): boolean {
  const name = value.split("/").at(-1) ?? value;
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".")).toLowerCase() : "";
  return BINARY_EXTENSIONS.has(extension);
}

function sameFileObservation(left: { size: number; mtimeMs: number; isFile(): boolean }, right: { size: number; mtimeMs: number; isFile(): boolean }): boolean {
  return left.isFile() && right.isFile() && left.size === right.size && floorTime(left.mtimeMs) === floorTime(right.mtimeMs);
}

function inside(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function probeEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    ["PATH", "PATHEXT", "SYSTEMROOT", "SystemRoot", "WINDIR"]
      .flatMap((key) => process.env[key] ? [[key, process.env[key]]] : [])
  );
}

function floorTime(value: number): number {
  return Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function inventorySnapshot(value: InventorySnapshot): string {
  return canonicalJson({
    entries: value.entries.map((entry) => ({ ...entry })),
    omittedCount: value.omittedCount
  });
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
