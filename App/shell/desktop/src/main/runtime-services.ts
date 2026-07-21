import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import YAML from "yaml";
import { createRotatingWriter, type RotatingWriter } from "./rotating-log-file.js";
import type { LogLevel } from "./log-level.js";

const LOCAL_HOST = "127.0.0.1";
const DEFAULT_MEMORY_URL = "http://127.0.0.1:18960";
const DEFAULT_AGENT_GATEWAY_HEALTH_PORT = 18970;
const DEFAULT_AGENT_WEBSOCKET_PORT = 18980;
const STARTUP_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;
const HTTP_TIMEOUT_MS = 1_000;
const STOP_MANAGED_CHILD_GRACE_MS = 1_000;

type RuntimeEnv = Record<string, string | undefined>;
type ConfigRecord = Record<string, unknown>;

export interface PackagedRuntimeServices {
  memory: {
    baseUrl: string;
    token: string;
    databasePath: string;
    configPath: string;
  };
  agentGateway: {
    baseUrl: string;
    bootstrapSecret: string;
    configPath: string;
  };
  restartMemory(): Promise<void>;
  close(): Promise<void>;
  terminateSync(): void;
}

export interface StartPackagedRuntimeServicesOptions {
  appPath: string;
  resourcesPath: string;
  logDirectory: string;
  logLevel: LogLevel;
}

export interface PreparePackagedRuntimeConfigOptions {
  env?: RuntimeEnv;
  secretFactory?: () => string;
  fillMissingAgentSecret?: boolean;
  writeConfig?: boolean;
  ensureDirectories?: boolean;
}

interface RuntimeEntryPaths {
  memoryEntry: string;
  agentEntry: string;
}

interface PackagedRuntimeConfig {
  configPath: string;
  agentWorkspace: string;
  memoryDatabasePath: string;
  memoryBaseUrl: string;
  memoryToken: string;
  memoryListenHost: string;
  memoryListenPort: number;
  agentGatewayBaseUrl: string;
  agentGatewayHealthHost: string;
  agentGatewayHealthPort: number;
  agentGatewayBootstrapSecret: string;
}

interface ManagedChild {
  name: string;
  process: ChildProcess;
  stdoutTail: string[];
  stderrTail: string[];
  exitDescription: string | null;
  logWriter: RotatingWriter | null;
}

interface ServiceLogOptions {
  logFilePath: string;
  logLevel: LogLevel;
}

const DAEMON_LOG_MAX_SIZE = 5 * 1024 * 1024;

const DAEMON_LOG_MAX_FILES = 5;

type HttpProbeResult = "ready" | "unreachable" | "unexpected";

export async function startPackagedRuntimeServices(
  options: StartPackagedRuntimeServicesOptions
): Promise<PackagedRuntimeServices> {
  const entries = resolveRuntimeEntryPaths(options);
  const runtimeConfig = await preparePackagedRuntimeConfig();
  const children: ManagedChild[] = [];
  let memoryRestart: Promise<void> | null = null;
  let closing = false;

  try {
    await syncBundledAgentSkills({
      agentEntry: entries.agentEntry,
      agentWorkspace: runtimeConfig.agentWorkspace
    });
    await ensureMemoryService(entries, runtimeConfig, children, options);
    await ensureAgentGateway(entries, runtimeConfig, children, options);

    return {
      memory: {
        baseUrl: runtimeConfig.memoryBaseUrl,
        token: runtimeConfig.memoryToken,
        databasePath: runtimeConfig.memoryDatabasePath,
        configPath: runtimeConfig.configPath
      },
      agentGateway: {
        baseUrl: runtimeConfig.agentGatewayBaseUrl,
        bootstrapSecret: runtimeConfig.agentGatewayBootstrapSecret,
        configPath: runtimeConfig.configPath
      },
      async restartMemory() {
        if (closing) {
          throw new Error("Memmy is shutting down");
        }
        if (!memoryRestart) {
          memoryRestart = restartManagedMemoryService(entries, runtimeConfig, children, options)
            .finally(() => {
              memoryRestart = null;
            });
        }
        await memoryRestart;
      },
      async close() {
        closing = true;
        await memoryRestart?.catch(() => undefined);
        await stopManagedChildren(children);
      },
      terminateSync() {
        terminateManagedChildrenSync(children);
      }
    };
  } catch (error) {
    await stopManagedChildren(children);
    throw error;
  }
}

