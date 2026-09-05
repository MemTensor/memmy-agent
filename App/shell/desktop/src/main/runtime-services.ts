import { mutateRuntimeConfig } from "@memmy/migrations";
import type { AgentGatewayStartupIssue } from "@memmy/local-api-contracts";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import YAML from "yaml";
import { createRotatingWriter, type RotatingWriter } from "./rotating-log-file.js";
import type { LogLevel } from "./log-level.js";

const LOCAL_HOST = "127.0.0.1";
const DEFAULT_MEMORY_URL = "http://127.0.0.1:18960";
const SUPPORTED_MEMORY_PROTOCOL_VERSION = 1;
const DEFAULT_AGENT_GATEWAY_HEALTH_PORT = 18970;
const DEFAULT_AGENT_WEBSOCKET_PORT = 18980;
const STARTUP_TIMEOUT_MS = 30_000;
const MEMORY_STARTUP_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 250;
const HTTP_TIMEOUT_MS = 1_000;
const STOP_MANAGED_CHILD_GRACE_MS = 1_000;
const MEMORY_STOP_COMMAND_TIMEOUT_MS = 10_000;
const MEMORY_RESTART_STOP_TIMEOUT_MS = 10_000;

type RuntimeEnv = Record<string, string | undefined>;
type ConfigRecord = Record<string, unknown>;

export interface ManagedRuntimeServices {
  memory: {
    baseUrl: string;
    token: string;
    databasePath: string;
    configPath: string;
    ready: Promise<void>;
  };
  agentGateway: {
    baseUrl: string;
    bootstrapSecret: string;
    configPath: string;
    workspace: string;
    startupIssue?: AgentGatewayStartupIssue;
  };
  restartMemory(): Promise<void>;
  close(options?: { stopMemory?: boolean }): Promise<void>;
  terminateSync(options?: { stopMemory?: boolean }): void;
}

export interface StartPackagedRuntimeServicesOptions {
  appPath: string;
  appDatabaseFile: string;
  resourcesPath: string;
  logDirectory: string;
  logLevel: LogLevel;
}

export interface StartManagedRuntimeServicesOptions extends StartPackagedRuntimeServicesOptions {
  runtimeEntries?: RuntimeEntryPaths;
  runtimeExecutable?: string;
  /** Runs after migrations/config preparation and before any managed child starts. */
  beforeStartServices?: (input: { databasePath: string; configPath: string }) => Promise<void>;
  /** Unpacked Memory runtime shipped as an offline Desktop resource. */
  offlineMemoryRuntimeDirectory?: string;
}

export type PackagedRuntimeServices = ManagedRuntimeServices;

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
  appDatabaseFile?: string;
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
  persistOnDesktopExit?: boolean;
}

export interface PackagedBrowserPreparation {
  completion: Promise<boolean>;
  stop(): void;
}

interface ServiceLogOptions {
  logFilePath: string;
  logLevel: LogLevel;
  ipc?: boolean;
  executablePath?: string;
  persistOnDesktopExit?: boolean;
}

const DAEMON_LOG_MAX_SIZE = 5 * 1024 * 1024;

const DAEMON_LOG_MAX_FILES = 5;
const AGENT_GATEWAY_RESTART_DELAYS_MS = [250, 1_000, 2_000, 5_000, 10_000] as const;
const AGENT_GATEWAY_STABLE_MS = 30_000;
const DESKTOP_MANAGED_MEMORY_ENV = "MEMMY_DESKTOP_MANAGED_MEMORY";
const MEMORY_RESTART_IPC_TYPE = "memmy-memory:restart";
const DESKTOP_MANAGED_GATEWAY_ENV = "MEMMY_DESKTOP_MANAGED_GATEWAY";
const BROWSER_PREPARATION_ATTEMPT_ID_ENV = "MEMMY_BROWSER_PREPARATION_ATTEMPT_ID";
const MANAGED_RESTART_IPC_TYPE = "memmy-agent:restart";
const MIGRATIONS_READY_CONFIG_ENV = "MEMMY_MIGRATIONS_READY_CONFIG";
const MIGRATIONS_READY_WORKSPACE_ENV = "MEMMY_MIGRATIONS_READY_WORKSPACE";
const MIGRATIONS_READY_SESSION_DAG_ENV = "MEMMY_MIGRATIONS_READY_SESSION_DAG";
const MIGRATIONS_READY_APP_DATABASE_ENV = "MEMMY_MIGRATIONS_READY_APP_DATABASE";
const APP_DATABASE_ENV = "MEMMY_APP_DATABASE";

function sessionDagMigrationTarget(
  agentWorkspace: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const override = env.MEMMY_AGENT_SESSION_DAG_DIR;
  return resolve(
    override && override.trim()
      ? override
      : join(dirname(agentWorkspace), "session-dag")
  );
}

interface DesktopManagedRestartNotice {
  type: typeof MANAGED_RESTART_IPC_TYPE;
  channel: string;
  chatId: string;
  startedAt: string;
  metadata: Record<string, unknown>;
}

type HttpProbeResult = "ready" | "unreachable" | "unexpected";

export interface MemoryServerLock {
  pid: number;
  host?: string;
  port?: number;
  sqlitePath?: string;
}

