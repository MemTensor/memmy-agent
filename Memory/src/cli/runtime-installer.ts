import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { chmod, copyFile, cp, mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { loadMemmyConfig } from "../config/index.js";
import { MEMORY_PROTOCOL_VERSION, MEMORY_SERVICE_VERSION } from "../version.js";

const DEFAULT_RELEASES_URL = "https://github.com/MemTensor/memmy-agent/releases";
const INSTALL_LOCK_TIMEOUT_MS = 15_000;
const SERVICE_STOP_TIMEOUT_MS = 5_000;
export const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 120_000;

export interface RuntimeAssetDescriptor { name: string; sha256: string; size?: number; url?: string; }
export interface MemoryReleaseManifest {
  version: string;
  protocolVersion: number;
  assets: Record<string, RuntimeAssetDescriptor>;
}

export interface MemoryRuntimeInstallOptions {
  home?: string;
  version?: string;
  latest?: boolean;
  dryRun?: boolean;
  runtimeAsset?: string;
  /** An unpacked, platform-specific runtime bundled with Memmy Desktop. */
  runtimeDirectory?: string;
  runtimeSha256?: string;
  releaseManifest?: string;
  releaseBaseUrl?: string;
  nodeExecutable?: string;
  skipServiceRegistration?: boolean;
  skipHealthCheck?: boolean;
  /** Maximum time to wait for the newly activated service to report its version. */
  healthCheckTimeoutMs?: number;
  endpoint?: string;
  agents?: string[];
  /** Desktop uses a newer compatible installation instead of replacing it with its bundled copy. */
  preferInstalledCompatible?: boolean;
}

export interface InstalledRuntimePointer {
  version: string;
  protocolVersion: number;
  target: string;
  runtimeDir: string;
  entrypoint: string;
  runtimeExecutable?: string;
  activatedAt: string;
}

export async function installMemoryRuntime(options: MemoryRuntimeInstallOptions = {}): Promise<Record<string, unknown>> {
  const healthCheckTimeoutMs = resolveHealthCheckTimeoutMs(options.healthCheckTimeoutMs);
  const home = resolveHome(options.home ?? "~/.memmy");
  const serviceHome = join(home, "memory-service");
  const runtimeRoot = join(serviceHome, "runtime");
  const target = runtimeTarget(process.platform, process.arch);
  const manifest = await resolveReleaseManifest(options, target);
  const descriptor = manifest.assets[target];
  if (!descriptor) throw new Error(`Memory release ${manifest.version} does not support ${target}`);
  if (manifest.protocolVersion !== MEMORY_PROTOCOL_VERSION) {
    throw new Error(`Memory protocol ${manifest.protocolVersion} is incompatible with installer protocol ${MEMORY_PROTOCOL_VERSION}`);
  }
  const currentPath = join(serviceHome, "current.json");
  const installationPath = join(serviceHome, "installation.json");
  const previous = await readJsonFile<InstalledRuntimePointer>(currentPath);
  const versionComparison = previous ? compareVersions(manifest.version, previous.version) : 1;
  if (previous && options.preferInstalledCompatible && previous.protocolVersion === MEMORY_PROTOCOL_VERSION && versionComparison <= 0) {
    return reuseInstalledRuntime(previous, home, serviceHome, options, healthCheckTimeoutMs);
  }
  if (previous && versionComparison < 0) {
    throw new Error(`refusing to downgrade Memory from ${previous.version} to ${manifest.version}`);
  }
  const runtimeDir = join(runtimeRoot, manifest.version, target);
  const pointer: InstalledRuntimePointer = {
    version: manifest.version,
    protocolVersion: manifest.protocolVersion,
    target,
    runtimeDir,
    entrypoint: join(runtimeDir, "dist", "src", "server", "index.js"),
    runtimeExecutable: options.nodeExecutable ?? process.execPath,
    activatedAt: new Date().toISOString()
  };
  const launcher = launcherPaths(home);
  if (options.dryRun) {
    return { ok: true, dryRun: true, home, serviceHome, target, manifest, pointer, launcher };
  }

  await mkdir(runtimeRoot, { recursive: true });
  const installLock = await acquireInstallLock(join(serviceHome, "install.lock"));
  let stagedPath: string | undefined;
  let installedRuntimeCreated = false;
  try {
    if (!existsSync(pointer.entrypoint)) {
      stagedPath = join(runtimeRoot, `.staging-${process.pid}-${Date.now()}`);
      await mkdir(stagedPath, { recursive: true });
      const unpacked = join(stagedPath, "unpacked");
      if (options.runtimeDirectory) {
        await cp(resolveHome(options.runtimeDirectory), unpacked, { recursive: true });
      } else {
        const archivePath = join(stagedPath, descriptor.name);
        await obtainRuntimeAsset(options, manifest, descriptor, archivePath);
        const digest = await sha256File(archivePath);
        if (digest !== descriptor.sha256.toLowerCase()) {
          throw new Error(`checksum mismatch for ${descriptor.name}: expected ${descriptor.sha256}, received ${digest}`);
        }
        await mkdir(unpacked, { recursive: true });
        extractTarGzip(archivePath, unpacked);
      }
      await validateRuntime(unpacked, manifest.version, target, manifest.protocolVersion);
      await mkdir(dirname(runtimeDir), { recursive: true });
      await rm(runtimeDir, { recursive: true, force: true });
      await rename(unpacked, runtimeDir);
      installedRuntimeCreated = true;
    } else {
      await validateRuntime(runtimeDir, manifest.version, target, manifest.protocolVersion);
    }

    const switching = !previous || previous.runtimeDir !== runtimeDir;
    if (switching && previous && !options.skipServiceRegistration) stopUserService();
    await writeJsonAtomic(currentPath, pointer);
    await writeStableLauncher(home, serviceHome, pointer.runtimeExecutable!);
    if (!options.skipServiceRegistration) registerAndStartUserService(home, serviceHome);

    if (!options.skipHealthCheck) {
      try {
        await waitForRuntimeHealth(
          options.endpoint ?? "http://127.0.0.1:18960",
          manifest.version,
          healthCheckTimeoutMs
        );
      } catch (error) {
        if (!options.skipServiceRegistration && previous) stopUserService();
        if (previous) {
          await writeJsonAtomic(currentPath, previous);
          await writeStableLauncher(home, serviceHome, previous.runtimeExecutable ?? process.execPath);
          if (!options.skipServiceRegistration) registerAndStartUserService(home, serviceHome);
        } else {
          await cleanupFailedFirstInstall({
            currentPath,
            installationPath,
            launcher,
            runtimeDir,
            runtimeCreated: installedRuntimeCreated,
            serviceHome,
            unregisterService: !options.skipServiceRegistration
          });
        }
        throw error;
      }
    }

    await writeJsonAtomic(installationPath, {
      serviceVersion: manifest.version,
      protocolVersion: manifest.protocolVersion,
      target,
      installedAt: new Date().toISOString(),
      agents: options.agents ?? await installedAgents(home),
      releaseSource: options.releaseBaseUrl ?? DEFAULT_RELEASES_URL
    });
    return { ok: true, upgraded: Boolean(previous), previousVersion: previous?.version, ...pointer, launcher };
  } finally {
    if (stagedPath) await rm(stagedPath, { recursive: true, force: true });
    await installLock.release();
  }
}

export async function currentInstalledRuntime(home = "~/.memmy"): Promise<InstalledRuntimePointer | undefined> {
  return readJsonFile<InstalledRuntimePointer>(join(resolveHome(home), "memory-service", "current.json"));
}

export async function installedAgents(home = "~/.memmy"): Promise<string[]> {
  const installation = await readJsonFile<Record<string, unknown>>(
    join(resolveHome(home), "memory-service", "installation.json")
  );
  return Array.isArray(installation?.agents)
    ? installation.agents.filter((agent): agent is string => typeof agent === "string" && agent.length > 0)
    : [];
}

export async function startInstalledMemoryService(home = "~/.memmy"): Promise<Record<string, unknown>> {
  const resolvedHome = resolveHome(home);
  const serviceHome = join(resolvedHome, "memory-service");
  const pointer = await currentInstalledRuntime(resolvedHome);
  if (!pointer) throw new Error("Memory is not installed");
  await validateRuntime(pointer.runtimeDir, pointer.version, pointer.target, pointer.protocolVersion);
  const launcher = launcherPaths(resolvedHome);
  if (!existsSync(launcher.command) || !existsSync(launcher.script)) {
    await writeStableLauncher(resolvedHome, serviceHome, pointer.runtimeExecutable ?? process.execPath);
  }
  registerAndStartUserService(resolvedHome, serviceHome);
  return { ok: true, action: "start", ...pointer };
}

export interface UserServiceRestartCommand {
  command: string;
  args: string[];
}

export function userServiceRestartCommand(
  platform: NodeJS.Platform = process.platform,
  uid = process.getuid?.() ?? 0
): UserServiceRestartCommand {
  if (platform === "darwin") {
    return {
      command: "launchctl",
      args: ["kickstart", "-k", `gui/${uid}/com.memtensor.memmy-memory`]
    };
  }
  if (platform === "linux") {
    return {
      command: "systemctl",
      args: ["--user", "restart", "memmy-memory.service"]
    };
  }
  if (platform === "win32") {
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-Command",
        "Start-Sleep -Milliseconds 250; schtasks.exe /End /TN 'Memmy Memory Service' | Out-Null; Start-Sleep -Seconds 1; schtasks.exe /Run /TN 'Memmy Memory Service' | Out-Null"
      ]
    };
  }
  throw new Error(`unsupported platform: ${platform}`);
}