export async function preparePackagedRuntimeConfig(
  options: PreparePackagedRuntimeConfigOptions = {}
): Promise<PackagedRuntimeConfig> {
  const env = options.env ?? process.env;
  const shouldWriteConfig = options.writeConfig ?? true;
  const shouldEnsureDirectories = options.ensureDirectories ?? true;
  const shouldFillMissingAgentSecret = options.fillMissingAgentSecret ?? true;
  const memmyHome = resolvePath(env.MEMMY_HOME ?? "~/.memmy");
  const configPath = resolvePath(env.MEMMY_CONFIG ?? join(memmyHome, "config.yaml"));
  const config = await readConfig(configPath);
  const secretFactory = options.secretFactory ?? createPersistentSecret;

  const memmyMemory = ensureRecord(config, "memmyMemory");
  const storage = ensureRecord(memmyMemory, "storage");
  const channels = ensureRecord(config, "channels");
  const websocket = ensureRecord(channels, "websocket");
  const gateway = ensureRecord(config, "gateway");
  const heartbeat = ensureRecord(gateway, "heartbeat");
  const agents = ensureRecord(config, "agents");
  const defaults = ensureRecord(agents, "defaults");

  let changed = false;
  changed = repairMemoryActiveProfile(memmyMemory) || changed;
  const defaultWorkspace = join(memmyHome, "workspace");
  const configuredWorkspace = stringValue(defaults.workspace);
  const agentWorkspace = resolvePath(env.MEMMY_AGENT_WORKSPACE ?? configuredWorkspace ?? defaultWorkspace);
  const memoryDatabasePath = resolvePath(
    env.MEMMY_MEMORY_DB ??
      env.MEMORY_SERVICE_DB ??
      stringValue(storage.sqlitePath) ??
      join(memmyHome, "memory-service", "memory.sqlite")
  );

  changed = setMissing(storage, "mode", "local") || changed;
  changed = setMissing(storage, "backend", "sqlite") || changed;
  changed = setMissing(storage, "sqlitePath", memoryDatabasePath) || changed;
  changed = setMissing(storage, "endpoint", DEFAULT_MEMORY_URL) || changed;
  changed = setMissing(websocket, "host", LOCAL_HOST) || changed;
  changed = setMissing(websocket, "port", DEFAULT_AGENT_WEBSOCKET_PORT) || changed;
  if (shouldFillMissingAgentSecret && !stringValue(websocket.tokenIssueSecret) && !stringValue(websocket.token)) {
    websocket.tokenIssueSecret = secretFactory();
    changed = true;
  }
  changed = setMissing(websocket, "tokenTtlS", 86_400) || changed;
  changed = setMissing(websocket, "websocketRequiresToken", true) || changed;
  changed = setMissing(websocket, "allowFrom", ["*"]) || changed;
  if (websocket.enabled !== true) {
    websocket.enabled = true;
    changed = true;
  }
  changed = setMissing(gateway, "host", LOCAL_HOST) || changed;
  changed = setMissing(gateway, "port", DEFAULT_AGENT_GATEWAY_HEALTH_PORT) || changed;
  changed = setMissing(heartbeat, "enabled", false) || changed;
  changed = setMissing(defaults, "workspace", agentWorkspace) || changed;
  changed = setMissing(defaults, "model", "custom/memmy-desktop") || changed;
  changed = setMissing(defaults, "provider", "custom") || changed;

  if (shouldWriteConfig && (changed || !existsSync(configPath))) {
    await writeConfig(configPath, config);
  }
  if (shouldEnsureDirectories) {
    await Promise.all([
      mkdir(agentWorkspace, { recursive: true }),
      mkdir(dirname(memoryDatabasePath), { recursive: true })
    ]);
  }

  const memoryEndpoint = stringValue(env.MEMMY_MEMORY_URL) ??
    stringValue(env.MEMORY_SERVICE_URL) ??
    stringValue(storage.endpoint) ??
    DEFAULT_MEMORY_URL;
  const memoryUrl = parseHttpUrl(memoryEndpoint, "Memory endpoint");
  const memoryToken = stringValue(env.MEMMY_MEMORY_TOKEN) ??
    stringValue(env.MEMORY_SERVICE_TOKEN) ??
    stringValue(storage.token) ??
    "";
  const agentWebsocketHost = stringValue(websocket.host) ?? LOCAL_HOST;
  const agentWebsocketPort = numberValue(websocket.port) ?? DEFAULT_AGENT_WEBSOCKET_PORT;
  const gatewayHealthHost = stringValue(gateway.host) ?? LOCAL_HOST;
  const gatewayHealthPort = numberValue(gateway.port) ?? DEFAULT_AGENT_GATEWAY_HEALTH_PORT;
  const agentGatewayBootstrapSecret = stringValue(websocket.tokenIssueSecret) ?? stringValue(websocket.token) ?? "";

  return {
    configPath,
    agentWorkspace,
    memoryDatabasePath,
    memoryBaseUrl: normalizeBaseUrl(memoryUrl),
    memoryToken,
    memoryListenHost: listenHostFromUrl(memoryUrl),
    memoryListenPort: listenPortFromUrl(memoryUrl),
    agentGatewayBaseUrl: `http://${clientHost(agentWebsocketHost)}:${agentWebsocketPort}`,
    agentGatewayHealthHost: gatewayHealthHost,
    agentGatewayHealthPort: gatewayHealthPort,
    agentGatewayBootstrapSecret
  };
}