export async function startManagedRuntimeServices(
  options: StartManagedRuntimeServicesOptions
): Promise<ManagedRuntimeServices> {
  const entries = resolveRuntimeEntryPaths(options);
  const migrationTargets = await resolvePackagedRuntimeMigrationTargets();
  const memmyConfigPreexisting = existsSync(migrationTargets.configPath);
  await runPackagedMigrationCommand({
    agentEntry: entries.agentEntry,
    configPath: migrationTargets.configPath,
    agentWorkspace: migrationTargets.agentWorkspace,
    appDatabaseFile: options.appDatabaseFile,
    logDirectory: options.logDirectory,
    logLevel: options.logLevel,
    runtimeExecutable: options.runtimeExecutable
  });
  const runtimeConfig = await preparePackagedRuntimeConfig();
  runtimeConfig.appDatabaseFile = options.appDatabaseFile;
  await options.beforeStartServices?.({
    databasePath: options.appDatabaseFile,
    configPath: runtimeConfig.configPath
  });
  const browserPreparationAttemptId = randomUUID();
  const children: ManagedChild[] = [];
  const gatewaySupervisor = new AgentGatewaySupervisor(
    entries,
    runtimeConfig,
    children,
    options,
    {},
    browserPreparationAttemptId
  );
  let memoryRestart: Promise<void> | null = null;
  let memoryStartup: Promise<void> | null = null;
  let browserPreparation: PackagedBrowserPreparation | null = null;
  let closing = false;
  let stopMemoryOnClose = false;

  async function restartMemoryRuntime(): Promise<void> {
    if (closing) throw new Error("Memmy is shutting down");
    await memoryStartup;
    if (closing) throw new Error("Memmy is shutting down");
    if (!memoryRestart) {
      memoryRestart = restartManagedMemoryService(
        entries,
        runtimeConfig,
        children,
        options,
        requestMemoryRestart
      ).finally(() => {
        memoryRestart = null;
      });
    }
    await memoryRestart;
  }
  function requestMemoryRestart(): void {
    void restartMemoryRuntime().catch((error) => {
      console.warn(`Memory service restart request failed: ${errorMessage(error)}`);
    });
  }

  try {
    await syncBundledAgentSkills({
      agentEntry: entries.agentEntry,
      agentWorkspace: runtimeConfig.agentWorkspace
    });
    browserPreparation = startPackagedBrowserPreparation(
      entries,
      runtimeConfig,
      options,
      spawn,
      browserPreparationAttemptId
    );
    const memoryReady = ensureMemoryService(
      entries,
      runtimeConfig,
      children,
      options,
      memmyConfigPreexisting,
      requestMemoryRestart,
      () => closing && stopMemoryOnClose
    );
    memoryStartup = memoryReady
      .catch((error) => {
        console.warn(`Memory service unavailable during desktop startup: ${errorMessage(error)}`);
      })
      .finally(() => {
        // Closing can race the asynchronous installer/health wait. If a
        // detached child is materialized after the first cleanup pass, run
        // the same policy once more when startup settles.
        if (closing) {
          void stopManagedChildrenForDesktopExit(children, stopMemoryOnClose).catch((error) => {
            console.warn(`Memory child cleanup after startup close failed: ${errorMessage(error)}`);
          });
        }
      });
    const agentGatewayStartupIssue = await startAgentGatewayWithRecovery(gatewaySupervisor);

    return {
      memory: {
        baseUrl: runtimeConfig.memoryBaseUrl,
        token: runtimeConfig.memoryToken,
        databasePath: runtimeConfig.memoryDatabasePath,
        configPath: runtimeConfig.configPath,
        ready: memoryReady
      },
      agentGateway: {
        baseUrl: runtimeConfig.agentGatewayBaseUrl,
        bootstrapSecret: runtimeConfig.agentGatewayBootstrapSecret,
        configPath: runtimeConfig.configPath,
        workspace: runtimeConfig.agentWorkspace,
        ...(agentGatewayStartupIssue ? { startupIssue: agentGatewayStartupIssue } : {})
      },
      async restartMemory() {
        await restartMemoryRuntime();
      },
      async close(closeOptions = {}) {
        closing = true;
        stopMemoryOnClose = closeOptions.stopMemory === true;
        browserPreparation?.stop();
        await memoryRestart?.catch(() => undefined);
        await gatewaySupervisor.close();
        if (closeOptions.stopMemory && options.offlineMemoryRuntimeDirectory) {
          try {
            await runBundledMemoryCli(
              options.offlineMemoryRuntimeDirectory,
              runtimeConfig,
              options,
              ["stop", "--home", dirname(runtimeConfig.configPath)],
              MEMORY_STOP_COMMAND_TIMEOUT_MS
            );
          } catch (error) {
            // A failed service-manager command must not prevent cleanup of a
            // Desktop-owned child or turn an intentional quit into a
            // rejected close promise.
            console.warn(`Failed to stop bundled Memory during Desktop close: ${errorMessage(error)}`);
          }
        }
        await stopManagedChildrenForDesktopExit(children, closeOptions.stopMemory === true);
      },
      terminateSync(terminateOptions = {}) {
        closing = true;
        stopMemoryOnClose = terminateOptions.stopMemory === true;
        browserPreparation?.stop();
        if (terminateOptions.stopMemory && options.offlineMemoryRuntimeDirectory) {
          runBundledMemoryCliSync(
            options.offlineMemoryRuntimeDirectory,
            runtimeConfig,
            options,
            ["stop", "--home", dirname(runtimeConfig.configPath)]
          );
        }
        gatewaySupervisor.terminateSync();
        terminateManagedChildrenForDesktopExit(children, terminateOptions.stopMemory === true);
      }
    };
  } catch (error) {
    closing = true;
    stopMemoryOnClose = true;
    browserPreparation?.stop();
    await gatewaySupervisor.close();
    await stopManagedChildren(children);
    throw error;
  }
}

export async function startPackagedRuntimeServices(
  options: StartPackagedRuntimeServicesOptions
): Promise<PackagedRuntimeServices> {
  return startManagedRuntimeServices(options);
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
  const secretFactory = options.secretFactory ?? createPersistentSecret;
  const defaultWorkspace = join(memmyHome, "workspace");
  const applyRuntimeDefaults = (config: ConfigRecord): ConfigRecord => {
    const memmyMemory = ensureRecord(config, "memmyMemory");
    const storage = ensureRecord(memmyMemory, "storage");
    const channels = ensureRecord(config, "channels");
    const websocket = ensureRecord(channels, "websocket");
    const gateway = ensureRecord(config, "gateway");
    const heartbeat = ensureRecord(gateway, "heartbeat");
    const agents = ensureRecord(config, "agents");
    const defaults = ensureRecord(agents, "defaults");
    if (!Object.prototype.hasOwnProperty.call(config, "fileMemory")) {
      config.fileMemory = { enabled: false };
    } else if (
      isRecord(config.fileMemory) &&
      !Object.prototype.hasOwnProperty.call(config.fileMemory, "enabled")
    ) {
      config.fileMemory.enabled = false;
    }
    const agentWorkspace = resolvePath(
      env.MEMMY_AGENT_WORKSPACE ?? stringValue(defaults.workspace) ?? defaultWorkspace
    );
    const memoryDatabasePath = resolvePath(
      env.MEMMY_MEMORY_DB ??
        env.MEMORY_SERVICE_DB ??
        stringValue(storage.sqlitePath) ??
        join(memmyHome, "memory-service", "memory.sqlite")
    );
    setMissing(storage, "mode", "local");
    setMissing(storage, "backend", "sqlite");
    setMissing(storage, "sqlitePath", memoryDatabasePath);
    setMissing(storage, "endpoint", DEFAULT_MEMORY_URL);
    setMissing(websocket, "host", LOCAL_HOST);
    setMissing(websocket, "port", DEFAULT_AGENT_WEBSOCKET_PORT);
    if (shouldFillMissingAgentSecret && !stringValue(websocket.tokenIssueSecret) && !stringValue(websocket.token)) {
      websocket.tokenIssueSecret = secretFactory();
    }
    setMissing(websocket, "tokenTtlS", 86_400);
    setMissing(websocket, "websocketRequiresToken", true);
    setMissing(websocket, "allowFrom", ["*"]);
    websocket.enabled = true;
    setMissing(gateway, "host", LOCAL_HOST);
    setMissing(gateway, "port", DEFAULT_AGENT_GATEWAY_HEALTH_PORT);
    setMissing(heartbeat, "enabled", false);
    setMissing(defaults, "workspace", agentWorkspace);
    return config;
  };
  const config = shouldWriteConfig
    ? (await mutateRuntimeConfig(configPath, applyRuntimeDefaults)).value
    : applyRuntimeDefaults(await readConfig(configPath));
  const storage = ensureRecord(ensureRecord(config, "memmyMemory"), "storage");
  const websocket = ensureRecord(ensureRecord(config, "channels"), "websocket");
  const gateway = ensureRecord(config, "gateway");
  const defaults = ensureRecord(ensureRecord(config, "agents"), "defaults");
  const agentWorkspace = resolvePath(
    env.MEMMY_AGENT_WORKSPACE ?? stringValue(defaults.workspace) ?? defaultWorkspace
  );
  const memoryDatabasePath = resolvePath(
    env.MEMMY_MEMORY_DB ??
      env.MEMORY_SERVICE_DB ??
      stringValue(storage.sqlitePath) ??
      join(memmyHome, "memory-service", "memory.sqlite")
  );
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

export async function resolvePackagedRuntimeMigrationTargets(
  env: RuntimeEnv = process.env
): Promise<{ configPath: string; agentWorkspace?: string }> {
  const memmyHome = resolvePath(env.MEMMY_HOME ?? "~/.memmy");
  const configPath = resolvePath(env.MEMMY_CONFIG ?? join(memmyHome, "config.yaml"));
  const explicitWorkspace = stringValue(env.MEMMY_AGENT_WORKSPACE);
  if (!explicitWorkspace) return { configPath };
  const agentWorkspace = resolvePath(explicitWorkspace);
  await mkdir(agentWorkspace, { recursive: true });
  return { configPath, agentWorkspace: await realpath(agentWorkspace) };
}

export async function runPackagedMigrationCommand(options: {
  agentEntry: string;
  configPath: string;
  agentWorkspace?: string;
  appDatabaseFile: string;
  logDirectory: string;
  logLevel: LogLevel;
  runtimeExecutable?: string;
  spawnProcess?: typeof spawn;
  timeoutMs?: number;
}): Promise<void> {
  const logWriter = createRotatingWriter({
    filePath: join(options.logDirectory, "migration.log"),
    maxSize: DAEMON_LOG_MAX_SIZE,
    maxFiles: DAEMON_LOG_MAX_FILES
  });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    NODE_ENV: process.env.NODE_ENV ?? "production",
    MEMMY_LOG_LEVEL: options.logLevel
  };
  delete env[MIGRATIONS_READY_CONFIG_ENV];
  delete env[MIGRATIONS_READY_WORKSPACE_ENV];
  delete env[MIGRATIONS_READY_SESSION_DAG_ENV];
  delete env[MIGRATIONS_READY_APP_DATABASE_ENV];

  let child: ChildProcess;
  try {
    const migrationArgs = [
      options.agentEntry,
      "migrate",
      "--config",
      options.configPath,
      ...(options.agentWorkspace ? ["--workspace", options.agentWorkspace] : []),
      "--app-database",
      options.appDatabaseFile
    ];
    child = (options.spawnProcess ?? spawn)(
      options.runtimeExecutable ?? process.execPath,
      migrationArgs,
      {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
        shell: false
      }
    );
  } catch (error) {
    logWriter.close();
    throw new Error(`Migration command failed to start: ${String(error)}`);
  }

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => logWriter.write(String(chunk)));
  child.stderr?.on("data", (chunk) => logWriter.write(String(chunk)));

  try {
    await new Promise<void>((resolveCommand, rejectCommand) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) rejectCommand(error);
        else resolveCommand();
      };
      const timeout = setTimeout(() => {
        terminateProcessTreeSync(child);
        finish(new Error(`Migration command timed out after ${options.timeoutMs ?? STARTUP_TIMEOUT_MS}ms`));
      }, options.timeoutMs ?? STARTUP_TIMEOUT_MS);
      timeout.unref?.();
      child.once("error", (error) => finish(
        new Error(`Migration command failed: ${error.message}`)
      ));
      child.once("close", (code, signal) => {
        if (code === 0) {
          finish();
          return;
        }
        finish(new Error(
          `Migration command exited with ${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}`
        ));
      });
    });
  } finally {
    logWriter.close();
  }
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