export function restartInstalledMemoryService(): Promise<void> {
  const restart = userServiceRestartCommand();
  return new Promise((resolveRestart, rejectRestart) => {
    const child = spawn(restart.command, restart.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.once("error", rejectRestart);
    child.once("spawn", () => {
      child.unref();
      resolveRestart();
    });
  });
}

export interface StopInstalledMemoryServiceDependencies {
  stopUserService?: () => void;
  fetch?: typeof fetch;
}

interface MemoryRuntimeState {
  pid?: number;
  endpoint?: string;
  configPath?: string;
}

export async function stopInstalledMemoryService(
  home = "~/.memmy",
  dependencies: StopInstalledMemoryServiceDependencies = {}
): Promise<Record<string, unknown>> {
  const resolvedHome = resolveHome(home);
  const runtimeState = await readJsonFile<MemoryRuntimeState>(
    join(resolvedHome, "memory-service", "runtime.json")
  );
  (dependencies.stopUserService ?? stopUserService)();

  if (!runtimeState?.endpoint) {
    return { ok: true, action: "stop" };
  }

  const endpoint = loopbackEndpoint(runtimeState.endpoint);
  const configPath = runtimeState.configPath ?? join(resolvedHome, "config.yaml");
  const token = loadMemmyConfig(configPath).config.storage.token ?? "";
  const request = dependencies.fetch ?? fetch;
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  const probe = await probeMemoryRuntime(endpoint, headers, request);
  if (probe === "unexpected") {
    throw new Error(`refusing to stop an unexpected service at ${endpoint}`);
  }
  if (probe === "memory") {
    let shutdownError: unknown;
    try {
      const response = await request(`${endpoint}/api/v1/admin/shutdown`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...headers
        },
        body: "{}",
        signal: AbortSignal.timeout(1_000)
      });
      if (!response.ok) {
        throw new Error(`Memory shutdown request failed with HTTP ${response.status}`);
      }
    } catch (error) {
      shutdownError = error;
    }
    const stopped = await waitForMemoryRuntimeStop(endpoint, headers, request);
    if (!stopped) {
      throw shutdownError instanceof Error
        ? shutdownError
        : new Error(`Memory service did not stop at ${endpoint}`);
    }
  }
  return { ok: true, action: "stop", ...(runtimeState.pid ? { pid: runtimeState.pid } : {}) };
}