export async function resolveAgentGatewayRuntimeConfig(): Promise<{
  baseUrl: string;
  bootstrapSecret: string;
}> {
  const runtimeConfig = await preparePackagedRuntimeConfig({
    ensureDirectories: false,
    fillMissingAgentSecret: false,
    secretFactory: () => "",
    writeConfig: false
  });
  return {
    baseUrl: runtimeConfig.agentGatewayBaseUrl,
    bootstrapSecret: runtimeConfig.agentGatewayBootstrapSecret
  };
}

export async function syncBundledAgentSkills(options: {
  agentEntry: string;
  agentWorkspace: string;
}): Promise<void> {
  const bundledSkillsDirectory = join(dirname(options.agentEntry), "skills");
  const workspaceSkillsDirectory = join(options.agentWorkspace, "skills");

  await copyDirectoryContents(bundledSkillsDirectory, workspaceSkillsDirectory);
}

async function copyDirectoryContents(sourceDirectory: string, targetDirectory: string): Promise<void> {
  await mkdir(targetDirectory, { recursive: true });

  const entries = await readdir(sourceDirectory, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = join(sourceDirectory, entry.name);
    const targetPath = join(targetDirectory, entry.name);

    if (entry.isDirectory()) {
      await copyDirectoryContents(sourcePath, targetPath);
      continue;
    }

    if (entry.isFile()) {
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, await readFile(sourcePath));
    }
  }
}

async function ensureMemoryService(
  entries: RuntimeEntryPaths,
  runtimeConfig: PackagedRuntimeConfig,
  children: ManagedChild[],
  options: StartPackagedRuntimeServicesOptions
): Promise<void> {
  const healthUrl = `${runtimeConfig.memoryBaseUrl}/api/v1/health`;
  const healthHeaders = memoryAuthHeaders(runtimeConfig.memoryToken);
  const probe = await probeHttpService(healthUrl, healthHeaders);
  if (probe === "ready") {
    return;
  }
  if (probe === "unexpected") {
    throw new Error(`Memory endpoint is occupied by an unexpected service: ${healthUrl}`);
  }

  const memoryChild = spawnNodeService("memory", entries.memoryEntry, [
    "--config",
    runtimeConfig.configPath,
    "--host",
    runtimeConfig.memoryListenHost,
    "--port",
    String(runtimeConfig.memoryListenPort),
    "--db",
    runtimeConfig.memoryDatabasePath
  ], {
    MEMMY_CONFIG: runtimeConfig.configPath,
    MEMMY_MEMORY_URL: runtimeConfig.memoryBaseUrl,
    MEMMY_MEMORY_TOKEN: runtimeConfig.memoryToken,
    MEMMY_MEMORY_DB: runtimeConfig.memoryDatabasePath,
    MEMORY_SERVICE_URL: runtimeConfig.memoryBaseUrl,
    MEMORY_SERVICE_TOKEN: runtimeConfig.memoryToken,
    MEMORY_SERVICE_DB: runtimeConfig.memoryDatabasePath
  }, {
    logFilePath: join(options.logDirectory, "memory.log"),
    logLevel: options.logLevel
  });
  children.push(memoryChild);
  await waitForHttpService("memory", healthUrl, memoryChild, healthHeaders);
}