type DesktopBrowserPreparationState = {
  status: "preparing" | "ready" | "unavailable";
  attemptId: string;
  updatedAt?: string;
  startedAt?: string;
  lastProgressAt?: string;
  progressPercent?: number;
  error?: string;
};

function browserPreparationStatePath(configPath: string): string {
  return join(
    dirname(configPath),
    "mcp",
    "playwright",
    "browser-preparation-state.json"
  );
}

function writeDesktopBrowserPreparationState(
  configPath: string,
  state: Omit<DesktopBrowserPreparationState, "updatedAt">
): void {
  const statePath = browserPreparationStatePath(configPath);
  const temporaryPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(
      temporaryPath,
      `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8"
    );
    renameSync(temporaryPath, statePath);
  } catch {
    // The browser preparation child also publishes state when it starts.
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function readDesktopBrowserPreparationState(
  configPath: string
): DesktopBrowserPreparationState | null {
  try {
    const parsed = JSON.parse(
      readFileSync(browserPreparationStatePath(configPath), "utf8")
    ) as DesktopBrowserPreparationState;
    if (!parsed || typeof parsed !== "object") return null;
    if (!["preparing", "ready", "unavailable"].includes(parsed.status)) return null;
    if (typeof parsed.attemptId !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function preparePackagedBrowser(
  entries: RuntimeEntryPaths,
  runtimeConfig: PackagedRuntimeConfig,
  options: StartManagedRuntimeServicesOptions,
  spawnProcess: typeof spawn = spawn
): Promise<boolean> {
  return startPackagedBrowserPreparation(
    entries,
    runtimeConfig,
    options,
    spawnProcess
  ).completion;
}

export function startPackagedBrowserPreparation(
  entries: RuntimeEntryPaths,
  runtimeConfig: PackagedRuntimeConfig,
  options: StartManagedRuntimeServicesOptions,
  spawnProcess: typeof spawn = spawn,
  attemptId: string = randomUUID()
): PackagedBrowserPreparation {
  const logWriter = createRotatingWriter({
    filePath: join(options.logDirectory, "browser-prepare.log"),
    maxSize: DAEMON_LOG_MAX_SIZE,
    maxFiles: DAEMON_LOG_MAX_FILES
  });
  let resolveCompletion: (ready: boolean) => void = () => undefined;
  const completion = new Promise<boolean>((resolvePrepare) => {
    resolveCompletion = resolvePrepare;
  });
  let child: ChildProcess | null = null;
  let settled = false;
  const finish = (ready: boolean): void => {
    if (settled) return;
    settled = true;
    logWriter.close();
    resolveCompletion(ready);
  };
  const stop = (): void => {
    if (settled) return;
    if (child) terminateProcessTreeSync(child);
    finish(false);
  };
  const preparation = { completion, stop };
  const startedAt = new Date().toISOString();
  writeDesktopBrowserPreparationState(runtimeConfig.configPath, {
    status: "preparing",
    attemptId,
    startedAt,
    lastProgressAt: startedAt,
    progressPercent: 0
  });

  if (!existsSync(entries.agentEntry)) {
    logWriter.write(`Missing browser prepare runtime entry: ${entries.agentEntry}\n`);
    finish(false);
    return preparation;
  }

  try {
    child = spawnProcess(
      options.runtimeExecutable ?? process.execPath,
      [entries.agentEntry, "internal", "browser-prepare"],
      {
        env: {
          ...process.env,
          MEMMY_CONFIG: runtimeConfig.configPath,
          MEMMY_AGENT_WORKSPACE: runtimeConfig.agentWorkspace,
          [BROWSER_PREPARATION_ATTEMPT_ID_ENV]: attemptId,
          ELECTRON_RUN_AS_NODE: "1",
          NODE_ENV: process.env.NODE_ENV ?? "production"
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
        shell: false
      }
    );
  } catch (error) {
    logWriter.write(`Browser prepare failed to start: ${String(error)}\n`);
    writeDesktopBrowserPreparationState(runtimeConfig.configPath, {
      status: "unavailable",
      attemptId,
      error: `Browser prepare failed to start: ${String(error)}`
    });
    finish(false);
    return preparation;
  }
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => logWriter.write(String(chunk)));
  child.stderr?.on("data", (chunk) => logWriter.write(String(chunk)));
  child.once("error", (error) => {
    logWriter.write(`Browser prepare failed: ${error.message}\n`);
    writeDesktopBrowserPreparationState(runtimeConfig.configPath, {
      status: "unavailable",
      attemptId,
      error: `Browser prepare failed: ${error.message}`
    });
    finish(false);
  });
  child.once("exit", (code, signal) => {
    if (code !== 0) {
      logWriter.write(
        `Browser prepare unavailable: ${signal ? `signal ${signal}` : `code ${String(code)}`}\n`
      );
      const state = readDesktopBrowserPreparationState(runtimeConfig.configPath);
      if (state?.attemptId === attemptId && state.status === "preparing") {
        writeDesktopBrowserPreparationState(runtimeConfig.configPath, {
          status: "unavailable",
          attemptId,
          error: `Browser prepare unavailable: ${signal ? `signal ${signal}` : `code ${String(code)}`}`
        });
      }
    }
    finish(code === 0);
  });
  return preparation;
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

export async function ensureMemoryService(
  entries: RuntimeEntryPaths,
  runtimeConfig: PackagedRuntimeConfig,
  children: ManagedChild[],
  options: StartManagedRuntimeServicesOptions,
  memmyConfigPreexisting = true,
  onRestartRequested?: () => void,
  shouldStop?: () => boolean
): Promise<void> {
  if (shouldStop?.()) return;
  const healthUrl = `${runtimeConfig.memoryBaseUrl}/api/v1/health`;
  const healthHeaders = memoryAuthHeaders(runtimeConfig.memoryToken);
  const probe = await probeMemoryService(healthUrl, healthHeaders);
  if (probe === "ready") {
    if (!(await stopOlderBundledMemoryRuntime(runtimeConfig, options, shouldStop))) return;
  }
  if (probe === "incompatible") {
    throw new Error(`Memory protocol at ${healthUrl} is incompatible with Desktop protocol ${SUPPORTED_MEMORY_PROTOCOL_VERSION}; upgrade Desktop or Memory`);
  }
  if (probe === "unexpected") {
    throw new Error(`Memory endpoint is occupied by an unexpected service: ${healthUrl}`);
  }

  if (options.offlineMemoryRuntimeDirectory) {
    const existingLock = readLiveMemoryServerLock(runtimeConfig.memoryDatabasePath);
    if (existingLock) {
      // Never switch the stable pointer while an older service still owns
      // the database. It may be in migrations before its HTTP endpoint is
      // available; let that owner finish before activating a new runtime.
      let existingReady = false;
      try {
        await waitForExistingMemoryService(healthUrl, healthHeaders, existingLock);
        existingReady = true;
      } catch (error) {
        if (readLiveMemoryServerLock(runtimeConfig.memoryDatabasePath)) throw error;
      }
      if (existingReady && !(await stopOlderBundledMemoryRuntime(runtimeConfig, options, shouldStop))) return;
    }
    if (shouldStop?.()) return;
    await installBundledMemoryRuntime(
      options.offlineMemoryRuntimeDirectory,
      runtimeConfig,
      options,
      memmyConfigPreexisting
    );
    if (shouldStop?.()) return;
    const installed = await readInstalledMemoryRuntime(runtimeConfig.configPath);
    await startManagedMemoryService(
      installed?.entrypoint ?? entries.memoryEntry,
      installed?.runtimeDir ?? options.offlineMemoryRuntimeDirectory,
      installed?.runtimeExecutable,
      runtimeConfig,
      children,
      options,
      onRestartRequested,
      true,
      shouldStop
    );
    return;
  }

  await startManagedMemoryService(
    entries.memoryEntry,
    undefined,
    undefined,
    runtimeConfig,
    children,
    options,
    onRestartRequested,
    false,
    shouldStop
  );
}

/** Only replace a runtime installed by this Desktop, after its migrations finish. */
async function stopOlderBundledMemoryRuntime(
  runtimeConfig: PackagedRuntimeConfig,
  options: StartManagedRuntimeServicesOptions,
  shouldStop?: () => boolean
): Promise<boolean> {
  if (!options.offlineMemoryRuntimeDirectory || shouldStop?.()) return false;
  const serviceHome = join(dirname(runtimeConfig.configPath), "memory-service");
  let bundled: Record<string, unknown>;
  let installed: Record<string, unknown>;
  let running: Record<string, unknown>;
  try {
    [bundled, installed, running] = await Promise.all([
      readFile(join(options.offlineMemoryRuntimeDirectory, "memory-runtime.json"), "utf8"),
      readFile(join(serviceHome, "current.json"), "utf8"),
      readFile(join(serviceHome, "runtime.json"), "utf8")
    ]).then((values) => values.map((value) => JSON.parse(value) as Record<string, unknown>) as [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>]);
  } catch {
    return false;
  }
  if (!isRecord(bundled) || !isRecord(installed) || !isRecord(running)) return false;
  const bundledVersion = parseStableMemoryVersion(bundled.version);
  const installedVersion = parseStableMemoryVersion(installed.version);
  if (!bundledVersion || !installedVersion) return false;
  const difference = bundledVersion.map((part, index) => part - installedVersion[index]!).find((delta) => delta !== 0) ?? 0;
  if (difference <= 0 || bundled.protocolVersion !== SUPPORTED_MEMORY_PROTOCOL_VERSION
    || installed.protocolVersion !== SUPPORTED_MEMORY_PROTOCOL_VERSION) return false;

  // The standalone CLI records its own Node executable. Sharing a home or a
  // compatible HTTP endpoint alone does not give Desktop ownership of it.
  if (typeof installed.runtimeExecutable !== "string"
    || resolve(installed.runtimeExecutable) !== resolve(options.runtimeExecutable ?? process.execPath)
    || typeof installed.runtimeDir !== "string" || typeof installed.entrypoint !== "string") return false;
  const runtimeRelative = relative(join(serviceHome, "runtime"), installed.runtimeDir);
  if (!runtimeRelative || runtimeRelative.startsWith("..") || isAbsolute(runtimeRelative)
    || resolve(installed.entrypoint) !== resolve(installed.runtimeDir, "dist/src/server/index.js")) return false;
  const lock = readLiveMemoryServerLock(runtimeConfig.memoryDatabasePath);
  if (!lock || lock.pid === process.pid || running.pid !== lock.pid
    || typeof running.configPath !== "string" || resolve(running.configPath) !== resolve(runtimeConfig.configPath)
    || typeof running.sqlitePath !== "string" || resolve(running.sqlitePath) !== resolve(runtimeConfig.memoryDatabasePath)
    || running.endpoint !== runtimeConfig.memoryBaseUrl
    || running.serviceVersion !== installed.version
    || running.protocolVersion !== SUPPORTED_MEMORY_PROTOCOL_VERSION
    || !isPackagedMemoryServiceProcess(lock.pid, installed.entrypoint, true)) return false;

  const healthUrl = `${runtimeConfig.memoryBaseUrl}/api/v1/health`;
  const healthHeaders = memoryAuthHeaders(runtimeConfig.memoryToken);
  try {
    const response = await fetch(healthUrl, { headers: healthHeaders, cache: "no-store", signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    const health: unknown = await response.json();
    if (!response.ok || !isRecord(health) || health.ok !== true
      || health.protocolVersion !== SUPPORTED_MEMORY_PROTOCOL_VERSION
      || health.serviceVersion !== installed.version) return false;
  } catch {
    return false;
  }
  if (shouldStop?.()) return false;
  await stopPreviouslyRegisteredMemoryService(options.offlineMemoryRuntimeDirectory, runtimeConfig, options);
  const remainingLock = readLiveMemoryServerLock(runtimeConfig.memoryDatabasePath);
  if (remainingLock && remainingLock.pid !== lock.pid) {
    throw new Error("Memory database ownership changed during bundled runtime upgrade");
  }
  const probe = await probeMemoryService(healthUrl, healthHeaders);
  if (probe === "ready" && remainingLock?.pid === lock.pid) {
    await requestMemoryServiceShutdown({ baseUrl: runtimeConfig.memoryBaseUrl, token: runtimeConfig.memoryToken });
  } else if (probe !== "unreachable") {
    throw new Error("Memory endpoint ownership changed during bundled runtime upgrade");
  }
  await waitForHttpServiceStop(healthUrl, healthHeaders, MEMORY_RESTART_STOP_TIMEOUT_MS);
  // HTTP can stop accepting connections before storage and workers have
  // closed. Never switch current.json or kill an owner still releasing data.
  if (!(await waitForProcessExit(lock.pid, MEMORY_RESTART_STOP_TIMEOUT_MS))
    || readLiveMemoryServerLock(runtimeConfig.memoryDatabasePath)) {
    throw new Error("Memory database owner did not exit before bundled runtime upgrade");
  }
  return true;
}

function parseStableMemoryVersion(value: unknown): number[] | undefined {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/.test(value)) return undefined;
  const parts = value.split(".").map(Number);
  return parts.every(Number.isSafeInteger) ? parts : undefined;
}

function hasPreviousMemoryRuntimeMarker(configPath: string): boolean {
  const serviceHome = join(dirname(configPath), "memory-service");
  return existsSync(join(serviceHome, "current.json"))
    || existsSync(join(serviceHome, "runtime.json"));
}

/**
 * Stop the service-manager instance left by an older packaged Desktop before
 * taking ownership of the bundled runtime in this process. The registration
 * itself is retained for the next login, preserving standalone persistence;
 * the installer command is deliberately best effort so a stale registration
 * can never make Desktop startup fail.
 */
async function stopPreviouslyRegisteredMemoryService(
  runtimeDirectory: string,
  runtimeConfig: PackagedRuntimeConfig,
  options: StartManagedRuntimeServicesOptions
): Promise<boolean> {
  try {
    await runBundledMemoryCli(
      runtimeDirectory,
      runtimeConfig,
      options,
      ["stop", "--home", dirname(runtimeConfig.configPath)],
      MEMORY_STOP_COMMAND_TIMEOUT_MS
    );
    return true;
  } catch (error) {
    console.warn("Failed to stop a previously registered Memory service: " + errorMessage(error));
    return false;
  }
}

async function installBundledMemoryRuntime(
  runtimeDirectory: string,
  runtimeConfig: PackagedRuntimeConfig,
  options: StartManagedRuntimeServicesOptions,
  memmyConfigPreexisting: boolean
): Promise<void> {
  const cliEntry = join(runtimeDirectory, "dist", "src", "cli", "index.js");
  if (!existsSync(cliEntry)) {
    throw new Error(`Bundled Memory installer is missing: ${cliEntry}`);
  }
  const executable = options.runtimeExecutable ?? process.execPath;
  await runBundledMemoryCli(
    runtimeDirectory,
    runtimeConfig,
    options,
    bundledMemoryInstallArguments(runtimeDirectory, runtimeConfig, memmyConfigPreexisting, executable)
  );
}

export function bundledMemoryInstallArguments(
  runtimeDirectory: string,
  runtimeConfig: PackagedRuntimeConfig,
  memmyConfigPreexisting: boolean,
  nodeExecutable: string
): string[] {
  // Packaged Desktop owns this child process. Registering a per-user OS
  // service here makes signed, non-elevated installs fail on Windows
  // (schtasks) and races the direct process on macOS (launchd KeepAlive).
  return [
    "install",
    "--service-only",
    "--runtime-directory", runtimeDirectory,
    "--home", dirname(runtimeConfig.configPath),
    "--config", runtimeConfig.configPath,
    "--db", runtimeConfig.memoryDatabasePath,
    "--endpoint", runtimeConfig.memoryBaseUrl,
    "--memmy-config-preexisting", String(memmyConfigPreexisting),
    "--node-executable", nodeExecutable,
    "--non-interactive",
    "--use-compatible-installed",
    "--skip-service-registration",
    "--skip-health-check",
    "--health-check-timeout-ms", String(MEMORY_STARTUP_TIMEOUT_MS)
  ];
}

interface InstalledMemoryRuntime {
  entrypoint: string;
  runtimeDir?: string;
  runtimeExecutable?: string;
}

async function readInstalledMemoryRuntime(configPath: string): Promise<InstalledMemoryRuntime | undefined> {
  try {
    const serviceHome = join(dirname(configPath), "memory-service");
    const value = JSON.parse(
      await readFile(join(serviceHome, "current.json"), "utf8")
    ) as Record<string, unknown>;
    if (typeof value.entrypoint !== "string" || !existsSync(value.entrypoint)) return undefined;
    const runtimeDir = typeof value.runtimeDir === "string" && value.runtimeDir.trim().length > 0
      ? value.runtimeDir
      : undefined;
    const runtimeExecutable = typeof value.runtimeExecutable === "string"
      && value.runtimeExecutable.trim().length > 0
      && existsSync(value.runtimeExecutable)
      ? resolve(value.runtimeExecutable)
      : undefined;
    return {
      entrypoint: value.entrypoint,
      runtimeDir,
      ...(runtimeExecutable ? { runtimeExecutable } : {})
    };
  } catch {
    return undefined;
  }
}

async function startManagedMemoryService(
  entry: string,
  runtimeDir: string | undefined,
  runtimeExecutable: string | undefined,
  runtimeConfig: PackagedRuntimeConfig,
  children: ManagedChild[],
  options: StartManagedRuntimeServicesOptions,
  onRestartRequested?: () => void,
  requireCompatible = false,
  shouldStop?: () => boolean
): Promise<void> {
  if (shouldStop?.()) return;
  const healthUrl = runtimeConfig.memoryBaseUrl + "/api/v1/health";
  const healthHeaders = memoryAuthHeaders(runtimeConfig.memoryToken);
  const existingLock = readLiveMemoryServerLock(runtimeConfig.memoryDatabasePath);
  if (existingLock) {
    try {
      await waitForExistingMemoryService(healthUrl, healthHeaders, existingLock);
      return;
    } catch (error) {
      // A service can release its lock while the health waiter is still
      // running. In that case this Desktop instance may safely take over;
      // preserve the original error while the lock owner is still alive.
      if (readLiveMemoryServerLock(runtimeConfig.memoryDatabasePath)) throw error;
    }
  }
  if (shouldStop?.()) return;

  const memoryChild = spawnNodeService("memory", entry, [
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
    MEMMY_EMBEDDING_MODEL_ROOT: join(runtimeDir ?? options.resourcesPath, "embedding-models"),
    MEMORY_SERVICE_URL: runtimeConfig.memoryBaseUrl,
    MEMORY_SERVICE_TOKEN: runtimeConfig.memoryToken,
    MEMORY_SERVICE_DB: runtimeConfig.memoryDatabasePath,
    ...(onRestartRequested ? { [DESKTOP_MANAGED_MEMORY_ENV]: "1" } : {})
  }, {
    logFilePath: join(options.logDirectory, "memory.log"),
    logLevel: options.logLevel,
    ipc: Boolean(onRestartRequested),
    executablePath: runtimeExecutable ?? options.runtimeExecutable,
    persistOnDesktopExit: true
  });
  if (onRestartRequested) {
    memoryChild.process.on("message", (message) => {
      if (isRecord(message) && message.type === MEMORY_RESTART_IPC_TYPE) onRestartRequested();
    });
  }
  children.push(memoryChild);
  try {
    if (requireCompatible) {
      await waitForCompatibleMemoryService(
        healthUrl,
        healthHeaders,
        MEMORY_STARTUP_TIMEOUT_MS,
        memoryChild
      );
    } else {
      await waitForHttpService("memory", healthUrl, memoryChild, healthHeaders, MEMORY_STARTUP_TIMEOUT_MS);
    }
  } catch (error) {
    const lockOwner = readLiveMemoryServerLock(runtimeConfig.memoryDatabasePath);
    if (!lockOwner || lockOwner.pid === memoryChild.process.pid) {
      await stopManagedChild(memoryChild).catch(() => undefined);
      removeManagedChild(children, memoryChild);
      throw error;
    }
    await stopManagedChild(memoryChild).catch(() => undefined);
    removeManagedChild(children, memoryChild);
    await waitForExistingMemoryService(healthUrl, healthHeaders, lockOwner);
  }
}
async function runBundledMemoryCli(
  runtimeDirectory: string,
  runtimeConfig: PackagedRuntimeConfig,
  options: StartManagedRuntimeServicesOptions,
  commandArgs: string[],
  timeoutMs?: number
): Promise<void> {
  const cliEntry = join(runtimeDirectory, "dist", "src", "cli", "index.js");
  if (!existsSync(cliEntry)) throw new Error(`Bundled Memory CLI is missing: ${cliEntry}`);
  const executable = options.runtimeExecutable ?? process.execPath;
  const args = [cliEntry, ...commandArgs];
  await new Promise<void>((resolveInstall, rejectInstall) => {
    const child = spawn(executable, args, {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        NODE_ENV: process.env.NODE_ENV ?? "production",
        MEMMY_CLI_ANALYTICS_SKIP: "1",
        MEMMY_CONFIG: runtimeConfig.configPath
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let output = "";
    const append = (chunk: unknown) => { output = `${output}${String(chunk)}`.slice(-4_000); };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (error) rejectInstall(error);
      else resolveInstall();
    };
    child.once("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
    child.once("exit", (code, signal) => {
      if (code === 0) finish();
      else finish(new Error(`Bundled Memory command failed (${signal ? `signal ${signal}` : `code ${String(code)}`}): ${output.trim()}`));
    });
    if (timeoutMs !== undefined) {
      const timer = setTimeout(() => {
        finish(new Error("Bundled Memory command timed out after " + timeoutMs + "ms"));
        try { child.kill(); } catch { /* the process may already have exited */ }
      }, timeoutMs);
      timeout = timer;
      if (settled) clearTimeout(timer);
    }
  });
}

function runBundledMemoryCliSync(
  runtimeDirectory: string,
  runtimeConfig: PackagedRuntimeConfig,
  options: StartManagedRuntimeServicesOptions,
  commandArgs: string[]
): void {
  const cliEntry = join(runtimeDirectory, "dist", "src", "cli", "index.js");
  if (!existsSync(cliEntry)) return;
  try {
    execFileSync(options.runtimeExecutable ?? process.execPath, [cliEntry, ...commandArgs], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        NODE_ENV: process.env.NODE_ENV ?? "production",
        MEMMY_CLI_ANALYTICS_SKIP: "1",
        MEMMY_CONFIG: runtimeConfig.configPath
      },
      stdio: "ignore",
      timeout: 6_000,
      windowsHide: true
    });
  } catch (error) {
    console.warn(`Failed to stop the Memory service during forced Desktop shutdown: ${errorMessage(error)}`);
  }
}

async function stopManagedMemoryChild(
  child: ManagedChild,
  healthUrl: string,
  healthHeaders: Record<string, string>,
  runtimeConfig: PackagedRuntimeConfig
): Promise<void> {
  try {
    if (await probeMemoryService(healthUrl, healthHeaders) === "ready") {
      await requestMemoryServiceShutdown({
        baseUrl: runtimeConfig.memoryBaseUrl,
        token: runtimeConfig.memoryToken
      });
      await waitForHttpServiceStop(healthUrl, healthHeaders, MEMORY_RESTART_STOP_TIMEOUT_MS);
      if (isManagedChildRunning(child)) {
        await stopManagedChild(child);
      }
      return;
    }
  } catch (error) {
    console.warn("Graceful Memory shutdown failed; falling back to process stop: " + errorMessage(error));
  }
  await stopManagedChild(child);
}

async function restartManagedMemoryService(
  entries: RuntimeEntryPaths,
  runtimeConfig: PackagedRuntimeConfig,
  children: ManagedChild[],
  options: StartManagedRuntimeServicesOptions,
  onRestartRequested?: () => void
): Promise<void> {
  const healthUrl = `${runtimeConfig.memoryBaseUrl}/api/v1/health`;
  const healthHeaders = memoryAuthHeaders(runtimeConfig.memoryToken);
  const managedMemory = children.filter((child) => child.name === "memory" && isManagedChildRunning(child));
  const installed = options.offlineMemoryRuntimeDirectory
    ? await readInstalledMemoryRuntime(runtimeConfig.configPath)
    : undefined;
  let managerStopAttempted = false;

  if (managedMemory.length > 0) {
    await Promise.all(managedMemory.map((child) => stopManagedMemoryChild(
      child,
      healthUrl,
      healthHeaders,
      runtimeConfig
    )));
  } else {
    // Inspect the endpoint and sqlite lock before touching launchd/schtasks.
    // A live lock can represent a legitimate migration that has not exposed
    // HTTP yet; stopping it first would make the next process race the same DB.
    let probe = await probeHttpService(healthUrl, healthHeaders);
    if (probe === "unexpected") {
      throw new Error(`Memory endpoint is occupied by an unexpected service: ${healthUrl}`);
    }
    const lock = probe === "unreachable"
      ? readLiveMemoryServerLock(runtimeConfig.memoryDatabasePath)
      : null;
    if (lock) {
      try {
        await waitForExistingMemoryService(healthUrl, healthHeaders, lock);
        probe = "ready";
      } catch {
        // If the owner is still alive, stop only after it has failed its
        // bounded compatibility wait. If it exited, continue with install.
        if (readLiveMemoryServerLock(runtimeConfig.memoryDatabasePath)) {
          await stopLockedMemoryService(
            runtimeConfig.memoryDatabasePath,
            installed?.entrypoint ?? entries.memoryEntry
          );
        }
        probe = await probeHttpService(healthUrl, healthHeaders);
        if (probe === "unexpected") {
          throw new Error(`Memory endpoint is occupied by an unexpected service: ${healthUrl}`);
        }
      }
    }
    if (options.offlineMemoryRuntimeDirectory && hasPreviousMemoryRuntimeMarker(runtimeConfig.configPath)) {
      managerStopAttempted = await stopPreviouslyRegisteredMemoryService(
        options.offlineMemoryRuntimeDirectory,
        runtimeConfig,
        options
      );
      // The CLI stop command normally shuts the endpoint down itself. Reprobe
      // because an already-running KeepAlive manager may have restarted it.
      probe = await probeHttpService(healthUrl, healthHeaders);
      if (probe === "unexpected") {
        throw new Error(`Memory endpoint is occupied by an unexpected service: ${healthUrl}`);
      }
    }
    if (probe === "ready") {
      try {
        await requestMemoryServiceShutdown({
          baseUrl: runtimeConfig.memoryBaseUrl,
          token: runtimeConfig.memoryToken
        });
      } catch (error) {
        console.warn("Memory service shutdown request failed during restart: " + errorMessage(error));
        const lockAfterFailure = readLiveMemoryServerLock(runtimeConfig.memoryDatabasePath);
        if (lockAfterFailure) {
          await stopLockedMemoryService(
            runtimeConfig.memoryDatabasePath,
            installed?.entrypoint ?? entries.memoryEntry
          );
        }
      }
    } else if (probe === "unreachable") {
      const lockAfterProbe = readLiveMemoryServerLock(runtimeConfig.memoryDatabasePath);
      if (lockAfterProbe) {
        try {
          await waitForExistingMemoryService(healthUrl, healthHeaders, lockAfterProbe);
          await requestMemoryServiceShutdown({
            baseUrl: runtimeConfig.memoryBaseUrl,
            token: runtimeConfig.memoryToken
          });
        } catch {
          await stopLockedMemoryService(
            runtimeConfig.memoryDatabasePath,
            installed?.entrypoint ?? entries.memoryEntry
          );
        }
      }
    }
  }

  removeManagedChildrenByName(children, "memory");
  try {
    await waitForHttpServiceStop(
      healthUrl,
      healthHeaders,
      options.offlineMemoryRuntimeDirectory ? MEMORY_RESTART_STOP_TIMEOUT_MS : undefined
    );
  } catch (error) {
    // launchd KeepAlive can legitimately bring the standalone service back
    // before the stop poll observes a gap. A compatible endpoint is already
    // a valid restart result; ensureMemoryService will reuse it.
    if (!options.offlineMemoryRuntimeDirectory || !managerStopAttempted || (await probeMemoryService(healthUrl, healthHeaders)) !== "ready") {
      throw error;
    }
  }
  await ensureMemoryService(entries, runtimeConfig, children, options, true, onRestartRequested);
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

export async function startAgentGatewayWithRecovery(
  supervisor: Pick<AgentGatewaySupervisor, "ensureStarted" | "startRecovery">
): Promise<AgentGatewayStartupIssue | null> {
  try {
    await supervisor.ensureStarted();
    return null;
  } catch (error) {
    console.warn(`Agent gateway unavailable during desktop startup: ${errorMessage(error)}`);
    supervisor.startRecovery();
    return classifyAgentGatewayStartupIssue(error);
  }
}

function classifyAgentGatewayStartupIssue(error: unknown): AgentGatewayStartupIssue | null {
  const message = errorMessage(error);
  return /failed to load config[\s\S]*\b(providers|modelPresets|modelAssignments|agents\.defaults)\b/i.test(message)
    ? "model_config_invalid"
    : null;
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
    private readonly options: StartManagedRuntimeServicesOptions,
    dependencies: AgentGatewaySupervisorDependencies = {},
    private readonly browserPreparationAttemptId: string =
      process.env[BROWSER_PREPARATION_ATTEMPT_ID_ENV]?.trim() || ""
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

  startRecovery(): void {
    if (this.stopping || this.hasReachedReady) return;
    this.scheduleReplacement();
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
      [MIGRATIONS_READY_CONFIG_ENV]: this.runtimeConfig.configPath,
      [MIGRATIONS_READY_WORKSPACE_ENV]: this.runtimeConfig.agentWorkspace,
      [MIGRATIONS_READY_SESSION_DAG_ENV]: sessionDagMigrationTarget(
        this.runtimeConfig.agentWorkspace
      ),
      ...(this.runtimeConfig.appDatabaseFile
        ? {
            [APP_DATABASE_ENV]: this.runtimeConfig.appDatabaseFile,
            [MIGRATIONS_READY_APP_DATABASE_ENV]: this.runtimeConfig.appDatabaseFile
          }
        : {}),
      [DESKTOP_MANAGED_GATEWAY_ENV]: "1",
      ...(this.browserPreparationAttemptId
        ? { [BROWSER_PREPARATION_ATTEMPT_ID_ENV]: this.browserPreparationAttemptId }
        : {}),
      ...(notice ? restartNoticeEnv(notice) : {})
    }, {
      logFilePath: join(this.options.logDirectory, "agent-gateway.log"),
      logLevel: this.options.logLevel,
      ipc: true,
      executablePath: this.options.runtimeExecutable
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
      if (!this.hasReachedReady) {
        this.scheduleReplacement();
      }
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

export function resolveDevelopmentRuntimeEntryPaths(mainDirectory: string): RuntimeEntryPaths {
  const repoRoot = resolve(mainDirectory, "../../../../..");
  return {
    memoryEntry: join(repoRoot, "Memory", "dist", "src", "server", "index.js"),
    agentEntry: join(repoRoot, "App", "memmy-agent", "dist", "main.js")
  };
}

export function resolveDevelopmentRuntimeExecutable(
  env: NodeJS.ProcessEnv = process.env
): string {
  return env.MEMMY_RUNTIME_NODE_PATH?.trim()
    || env.npm_node_execpath?.trim()
    || "node";
}

export function resolveRuntimeEntryPaths(options: StartManagedRuntimeServicesOptions): RuntimeEntryPaths {
  if (options.runtimeEntries) {
    return { ...options.runtimeEntries };
  }
  return {
    memoryEntry: options.offlineMemoryRuntimeDirectory
      ? join(options.offlineMemoryRuntimeDirectory, "dist/src/server/index.js")
      : join(options.appPath, "dist/runtime/memory/dist/src/server/index.js"),
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
  const persistOnDesktopExit = logOptions.persistOnDesktopExit === true;
  let logFileDescriptor: number | undefined;
  if (persistOnDesktopExit) {
    mkdirSync(dirname(logOptions.logFilePath), { recursive: true });
    logFileDescriptor = openSync(logOptions.logFilePath, "a", 0o600);
  }
  let child: ChildProcess;
  try {
    child = spawn(logOptions.executablePath ?? process.execPath, [entry, ...args], {
      env: childEnv,
      stdio: persistOnDesktopExit
        ? logOptions.ipc
          ? ["ignore", logFileDescriptor!, logFileDescriptor!, "ipc"]
          : ["ignore", logFileDescriptor!, logFileDescriptor!]
        : logOptions.ipc
          ? ["ignore", "pipe", "pipe", "ipc"]
          : ["ignore", "pipe", "pipe"],
      detached: persistOnDesktopExit,
      windowsHide: true
    });
  } finally {
    if (logFileDescriptor !== undefined) closeSync(logFileDescriptor);
  }
  const logWriter = persistOnDesktopExit
    ? null
    : createRotatingWriter({
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
    logWriter,
    persistOnDesktopExit
  };

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    const text = String(chunk);
    appendTail(managed.stdoutTail, text);
    logWriter?.write(text);
  });
  child.stderr?.on("data", (chunk) => {
    const text = String(chunk);
    appendTail(managed.stderrTail, text);
    logWriter?.write(text);
  });
  child.once("error", (error) => {
    managed.exitDescription ??= "error " + errorMessage(error);
    logWriter?.write(managed.exitDescription + "\n");
    managed.logWriter?.close();
  });
  child.once("exit", (code, signal) => {
    managed.exitDescription ??= signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
    managed.logWriter?.close();
  });
  if (persistOnDesktopExit) {
    child.unref();
    child.channel?.unref();
  }

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

async function probeMemoryService(url: string, headers: Record<string, string> = {}): Promise<HttpProbeResult | "incompatible"> {
  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
    });
    if (!response.ok) return "unexpected";
    const body = await response.json() as { ok?: unknown; protocolVersion?: unknown };
    if (body.ok !== true) return "unexpected";
    return body.protocolVersion === SUPPORTED_MEMORY_PROTOCOL_VERSION ? "ready" : "incompatible";
  } catch {
    return "unreachable";
  }
}

async function waitForCompatibleMemoryService(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  child?: ManagedChild,
  lock?: MemoryServerLock
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastProbe: HttpProbeResult | "incompatible" = "unreachable";
  while (Date.now() < deadline) {
    if (child?.exitDescription) {
      throw new Error(
        "memory exited before it became compatible (" + child.exitDescription + "). " + formatChildTail(child)
      );
    }
    if (lock && !isProcessAlive(lock.pid)) {
      throw new Error("memory lock owner pid " + lock.pid + " exited before it became compatible");
    }
    lastProbe = await probeMemoryService(url, headers);
    if (lastProbe === "ready") return;
    if (lastProbe === "incompatible") {
      throw new Error(`Memory protocol at ${url} is incompatible with Desktop protocol ${SUPPORTED_MEMORY_PROTOCOL_VERSION}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error("Memory did not become compatible at " + url + " (" + lastProbe + ")" + (child ? ". " + formatChildTail(child) : ""));
}

async function waitForHttpServiceStop(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = STARTUP_TIMEOUT_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
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
  headers: Record<string, string> = {},
  timeoutMs = STARTUP_TIMEOUT_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
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

export function readLiveMemoryServerLock(databasePath: string): MemoryServerLock | null {
  const lockPath = `${resolve(databasePath)}.server.lock`;
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, unknown>;
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
      return null;
    }
    if (typeof parsed.sqlitePath === "string" && resolve(parsed.sqlitePath) !== resolve(databasePath)) {
      return null;
    }
    if (!isProcessAlive(parsed.pid)) {
      return null;
    }
    return {
      pid: parsed.pid,
      ...(typeof parsed.host === "string" ? { host: parsed.host } : {}),
      ...(typeof parsed.port === "number" ? { port: parsed.port } : {}),
      ...(typeof parsed.sqlitePath === "string" ? { sqlitePath: parsed.sqlitePath } : {})
    };
  } catch {
    return null;
  }
}