async function probeMemoryRuntime(
  endpoint: string,
  headers: Record<string, string>,
  request: typeof fetch
): Promise<"stopped" | "memory" | "unexpected"> {
  try {
    const response = await request(`${endpoint}/api/v1/health`, {
      headers,
      signal: AbortSignal.timeout(1_000)
    });
    if (!response.ok) return "unexpected";
    const health = await response.json() as Record<string, unknown>;
    return health.protocolVersion === MEMORY_PROTOCOL_VERSION ? "memory" : "unexpected";
  } catch {
    return "stopped";
  }
}

async function waitForMemoryRuntimeStop(
  endpoint: string,
  headers: Record<string, string>,
  request: typeof fetch
): Promise<boolean> {
  const deadline = Date.now() + SERVICE_STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probeMemoryRuntime(endpoint, headers, request) === "stopped") return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  return false;
}

function loopbackEndpoint(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error(`Memory runtime endpoint must be loopback HTTP: ${value}`);
  }
  return url.href.replace(/\/$/, "");
}

async function reuseInstalledRuntime(
  pointer: InstalledRuntimePointer,
  home: string,
  serviceHome: string,
  options: MemoryRuntimeInstallOptions,
  healthCheckTimeoutMs: number
): Promise<Record<string, unknown>> {
  if (options.dryRun) return { ok: true, reused: true, dryRun: true, ...pointer };
  await validateRuntime(pointer.runtimeDir, pointer.version, pointer.target, pointer.protocolVersion);
  const launcher = launcherPaths(home);
  if (!existsSync(launcher.command) || !existsSync(launcher.script)) {
    await writeStableLauncher(home, serviceHome, pointer.runtimeExecutable ?? options.nodeExecutable ?? process.execPath);
  }
  if (!options.skipServiceRegistration) registerAndStartUserService(home, serviceHome);
  if (!options.skipHealthCheck) {
    await waitForRuntimeHealth(
      options.endpoint ?? "http://127.0.0.1:18960",
      pointer.version,
      healthCheckTimeoutMs
    );
  }
  return { ok: true, reused: true, ...pointer };
}