async function restartManagedMemoryService(
  entries: RuntimeEntryPaths,
  runtimeConfig: PackagedRuntimeConfig,
  children: ManagedChild[],
  options: StartPackagedRuntimeServicesOptions
): Promise<void> {
  const healthUrl = `${runtimeConfig.memoryBaseUrl}/api/v1/health`;
  const healthHeaders = memoryAuthHeaders(runtimeConfig.memoryToken);
  const managedMemory = children.filter((child) => child.name === "memory" && isManagedChildRunning(child));

  if (managedMemory.length > 0) {
    await Promise.all(managedMemory.map((child) => stopManagedChild(child)));
  } else {
    const probe = await probeHttpService(healthUrl, healthHeaders);
    if (probe === "ready") {
      await requestMemoryServiceShutdown({
        baseUrl: runtimeConfig.memoryBaseUrl,
        token: runtimeConfig.memoryToken
      });
    } else if (probe === "unexpected") {
      throw new Error(`Memory endpoint is occupied by an unexpected service: ${healthUrl}`);
    }
  }

  removeManagedChildrenByName(children, "memory");
  await waitForHttpServiceStop(healthUrl, healthHeaders);
  await ensureMemoryService(entries, runtimeConfig, children, options);
}

export async function restartExternalMemoryService(input: {
  baseUrl: string;
  token: string;
}): Promise<void> {
  const baseUrl = normalizeBaseUrl(parseHttpUrl(input.baseUrl, "Memory service URL"));
  const healthUrl = `${baseUrl}/api/v1/health`;
  const healthHeaders = memoryAuthHeaders(input.token);
  const probe = await probeHttpService(healthUrl, healthHeaders);
  if (probe !== "ready") {
    throw new Error(probe === "unexpected"
      ? `Memory endpoint returned an unexpected response: ${healthUrl}`
      : `Memory service is not running: ${healthUrl}`);
  }

  await requestMemoryServiceShutdown(input);
  await waitForHttpServiceStop(healthUrl, healthHeaders);
  await waitForHttpServiceReady("memory", healthUrl, healthHeaders);
}

async function requestMemoryServiceShutdown(input: { baseUrl: string; token: string }): Promise<void> {
  const baseUrl = normalizeBaseUrl(parseHttpUrl(input.baseUrl, "Memory service URL"));
  const response = await fetch(`${baseUrl}/api/v1/admin/shutdown`, {
    method: "POST",
    cache: "no-store",
    headers: {
      "content-type": "application/json",
      ...memoryAuthHeaders(input.token)
    },
    body: "{}",
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
  });
  if (!response.ok) {
    const body = (await response.text()).trim();
    throw new Error(`Memory restart request failed with HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ""}`);
  }
}

async function ensureAgentGateway(
  entries: RuntimeEntryPaths,
  runtimeConfig: PackagedRuntimeConfig,
  children: ManagedChild[],
  options: StartPackagedRuntimeServicesOptions
): Promise<void> {
  const bootstrapUrl = `${runtimeConfig.agentGatewayBaseUrl}/webui/bootstrap`;
  const bootstrapHeaders: Record<string, string> = runtimeConfig.agentGatewayBootstrapSecret
    ? { "x-memmy-agent-auth": runtimeConfig.agentGatewayBootstrapSecret }
    : {};
  const probe = await probeHttpService(bootstrapUrl, bootstrapHeaders);
  if (probe === "ready") {
    return;
  }
  if (probe === "unexpected") {
    throw new Error(`Agent gateway endpoint is occupied by an unexpected service: ${bootstrapUrl}`);
  }

  const agentChild = spawnNodeService("agent-gateway", entries.agentEntry, [
    "gateway",
    "--config",
    runtimeConfig.configPath,
    "--workspace",
    runtimeConfig.agentWorkspace,
    "--host",
    runtimeConfig.agentGatewayHealthHost,
    "--port",
    String(runtimeConfig.agentGatewayHealthPort)
  ], {
    MEMMY_CONFIG: runtimeConfig.configPath,
    MEMMY_AGENT_WORKSPACE: runtimeConfig.agentWorkspace,
    MEMMY_MEMORY_URL: runtimeConfig.memoryBaseUrl,
    MEMMY_MEMORY_TOKEN: runtimeConfig.memoryToken,
    MEMORY_SERVICE_URL: runtimeConfig.memoryBaseUrl,
    MEMORY_SERVICE_TOKEN: runtimeConfig.memoryToken
  }, {
    logFilePath: join(options.logDirectory, "agent-gateway.log"),
    logLevel: options.logLevel
  });
  children.push(agentChild);
  await waitForHttpService("agent-gateway", bootstrapUrl, agentChild, bootstrapHeaders);
}