async function waitForExistingMemoryService(
  healthUrl: string,
  healthHeaders: Record<string, string>,
  lock: MemoryServerLock
): Promise<void> {
  try {
    await waitForCompatibleMemoryService(
      healthUrl,
      healthHeaders,
      MEMORY_STARTUP_TIMEOUT_MS,
      undefined,
      lock
    );
  } catch (error) {
    throw new Error(
      `Existing Memory service pid ${lock.pid} did not become ready at ${healthUrl}: ${errorMessage(error)}`
    );
  }
}

async function stopLockedMemoryService(databasePath: string, memoryEntry: string): Promise<void> {
  const lock = readLiveMemoryServerLock(databasePath);
  if (!lock) return;
  if (lock.pid === process.pid) {
    throw new Error("Memory server lock unexpectedly belongs to the desktop process");
  }
  if (!isPackagedMemoryServiceProcess(lock.pid, memoryEntry)) {
    throw new Error(`Refusing to stop unverified process pid ${lock.pid} from the Memory server lock`);
  }

  terminateProcessByPid(lock.pid, false);
  if (await waitForProcessExit(lock.pid, STOP_MANAGED_CHILD_GRACE_MS)) return;
  terminateProcessByPid(lock.pid, true);
  if (!(await waitForProcessExit(lock.pid, STOP_MANAGED_CHILD_GRACE_MS))) {
    throw new Error(`Memory service pid ${lock.pid} did not exit`);
  }
}