async function resolveReleaseManifest(
  options: MemoryRuntimeInstallOptions,
  target: string
): Promise<MemoryReleaseManifest> {
  if (options.dryRun && !options.runtimeAsset && !options.releaseManifest) {
    const version = options.version ?? MEMORY_SERVICE_VERSION;
    return {
      version,
      protocolVersion: MEMORY_PROTOCOL_VERSION,
      assets: {
        [target]: {
          name: `memmy-memory-runtime-${version}-${target}.tar.gz`,
          sha256: "0".repeat(64)
        }
      }
    };
  }
  if (options.runtimeAsset) {
    const path = resolveHome(options.runtimeAsset);
    const sha256 = options.runtimeSha256 ?? await sha256File(path);
    return {
      version: options.version ?? MEMORY_SERVICE_VERSION,
      protocolVersion: MEMORY_PROTOCOL_VERSION,
      assets: { [target]: { name: basename(path), sha256, url: pathToFileURL(path).href } }
    };
  }
  if (options.runtimeDirectory) {
    const path = resolveHome(options.runtimeDirectory);
    const metadata = await readJsonFile<Record<string, unknown>>(join(path, "memory-runtime.json"));
    const packageJson = await readJsonFile<Record<string, unknown>>(join(path, "package.json"));
    const version = options.version
      ?? (typeof metadata?.version === "string" ? metadata.version : undefined)
      ?? (typeof packageJson?.version === "string" ? packageJson.version : undefined)
      ?? MEMORY_SERVICE_VERSION;
    const packagedTarget = typeof metadata?.target === "string" ? metadata.target : target;
    const protocolVersion = typeof metadata?.protocolVersion === "number"
      ? metadata.protocolVersion
      : MEMORY_PROTOCOL_VERSION;
    return {
      version,
      protocolVersion,
      assets: {
        [packagedTarget]: {
          name: basename(path),
          sha256: "0".repeat(64),
          url: pathToFileURL(path).href
        }
      }
    };
  }
  const releaseBase = (options.releaseBaseUrl ?? DEFAULT_RELEASES_URL).replace(/\/$/, "");
  const version = options.latest ? undefined : options.version ?? MEMORY_SERVICE_VERSION;
  const manifestUrl = options.releaseManifest
    ? sourceUrl(options.releaseManifest)
    : version
      ? `${releaseBase}/download/memory-v${version}/memory-release.json`
      : `${releaseBase}/latest/download/memory-release.json`;
  const parsed = JSON.parse(await readSourceText(manifestUrl)) as unknown;
  const manifest = parseReleaseManifest(parsed);
  if (options.version && manifest.version !== options.version) {
    throw new Error(`release manifest version ${manifest.version} does not match requested ${options.version}`);
  }
  return manifest;
}