function resolveRuntimeEntryPaths(options: StartPackagedRuntimeServicesOptions): RuntimeEntryPaths {
  void options.resourcesPath;
  return {
    memoryEntry: join(options.appPath, "dist/runtime/memory/src/server/index.js"),
    agentEntry: join(options.appPath, "dist/runtime/memmy-agent/dist/main.js")
  };
}

export function spawnNodeService(
  name: string,
  entry: string,
  args: string[],
  env: Record<string, string>,
  logOptions: ServiceLogOptions
): ManagedChild {
  if (!existsSync(entry)) {
    throw new Error(`Missing ${name} runtime entry: ${entry}`);
  }

  const childEnv: Record<string, string> = {
    ...process.env,
    ...env,
    MEMMY_LOG_LEVEL: logOptions.logLevel,
    ELECTRON_RUN_AS_NODE: "1",
    NODE_ENV: process.env.NODE_ENV ?? "production"
  };
  const child = spawn(process.execPath, [entry, ...args], {
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  const logWriter = createRotatingWriter({
    filePath: logOptions.logFilePath,
    maxSize: DAEMON_LOG_MAX_SIZE,
    maxFiles: DAEMON_LOG_MAX_FILES
  });
  const managed: ManagedChild = {
    name,
    process: child,
    stdoutTail: [],
    stderrTail: [],
    exitDescription: null,
    logWriter
  };

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    const text = String(chunk);
    appendTail(managed.stdoutTail, text);
    logWriter.write(text);
  });
  child.stderr?.on("data", (chunk) => {
    const text = String(chunk);
    appendTail(managed.stderrTail, text);
    logWriter.write(text);
  });
  child.once("exit", (code, signal) => {
    managed.exitDescription = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
    managed.logWriter?.close();
  });

  return managed;
}

async function probeHttpService(url: string, headers: Record<string, string> = {}): Promise<HttpProbeResult> {
  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
    });
    return response.ok ? "ready" : "unexpected";
  } catch {
    return "unreachable";
  }
}

async function waitForHttpServiceStop(url: string, headers: Record<string, string> = {}): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probeHttpService(url, headers) === "unreachable") {
      return;
    }
    await sleep(50);
  }
  throw new Error(`Memory service did not stop at ${url}`);
}

async function waitForHttpServiceReady(
  name: string,
  url: string,
  headers: Record<string, string> = {}
): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastProbe: HttpProbeResult = "unreachable";
  while (Date.now() < deadline) {
    lastProbe = await probeHttpService(url, headers);
    if (lastProbe === "ready") {
      return;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`${name} did not restart at ${url} (last probe: ${lastProbe})`);
}

