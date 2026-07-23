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

export interface RuntimeEntryPaths {
  memoryEntry: string;
  agentEntry: string;
}

export interface PackagedRuntimeConfig {
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

export interface ManagedChild {
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
  ipc?: boolean;
}

const DAEMON_LOG_MAX_SIZE = 5 * 1024 * 1024;

const DAEMON_LOG_MAX_FILES = 5;
const AGENT_GATEWAY_RESTART_DELAYS_MS = [250, 1_000, 2_000, 5_000, 10_000] as const;
const AGENT_GATEWAY_STABLE_MS = 30_000;
const DESKTOP_MANAGED_GATEWAY_ENV = "MEMMY_DESKTOP_MANAGED_GATEWAY";
const MANAGED_RESTART_IPC_TYPE = "memmy-agent:restart";

interface DesktopManagedRestartNotice {
  type: typeof MANAGED_RESTART_IPC_TYPE;
  channel: string;
  chatId: string;
  startedAt: string;
  metadata: Record<string, unknown>;
}

type HttpProbeResult = "ready" | "unreachable" | "unexpected";

export async function startPackagedRuntimeServices(
  options: StartPackagedRuntimeServicesOptions
): Promise<PackagedRuntimeServices> {
  const entries = resolveRuntimeEntryPaths(options);
  const runtimeConfig = await preparePackagedRuntimeConfig();
  const children: ManagedChild[] = [];
  const gatewaySupervisor = new AgentGatewaySupervisor(entries, runtimeConfig, children, options);
  let memoryRestart: Promise<void> | null = null;
  let closing = false;

  try {
    await syncBundledAgentSkills({
      agentEntry: entries.agentEntry,
      agentWorkspace: runtimeConfig.agentWorkspace
    });
    await ensureMemoryService(entries, runtimeConfig, children, options);
    await gatewaySupervisor.ensureStarted();

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
        await gatewaySupervisor.close();
        await stopManagedChildren(children);
      },
      terminateSync() {
        gatewaySupervisor.terminateSync();
        terminateManagedChildrenSync(children);
      }
    };
  } catch (error) {
    await gatewaySupervisor.close();
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
  if (!Object.prototype.hasOwnProperty.call(config, "fileMemory")) {
    config.fileMemory = { enabled: false };
    changed = true;
  } else if (
    isRecord(config.fileMemory) &&
    !Object.prototype.hasOwnProperty.call(config.fileMemory, "enabled")
  ) {
    config.fileMemory.enabled = false;
    changed = true;
  }
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

export interface AgentGatewaySupervisorDependencies {
  probeHttpService?: typeof probeHttpService;
  spawnNodeService?: typeof spawnNodeService;
  waitForHttpService?: typeof waitForHttpService;
  stopManagedChild?: typeof stopManagedChild;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export class AgentGatewaySupervisor {
  ownership: "external" | "owned" | null = null;
  ownedChild: ManagedChild | null = null;
  childGeneration = 0;
  startPromise: Promise<void> | null = null;
  stopping = false;
  restartTimer: ReturnType<typeof setTimeout> | null = null;
  restartAttempt = 0;
  stableTimer: ReturnType<typeof setTimeout> | null = null;
  pendingRestartNotice: { childGeneration: number; notice: DesktopManagedRestartNotice } | null = null;
  hasReachedReady = false;

  private replacementNotice: DesktopManagedRestartNotice | null = null;
  private readonly bootstrapUrl: string;
  private readonly bootstrapHeaders: Record<string, string>;
  private readonly dependencies: Required<AgentGatewaySupervisorDependencies>;

  constructor(
    private readonly entries: RuntimeEntryPaths,
    private readonly runtimeConfig: PackagedRuntimeConfig,
    private readonly children: ManagedChild[],
    private readonly options: StartPackagedRuntimeServicesOptions,
    dependencies: AgentGatewaySupervisorDependencies = {}
  ) {
    this.bootstrapUrl = `${runtimeConfig.agentGatewayBaseUrl}/webui/bootstrap`;
    this.bootstrapHeaders = runtimeConfig.agentGatewayBootstrapSecret
      ? { "x-memmy-agent-auth": runtimeConfig.agentGatewayBootstrapSecret }
      : {};
    this.dependencies = {
      probeHttpService: dependencies.probeHttpService ?? probeHttpService,
      spawnNodeService: dependencies.spawnNodeService ?? spawnNodeService,
      waitForHttpService: dependencies.waitForHttpService ?? waitForHttpService,
      stopManagedChild: dependencies.stopManagedChild ?? stopManagedChild,
      setTimer: dependencies.setTimer ?? setTimeout,
      clearTimer: dependencies.clearTimer ?? clearTimeout
    };
  }

  ensureStarted(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.ensureStartedOnce().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async close(): Promise<void> {
    this.stopping = true;
    this.clearTimers();
    const child = this.ownedChild;
    this.ownedChild = null;
    if (child) {
      await this.dependencies.stopManagedChild(child).catch(() => undefined);
      this.removeChild(child);
      child.logWriter?.close();
    }
  }

  terminateSync(): void {
    this.stopping = true;
    this.clearTimers();
    const child = this.ownedChild;
    this.ownedChild = null;
    if (child) {
      terminateManagedChildrenSync([child]);
      this.removeChild(child);
      child.logWriter?.close();
    }
  }

  private async ensureStartedOnce(): Promise<void> {
    if (this.stopping || this.ownership === "external" || (this.ownership === "owned" && this.ownedChild)) {
      return;
    }
    const probe = await this.dependencies.probeHttpService(this.bootstrapUrl, this.bootstrapHeaders);
    if (probe === "ready") {
      this.ownership = "external";
      return;
    }
    if (probe === "unexpected") {
      throw new Error(`Agent gateway endpoint is occupied by an unexpected service: ${this.bootstrapUrl}`);
    }
    await this.spawnOwnedGateway(true);
  }

  private async spawnOwnedGateway(initialStartup: boolean): Promise<void> {
    if (this.stopping) return;
    const generation = this.childGeneration + 1;
    this.childGeneration = generation;
    const notice = this.replacementNotice;
    const child = this.dependencies.spawnNodeService("agent-gateway", this.entries.agentEntry, [
      "gateway",
      "--config",
      this.runtimeConfig.configPath,
      "--workspace",
      this.runtimeConfig.agentWorkspace,
      "--host",
      this.runtimeConfig.agentGatewayHealthHost,
      "--port",
      String(this.runtimeConfig.agentGatewayHealthPort)
    ], {
      MEMMY_CONFIG: this.runtimeConfig.configPath,
      MEMMY_AGENT_WORKSPACE: this.runtimeConfig.agentWorkspace,
      MEMMY_MEMORY_URL: this.runtimeConfig.memoryBaseUrl,
      MEMMY_MEMORY_TOKEN: this.runtimeConfig.memoryToken,
      MEMORY_SERVICE_URL: this.runtimeConfig.memoryBaseUrl,
      MEMORY_SERVICE_TOKEN: this.runtimeConfig.memoryToken,
      [DESKTOP_MANAGED_GATEWAY_ENV]: "1",
      ...(notice ? restartNoticeEnv(notice) : {})
    }, {
      logFilePath: join(this.options.logDirectory, "agent-gateway.log"),
      logLevel: this.options.logLevel,
      ipc: true
    });
    this.ownership = "owned";
    this.ownedChild = child;
    this.children.push(child);
    this.bindOwnedChild(child, generation);

    try {
      await this.dependencies.waitForHttpService("agent-gateway", this.bootstrapUrl, child, this.bootstrapHeaders);
      if (this.stopping || this.ownedChild !== child || this.childGeneration !== generation) return;
      this.hasReachedReady = true;
      this.replacementNotice = null;
      this.startStableTimer(child, generation);
    } catch (error) {
      if (this.ownedChild === child) {
        await this.dependencies.stopManagedChild(child).catch(() => undefined);
      }
      if (initialStartup) throw error;
    }
  }

  private bindOwnedChild(child: ManagedChild, generation: number): void {
    let closed = false;
    child.process.on("message", (message) => {
      if (this.stopping
        || this.ownedChild !== child
        || this.childGeneration !== generation
        || this.pendingRestartNotice?.childGeneration === generation) {
        return;
      }
      const notice = parseDesktopManagedRestartNotice(message);
      if (notice) {
        this.pendingRestartNotice = { childGeneration: generation, notice };
      }
    });
    child.process.once("error", (error) => {
      if (this.ownedChild !== child || this.childGeneration !== generation) return;
      const exitDescription = `error ${error.message}`;
      if (isManagedChildRunning(child)) {
        void this.dependencies.stopManagedChild(child)
          .catch(() => undefined)
          .finally(() => {
            child.exitDescription ??= exitDescription;
          });
      } else {
        child.exitDescription ??= exitDescription;
      }
    });
    child.process.once("close", (code, signal) => {
      if (closed) return;
      closed = true;
      child.exitDescription = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      this.handleOwnedChildClose(child, generation, code);
    });
  }

  private handleOwnedChildClose(child: ManagedChild, generation: number, code: number | null): void {
    this.removeChild(child);
    child.logWriter?.close();
    if (this.ownedChild !== child || this.childGeneration !== generation) return;
    this.ownedChild = null;
    this.clearStableTimer();
    if (this.stopping || !this.hasReachedReady) return;

    const pending = this.pendingRestartNotice?.childGeneration === generation
      ? this.pendingRestartNotice.notice
      : null;
    this.pendingRestartNotice = null;
    if (code === 75 && pending) {
      this.replacementNotice = pending;
      this.restartAttempt = 1;
      this.scheduleReplacement(250);
      return;
    }
    if (pending) {
      this.replacementNotice = null;
    }
    this.scheduleReplacement();
  }

  private scheduleReplacement(delayOverride?: number): void {
    if (this.stopping || this.restartTimer) return;
    const delay = delayOverride ?? (
      AGENT_GATEWAY_RESTART_DELAYS_MS[this.restartAttempt]
      ?? AGENT_GATEWAY_RESTART_DELAYS_MS[AGENT_GATEWAY_RESTART_DELAYS_MS.length - 1]
      ?? 10_000
    );
    if (delayOverride === undefined) this.restartAttempt += 1;
    this.restartTimer = this.dependencies.setTimer(() => {
      this.restartTimer = null;
      void this.startReplacement();
    }, delay);
    this.restartTimer.unref?.();
  }

  private async startReplacement(): Promise<void> {
    if (this.stopping) return;
    const probe = await this.dependencies.probeHttpService(this.bootstrapUrl, this.bootstrapHeaders);
    if (probe === "ready") {
      this.ownership = "external";
      this.pendingRestartNotice = null;
      this.replacementNotice = null;
      return;
    }
    if (probe === "unexpected") {
      this.scheduleReplacement();
      return;
    }
    try {
      await this.spawnOwnedGateway(false);
    } catch {
      this.scheduleReplacement();
    }
  }

  private startStableTimer(child: ManagedChild, generation: number): void {
    this.clearStableTimer();
    this.stableTimer = this.dependencies.setTimer(() => {
      this.stableTimer = null;
      if (!this.stopping && this.ownedChild === child && this.childGeneration === generation) {
        this.restartAttempt = 0;
      }
    }, AGENT_GATEWAY_STABLE_MS);
    this.stableTimer.unref?.();
  }

  private clearStableTimer(): void {
    if (!this.stableTimer) return;
    this.dependencies.clearTimer(this.stableTimer);
    this.stableTimer = null;
  }

  private clearTimers(): void {
    if (this.restartTimer) {
      this.dependencies.clearTimer(this.restartTimer);
      this.restartTimer = null;
    }
    this.clearStableTimer();
  }

  private removeChild(child: ManagedChild): void {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
  }
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
    stdio: logOptions.ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
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

function parseDesktopManagedRestartNotice(value: unknown): DesktopManagedRestartNotice | null {
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.some((key) => !["type", "channel", "chatId", "startedAt", "metadata"].includes(key))) return null;
  if (value.type !== MANAGED_RESTART_IPC_TYPE) return null;
  if (typeof value.channel !== "string" || value.channel.trim().length === 0 || value.channel.length > 64) return null;
  if (typeof value.chatId !== "string" || value.chatId.length > 256) return null;
  if (typeof value.startedAt !== "string" || value.startedAt.trim().length === 0 || value.startedAt.length > 32 || !Number.isFinite(Number(value.startedAt))) return null;
  if (!isPlainObject(value.metadata)) return null;
  let metadataJson: string;
  try {
    metadataJson = JSON.stringify(value.metadata);
  } catch {
    return null;
  }
  if (typeof metadataJson !== "string") return null;
  if (Buffer.byteLength(metadataJson, "utf8") > 16 * 1024) return null;
  const metadata = JSON.parse(metadataJson) as unknown;
  if (!isPlainObject(metadata)) return null;
  return {
    type: MANAGED_RESTART_IPC_TYPE,
    channel: value.channel,
    chatId: value.chatId,
    startedAt: value.startedAt,
    metadata
  };
}

function restartNoticeEnv(notice: DesktopManagedRestartNotice): Record<string, string> {
  return {
    MEMMY_AGENT_RESTART_NOTIFY_CHANNEL: notice.channel,
    MEMMY_AGENT_RESTART_NOTIFY_CHAT_ID: notice.chatId,
    MEMMY_AGENT_RESTART_STARTED_AT: notice.startedAt,
    ...(Object.keys(notice.metadata).length > 0
      ? { MEMMY_AGENT_RESTART_NOTIFY_METADATA: JSON.stringify(notice.metadata) }
      : {})
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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