function parseReleaseManifest(value: unknown): MemoryReleaseManifest {
  if (!isRecord(value) || !validVersion(value.version) || !Number.isInteger(value.protocolVersion) || !isRecord(value.assets)) {
    throw new Error("Memory release manifest is invalid");
  }
  const assets: Record<string, RuntimeAssetDescriptor> = {};
  for (const [target, asset] of Object.entries(value.assets)) {
    if (!isRecord(asset) || typeof asset.name !== "string" || !asset.name || typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(asset.sha256)) {
      throw new Error(`Memory release asset is invalid: ${target}`);
    }
    assets[target] = { name: asset.name, sha256: asset.sha256.toLowerCase(), ...(typeof asset.size === "number" ? { size: asset.size } : {}), ...(typeof asset.url === "string" ? { url: asset.url } : {}) };
  }
  return { version: value.version, protocolVersion: value.protocolVersion as number, assets };
}

async function obtainRuntimeAsset(
  options: MemoryRuntimeInstallOptions,
  manifest: MemoryReleaseManifest,
  descriptor: RuntimeAssetDescriptor,
  destination: string
): Promise<void> {
  if (options.runtimeAsset) {
    await copyFile(resolveHome(options.runtimeAsset), destination);
    return;
  }
  let source: string;
  if (descriptor.url) {
    source = sourceUrl(descriptor.url);
  } else if (options.releaseManifest && sourceUrl(options.releaseManifest).startsWith("file:")) {
    source = new URL(descriptor.name, sourceUrl(options.releaseManifest)).href;
  } else {
    const releaseBase = (options.releaseBaseUrl ?? DEFAULT_RELEASES_URL).replace(/\/$/, "");
    source = options.latest
      ? `${releaseBase}/latest/download/${descriptor.name}`
      : `${releaseBase}/download/memory-v${manifest.version}/${descriptor.name}`;
  }
  await downloadSource(source, destination);
}