function isPackagedMemoryServiceProcess(pid: number, memoryEntry: string, exactEntryOnly = false): boolean {
  try {
    const command = process.platform === "win32"
      ? execFileSync("powershell.exe", [
        "-NoProfile",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\").CommandLine`
      ], { encoding: "utf8", windowsHide: true })
      : execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
    const normalizedCommand = command.replaceAll("\\", "/");
    const normalizedEntry = resolve(memoryEntry).replaceAll("\\", "/");
    return normalizedCommand.includes(normalizedEntry)
      || (!exactEntryOnly && (normalizedCommand.includes("/memory-runtime/dist/src/server/index.js")
        || normalizedCommand.includes("/dist/runtime/memory/src/server/index.js")));
  } catch {
    return false;
  }
}

function terminateProcessByPid(pid: number, force: boolean): void {
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", [...(force ? ["/F"] : []), "/T", "/PID", String(pid)], { stdio: "ignore" });
    } else {
      process.kill(pid, force ? "SIGKILL" : "SIGTERM");
    }
  } catch {
    // The process may already have exited.
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await sleep(50);
  }
  return !isProcessAlive(pid);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function waitForHttpService(
  name: string,
  url: string,
  child: ManagedChild,
  headers: Record<string, string> = {},
  timeoutMs = STARTUP_TIMEOUT_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
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

export async function stopManagedChildrenForDesktopExit(
  children: ManagedChild[],
  stopMemory: boolean
): Promise<void> {
  await stopManagedChildren(children.filter((child) => stopMemory || !child.persistOnDesktopExit));
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

function removeManagedChild(children: ManagedChild[], child: ManagedChild): void {
  const index = children.indexOf(child);
  if (index >= 0) children.splice(index, 1);
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
    terminateProcessTreeSync(child.process);
  }
}

export function terminateManagedChildrenForDesktopExit(
  children: ManagedChild[],
  stopMemory: boolean
): void {
  terminateManagedChildrenSync(children.filter((child) => stopMemory || !child.persistOnDesktopExit));
}

function terminateProcessTreeSync(child: ChildProcess): void {
  if (child.exitCode != null || child.signalCode != null) return;
  const pid = child.pid;
  if (process.platform === "win32" && pid !== undefined) {
    try {
      execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
      return;
    } catch {
      // Fall through to the direct-child fallback if taskkill cannot inspect the process tree.
    }
  }
  if (process.platform !== "win32" && pid !== undefined) {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      // Fall through if the detached process group has already exited.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // The process may already have exited or we may lack permission; ignore.
  }
}

export async function stopManagedChild(child: ManagedChild): Promise<void> {
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
    await waitForManagedChildExit(child, STOP_MANAGED_CHILD_GRACE_MS);
    return;
  }

  child.process.kill();
  if (await waitForManagedChildExit(child, STOP_MANAGED_CHILD_GRACE_MS)) return;
  child.process.kill("SIGKILL");
  await waitForManagedChildExit(child, STOP_MANAGED_CHILD_GRACE_MS);
}

async function waitForManagedChildExit(child: ManagedChild, timeoutMs: number): Promise<boolean> {
  if (!isManagedChildRunning(child)) return true;
  return new Promise<boolean>((resolveExit) => {
    const onExit = () => {
      clearTimeout(timer);
      resolveExit(true);
    };
    const timer = setTimeout(() => {
      child.process.off("exit", onExit);
      resolveExit(!isManagedChildRunning(child));
    }, timeoutMs);
    child.process.once("exit", onExit);
  });
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