async function waitForHttpService(
  name: string,
  url: string,
  child: ManagedChild,
  headers: Record<string, string> = {}
): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastError: unknown;

  while (Date.now() < deadline) {
    if (child.exitDescription) {
      throw new Error(`${name} exited before it became ready (${child.exitDescription}). ${formatChildTail(child)}`);
    }

    try {
      const response = await fetch(url, {
        cache: "no-store",
        headers,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
      });
      if (response.ok) {
        return;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`${name} did not become ready at ${url}: ${errorMessage(lastError)}. ${formatChildTail(child)}`);
}

async function stopManagedChildren(children: ManagedChild[]): Promise<void> {
  await Promise.allSettled([...children].reverse().map((child) => stopManagedChild(child)));
}

function isManagedChildRunning(child: ManagedChild): boolean {
  return !child.exitDescription && child.process.exitCode === null && child.process.signalCode === null;
}

function removeManagedChildrenByName(children: ManagedChild[], name: string): void {
  for (let index = children.length - 1; index >= 0; index -= 1) {
    if (children[index]?.name === name) {
      children.splice(index, 1);
    }
  }
}

function memoryAuthHeaders(token: string): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

/**
 * Synchronously, best-effort terminates all child service processes.
 *
 * On Windows, child.kill does not take down the whole process tree, so we use
 * `taskkill /T` to kill the descendants as well, ensuring memory / agent-gateway
 * release their fixed ports; other platforms use SIGKILL. All failures are ignored.
 *
 * @param children List of managed child processes.
 */
function terminateManagedChildrenSync(children: ManagedChild[]): void {
  for (const child of children) {
    const pid = child.process.pid;
    if (pid === undefined || child.process.exitCode !== null || child.process.signalCode !== null) {
      continue;
    }

    try {
      if (process.platform === "win32") {
        execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
      } else {
        child.process.kill("SIGKILL");
      }
    } catch {
      // Fallback cleanup: the process may already have exited or we may lack permission; just ignore.
    }
  }
}

async function stopManagedChild(child: ManagedChild): Promise<void> {
  if (child.exitDescription || child.process.exitCode !== null || child.process.signalCode !== null) {
    return;
  }

  // Windows: child.kill only terminates the direct child; if memory / agent-gateway spawned a
  // worker (grandchild), it survives, keeps holding the fixed service ports and locking
  // Memmy.exe, causing EADDRINUSE on the next launch and blocking silent updates from installing.
  // Use taskkill /T to kill the entire process tree.
  if (process.platform === "win32") {
    const pid = child.process.pid;
    if (pid !== undefined) {
      try {
        execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
      } catch {
        // The process may already have exited or we may lack permission; ignore.
      }
    }
    return;
  }

  child.process.kill();
  await Promise.race([
    new Promise<void>((resolveStop) => child.process.once("exit", () => resolveStop())),
    sleep(STOP_MANAGED_CHILD_GRACE_MS).then(() => {
      if (!child.exitDescription && child.process.exitCode === null && child.process.signalCode === null) {
        child.process.kill("SIGKILL");
      }
    })
  ]);
}

async function readConfig(configPath: string): Promise<ConfigRecord> {
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = raw.trim() ? YAML.parse(raw) : {};
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    if (isMissingFileError(error)) {
      return {};
    }
    throw error;
  }
}

async function writeConfig(configPath: string, config: ConfigRecord): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, YAML.stringify(config), "utf8");
}

function ensureRecord(parent: ConfigRecord, key: string): ConfigRecord {
  const value = parent[key];
  if (isRecord(value)) {
    return value;
  }
  const next: ConfigRecord = {};
  parent[key] = next;
  return next;
}

function setMissing(record: ConfigRecord, key: string, value: unknown): boolean {
  if (record[key] !== undefined && record[key] !== null) {
    return false;
  }
  record[key] = value;
  return true;
}

function repairMemoryActiveProfile(memmyMemory: ConfigRecord): boolean {
  const profiles = isRecord(memmyMemory.profiles) ? memmyMemory.profiles : null;
  if (!profiles || memoryProfileName(memmyMemory.activeProfile)) {
    return false;
  }

  const fallbackProfile = isRecord(profiles.byok)
    ? "byok"
    : isRecord(profiles.account)
      ? "account"
      : undefined;
  if (!fallbackProfile) {
    return false;
  }

  memmyMemory.activeProfile = fallbackProfile;
  return true;
}

function memoryProfileName(value: unknown): "account" | "byok" | undefined {
  return value === "account" || value === "byok" ? value : undefined;
}

function isRecord(value: unknown): value is ConfigRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function resolvePath(path: string): string {
  return resolve(expandHome(path));
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function parseHttpUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must use http or https: ${value}`);
  }
  return url;
}

function normalizeBaseUrl(url: URL): string {
  return url.toString().replace(/\/+$/, "");
}

function listenHostFromUrl(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "");
}

function listenPortFromUrl(url: URL): number {
  if (url.port) {
    return Number(url.port);
  }
  return url.protocol === "https:" ? 443 : 80;
}

function clientHost(host: string): string {
  if (host === "0.0.0.0" || host === "::") {
    return LOCAL_HOST;
  }
  return host;
}

function createPersistentSecret(): string {
  return randomBytes(32).toString("base64url");
}

function appendTail(target: string[], value: string): void {
  target.push(value);
  while (target.length > 20) {
    target.shift();
  }
}

function formatChildTail(child: ManagedChild): string {
  const stderr = child.stderrTail.join("").trim();
  const stdout = child.stdoutTail.join("").trim();
  return [
    stderr ? `stderr: ${stderr}` : "",
    stdout ? `stdout: ${stdout}` : ""
  ].filter(Boolean).join(" ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    const timer = setTimeout(resolveSleep, ms);
    timer.unref?.();
  });
}