async function downloadSource(source: string, destination: string): Promise<void> {
  if (source.startsWith("file:")) {
    await copyFile(fileURLToPath(source), destination);
    return;
  }
  const response = await fetch(source, { redirect: "follow", headers: { "user-agent": `memmy-memory/${MEMORY_SERVICE_VERSION}` } });
  if (!response.ok || !response.body) throw new Error(`failed to download ${source}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  await writeFile(destination, bytes, { mode: 0o600 });
}

async function readSourceText(source: string): Promise<string> {
  if (source.startsWith("file:")) return readFile(fileURLToPath(source), "utf8");
  const response = await fetch(source, { redirect: "follow", headers: { "user-agent": `memmy-memory/${MEMORY_SERVICE_VERSION}` } });
  if (!response.ok) throw new Error(`failed to download ${source}: HTTP ${response.status}`);
  return response.text();
}

function sourceUrl(value: string): string {
  if (/^https?:\/\//.test(value) || value.startsWith("file:")) return value;
  return pathToFileURL(resolveHome(value)).href;
}

async function validateRuntime(path: string, version: string, target: string, protocolVersion: number): Promise<void> {
  const manifest = await readJsonFile<Record<string, unknown>>(join(path, "memory-runtime.json"));
  if (!manifest || manifest.version !== version || manifest.target !== target || manifest.protocolVersion !== protocolVersion) {
    throw new Error(`Memory runtime metadata is invalid for ${version}-${target}`);
  }
  const entrypoint = join(path, "dist", "src", "server", "index.js");
  if (!existsSync(entrypoint)) throw new Error(`Memory runtime entrypoint is missing: ${entrypoint}`);
}

function extractTarGzip(archivePath: string, destination: string): void {
  const result = spawnSync("tar", ["-xzf", archivePath, "-C", destination], { stdio: "pipe" });
  if (result.status !== 0) {
    throw new Error(`failed to extract Memory runtime: ${result.stderr?.toString().trim() || "tar failed"}`);
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolveHash, rejectHash) => {
    const input = createReadStream(path);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", resolveHash);
    input.on("error", rejectHash);
  });
  return hash.digest("hex");
}
function launcherPaths(home: string): { command: string; script: string } {
  const bin = join(home, "bin");
  return process.platform === "win32"
    ? { command: join(bin, "memmy-memory-service.cmd"), script: join(bin, "memmy-memory-service.cjs") }
    : { command: join(bin, "memmy-memory-service"), script: join(bin, "memmy-memory-service.cjs") };
}

async function writeStableLauncher(home: string, serviceHome: string, nodeExecutable: string): Promise<void> {
  const paths = launcherPaths(home);
  await mkdir(dirname(paths.script), { recursive: true });
  const script = [
    "\"use strict\";",
    "const { readFileSync } = require(\"node:fs\");",
    "const { spawn } = require(\"node:child_process\");",
    `const pointer = JSON.parse(readFileSync(${JSON.stringify(join(serviceHome, "current.json"))}, "utf8"));`,
    "const path = require(\"node:path\");",
    `const env = { ...process.env, MEMMY_HOME: ${JSON.stringify(home)}, MEMMY_CONFIG: ${JSON.stringify(join(home, "config.yaml"))}, MEMMY_EMBEDDING_MODEL_ROOT: path.join(pointer.runtimeDir, "embedding-models") };`,
    "const child = spawn(process.execPath, [pointer.entrypoint, ...process.argv.slice(2)], { stdio: \"inherit\", windowsHide: false, env });",
    "child.once(\"error\", (error) => { console.error(error.message); process.exit(1); });",
    "child.once(\"exit\", (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exit(code ?? 0); });",
    ""
  ].join("\n");
  await writeFile(paths.script, script, { encoding: "utf8", mode: 0o700 });
  if (process.platform === "win32") {
    await writeFile(paths.command, `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${nodeExecutable}" "${paths.script}" %*\r\n`, "utf8");
  } else {
    await writeFile(paths.command, `#!/bin/sh\nexec env ELECTRON_RUN_AS_NODE=1 ${shellQuote(nodeExecutable)} ${shellQuote(paths.script)} "$@"\n`, { encoding: "utf8", mode: 0o700 });
    await chmod(paths.command, 0o700);
  }
}

function registerAndStartUserService(home: string, serviceHome: string): void {
  const launcher = launcherPaths(home).command;
  const logs = join(serviceHome, "logs");
  mkdirSyncForLifecycle(logs);
  if (process.platform === "darwin") {
    const plistPath = join(homedir(), "Library", "LaunchAgents", "com.memtensor.memmy-memory.plist");
    mkdirSyncForLifecycle(dirname(plistPath));
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.memtensor.memmy-memory</string>
<key>ProgramArguments</key><array><string>${xmlEscape(launcher)}</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${xmlEscape(join(logs, "service.log"))}</string>
<key>StandardErrorPath</key><string>${xmlEscape(join(logs, "service-error.log"))}</string>
</dict></plist>\n`;
    writeFileSyncForLifecycle(plistPath, plist);
    runLifecycle("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}/com.memtensor.memmy-memory`], true);
    runLifecycle("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 0}`, plistPath]);
    runLifecycle("launchctl", ["enable", `gui/${process.getuid?.() ?? 0}/com.memtensor.memmy-memory`]);
    runLifecycle("launchctl", ["kickstart", "-k", `gui/${process.getuid?.() ?? 0}/com.memtensor.memmy-memory`]);
    return;
  }
  if (process.platform === "linux") {
    const unitPath = join(homedir(), ".config", "systemd", "user", "memmy-memory.service");
    mkdirSyncForLifecycle(dirname(unitPath));
    writeFileSyncForLifecycle(unitPath, `[Unit]\nDescription=Memmy Memory Service\nAfter=network.target\n\n[Service]\nType=simple\nExecStart=${systemdEscape(launcher)}\nRestart=on-failure\nRestartSec=2\nStandardOutput=append:${join(logs, "service.log")}\nStandardError=append:${join(logs, "service-error.log")}\n\n[Install]\nWantedBy=default.target\n`);
    runLifecycle("systemctl", ["--user", "daemon-reload"]);
    runLifecycle("systemctl", ["--user", "enable", "--now", "memmy-memory.service"]);
    return;
  }
  if (process.platform === "win32") {
    runLifecycle("schtasks", ["/Create", "/TN", "Memmy Memory Service", "/TR", `\"${launcher}\"`, "/SC", "ONLOGON", "/F"]);
    runLifecycle("schtasks", ["/Run", "/TN", "Memmy Memory Service"]);
    return;
  }
  throw new Error(`unsupported platform: ${process.platform}`);
}

function stopUserService(): void {
  if (process.platform === "darwin") {
    runLifecycle("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}/com.memtensor.memmy-memory`], true);
  } else if (process.platform === "linux") {
    runLifecycle("systemctl", ["--user", "stop", "memmy-memory.service"], true);
  } else if (process.platform === "win32") {
    runLifecycle("schtasks", ["/End", "/TN", "Memmy Memory Service"], true);
  }
}

function runLifecycle(command: string, args: string[], allowFailure = false): void {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr?.trim() || result.stdout?.trim() || result.error?.message || "unknown error"}`);
  }
}

async function waitForRuntimeHealth(
  endpoint: string,
  expectedVersion: string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "service did not respond";
  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    const requestTimeoutMs = Math.max(1, Math.min(1_000, remainingMs));
    try {
      const response = await fetch(`${endpoint.replace(/\/$/, "")}/api/v1/health`, { signal: AbortSignal.timeout(requestTimeoutMs) });
      if (response.ok) {
        const health = await response.json() as Record<string, unknown>;
        if (
          health.ok === true
          && health.protocolVersion === MEMORY_PROTOCOL_VERSION
          && (health.serviceVersion === expectedVersion || health.version === expectedVersion)
        ) return;
        if (health.protocolVersion !== MEMORY_PROTOCOL_VERSION) {
          lastError = `service reported protocol ${String(health.protocolVersion)}`;
        } else {
          lastError = `service reported version ${String(health.serviceVersion ?? health.version)}`;
        }
      } else {
        lastError = `health returned HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    const delayMs = Math.min(250, Math.max(0, deadline - Date.now()));
    if (delayMs <= 0) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
  }
  throw new Error(`Memory ${expectedVersion} failed its activation health check: ${lastError}`);
}

async function cleanupFailedFirstInstall(input: {
  currentPath: string;
  installationPath: string;
  launcher: { command: string; script: string };
  runtimeDir: string;
  runtimeCreated: boolean;
  serviceHome: string;
  unregisterService: boolean;
}): Promise<void> {
  if (input.unregisterService) {
    await removeUserServiceRegistration();
  }
  await Promise.all([
    rm(input.currentPath, { force: true }).catch(() => undefined),
    rm(input.launcher.command, { force: true }).catch(() => undefined),
    rm(input.launcher.script, { force: true }).catch(() => undefined),
    rm(input.installationPath, { force: true }).catch(() => undefined),
    rm(join(input.serviceHome, "runtime.json"), { force: true }).catch(() => undefined),
    ...(input.runtimeCreated
      ? [rm(input.runtimeDir, { recursive: true, force: true }).catch(() => undefined)]
      : [])
  ]);
}

async function removeUserServiceRegistration(): Promise<void> {
  if (process.platform === "darwin") {
    runLifecycle("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}/com.memtensor.memmy-memory`], true);
    await rm(join(homedir(), "Library", "LaunchAgents", "com.memtensor.memmy-memory.plist"), { force: true }).catch(() => undefined);
    return;
  }
  if (process.platform === "linux") {
    runLifecycle("systemctl", ["--user", "disable", "--now", "memmy-memory.service"], true);
    await rm(join(homedir(), ".config", "systemd", "user", "memmy-memory.service"), { force: true }).catch(() => undefined);
    runLifecycle("systemctl", ["--user", "daemon-reload"], true);
    return;
  }
  if (process.platform === "win32") {
    runLifecycle("schtasks", ["/End", "/TN", "Memmy Memory Service"], true);
    runLifecycle("schtasks", ["/Delete", "/TN", "Memmy Memory Service", "/F"], true);
  }
}

function resolveHealthCheckTimeoutMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_HEALTH_CHECK_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("healthCheckTimeoutMs must be a positive integer");
  }
  return value;
}
async function acquireInstallLock(path: string): Promise<{ release(): Promise<void> }> {
  await mkdir(dirname(path), { recursive: true });
  const startedAt = Date.now();
  for (;;) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`, "utf8");
      return { async release() { await handle.close(); await unlink(path).catch(() => undefined); } };
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      if (Date.now() - startedAt > INSTALL_LOCK_TIMEOUT_MS) throw new Error(`timed out waiting for installer lock: ${path}`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

async function readJsonFile<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (error) { if (isNodeError(error) && error.code === "ENOENT") return undefined; throw error; }
}

export function runtimeTarget(platform: NodeJS.Platform, arch: string): string {
  const platformName = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : platform === "win32" ? "windows" : undefined;
  const archName = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : undefined;
  if (!platformName || !archName) throw new Error(`unsupported platform: ${platform}-${arch}`);
  return `${platformName}-${archName}`;
}

export function compareVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
    if (!match) throw new Error(`invalid semantic version: ${value}`);
    return { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] };
  };
  const a = parse(left); const b = parse(right);
  for (let index = 0; index < 3; index += 1) { const delta = a.numbers[index]! - b.numbers[index]!; if (delta !== 0) return Math.sign(delta); }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease);
}

function validVersion(value: unknown): value is string { return typeof value === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value); }
function resolveHome(value: string): string { return resolve(value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isNodeError(error: unknown): error is NodeJS.ErrnoException { return error instanceof Error && "code" in error; }
function shellQuote(value: string): string { return "'" + value.replace(/'/g, "'\\''") + "'"; }
function systemdEscape(value: string): string { return value.replace(/([\\"\s])/g, "\\$1"); }
function xmlEscape(value: string): string { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function mkdirSyncForLifecycle(path: string): void { mkdirSync(path, { recursive: true }); }
function writeFileSyncForLifecycle(path: string, value: string): void { writeFileSync(path, value, { encoding: "utf8", mode: 0o600 }); }
