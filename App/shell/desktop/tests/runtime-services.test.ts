import { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentGatewaySupervisor,
  preparePackagedRuntimeConfig,
  restartExternalMemoryService,
  spawnNodeService,
  syncBundledAgentSkills,
  type ManagedChild,
  type PackagedRuntimeConfig,
  type RuntimeEntryPaths,
  type StartPackagedRuntimeServicesOptions
} from "../src/main/runtime-services.js";

const tempRoots: string[] = [];
const testServers: Server[] = [];
type ConfigRecord = Record<string, unknown>;

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memmy-desktop-runtime-"));
  tempRoots.push(root);
  return root;
}

async function readYaml(path: string): Promise<ConfigRecord> {
  const parsed = YAML.parse(await readFile(path, "utf8"));
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as ConfigRecord : {};
}

function recordValue(parent: ConfigRecord, key: string): ConfigRecord {
  const value = parent[key];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as ConfigRecord;
  }
  throw new Error(`Expected ${key} to be an object`);
}

describe("packaged desktop runtime config", () => {
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await Promise.all(testServers.splice(0).map((server) => new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
      server.closeAllConnections();
    })));
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("requests a supervised Memory shutdown and waits for the replacement service", async () => {
    let shutdownRequests = 0;
    let activeServer: Server;
    let port = 0;

    const startServer = async () => {
      activeServer = createServer((request, response) => {
        expect(request.headers.authorization).toBe("Bearer memory-token");
        if (request.method === "GET" && request.url === "/api/v1/health") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: true }));
          return;
        }
        if (request.method === "POST" && request.url === "/api/v1/admin/shutdown") {
          shutdownRequests += 1;
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ accepted: true }));
          response.once("finish", () => {
            activeServer.close();
            activeServer.closeAllConnections();
            setTimeout(() => void startServer(), 250);
          });
          return;
        }
        response.writeHead(404);
        response.end();
      });
      testServers.push(activeServer);
      await new Promise<void>((resolveListen, rejectListen) => {
        activeServer.once("error", rejectListen);
        activeServer.listen(port, "127.0.0.1", () => {
          activeServer.off("error", rejectListen);
          const address = activeServer.address();
          if (!address || typeof address === "string") {
            rejectListen(new Error("expected TCP address"));
            return;
          }
          port = address.port;
          resolveListen();
        });
      });
    };

    await startServer();
    await restartExternalMemoryService({
      baseUrl: `http://127.0.0.1:${port}`,
      token: "memory-token"
    });

    expect(shutdownRequests).toBe(1);
  });

  it("creates missing packaged runtime config under the shared ~/.memmy home", async () => {
    const memmyHome = await makeTempRoot();
    const configPath = join(memmyHome, "config.yaml");

    const runtime = await preparePackagedRuntimeConfig({
      env: { MEMMY_HOME: memmyHome },
      secretFactory: () => "stable-secret"
    });
    const config = await readYaml(configPath);

    expect(runtime).toMatchObject({
      configPath,
      agentWorkspace: join(memmyHome, "workspace"),
      memoryDatabasePath: join(memmyHome, "memory-service", "memory.sqlite"),
      memoryBaseUrl: "http://127.0.0.1:18960",
      memoryListenHost: "127.0.0.1",
      memoryListenPort: 18960,
      agentGatewayBaseUrl: "http://127.0.0.1:18980",
      agentGatewayBootstrapSecret: "stable-secret"
    });
    expect(config).toMatchObject({
      agents: {
        defaults: {
          model: "custom/memmy-desktop",
          provider: "custom",
          workspace: join(memmyHome, "workspace")
        }
      },
      channels: {
        websocket: {
          enabled: true,
          host: "127.0.0.1",
          port: 18980,
          tokenIssueSecret: "stable-secret",
          websocketRequiresToken: true,
          allowFrom: ["*"]
        }
      },
      gateway: {
        host: "127.0.0.1",
        port: 18970,
        heartbeat: { enabled: false }
      },
      memmyMemory: {
        storage: {
          mode: "local",
          backend: "sqlite",
          sqlitePath: join(memmyHome, "memory-service", "memory.sqlite"),
          endpoint: "http://127.0.0.1:18960"
        }
      }
    });
    await expect(stat(join(memmyHome, "workspace"))).resolves.toBeTruthy();
    await expect(stat(join(memmyHome, "memory-service"))).resolves.toBeTruthy();
  });

  it("preserves existing user model, memory, and websocket settings", async () => {
    const memmyHome = await makeTempRoot();
    const configPath = join(memmyHome, "config.yaml");
    const workspace = join(memmyHome, "custom-workspace");
    const sqlitePath = join(memmyHome, "db", "memory.sqlite");
    await writeFile(configPath, YAML.stringify({
      agents: {
        defaults: {
          model: "anthropic/claude-sonnet",
          provider: "anthropic",
          workspace
        }
      },
      channels: {
        websocket: {
          host: "0.0.0.0",
          port: 19998,
          tokenIssueSecret: "existing-secret",
          websocketRequiresToken: false
        }
      },
      gateway: {
        host: "127.0.0.1",
        port: 19997,
        heartbeat: { enabled: true }
      },
      memmyMemory: {
        storage: {
          endpoint: "http://127.0.0.1:18888",
          token: "memory-token",
          sqlitePath
        }
      },
      providers: {
        anthropic: { apiKey: "sk-test" }
      }
    }), "utf8");

    const runtime = await preparePackagedRuntimeConfig({
      env: { MEMMY_CONFIG: configPath },
      secretFactory: () => "new-secret"
    });
    const config = await readYaml(configPath);

    expect(runtime).toMatchObject({
      agentWorkspace: workspace,
      memoryDatabasePath: sqlitePath,
      memoryBaseUrl: "http://127.0.0.1:18888",
      memoryToken: "memory-token",
      agentGatewayBaseUrl: "http://127.0.0.1:19998",
      agentGatewayBootstrapSecret: "existing-secret",
      agentGatewayHealthHost: "127.0.0.1",
      agentGatewayHealthPort: 19997
    });
    expect(recordValue(recordValue(config, "agents"), "defaults")).toMatchObject({
      model: "anthropic/claude-sonnet",
      provider: "anthropic",
      workspace
    });
    expect(recordValue(recordValue(config, "channels"), "websocket")).toMatchObject({
      host: "0.0.0.0",
      port: 19998,
      tokenIssueSecret: "existing-secret",
      websocketRequiresToken: false
    });
    expect(recordValue(recordValue(config, "memmyMemory"), "storage")).toMatchObject({
      endpoint: "http://127.0.0.1:18888",
      token: "memory-token",
      sqlitePath
    });
  });

  it("repairs missing memory active profile when profiles are configured", async () => {
    const memmyHome = await makeTempRoot();
    const configPath = join(memmyHome, "config.yaml");
    await writeFile(configPath, YAML.stringify({
      memmyMemory: {
        storage: {
          endpoint: "http://127.0.0.1:18888"
        },
        profiles: {
          byok: {
            summary: {
              provider: "openai_compatible",
              endpoint: "https://api.example.com/v1",
              model: "memory-model",
              apiKey: "sk-memory"
            },
            embedding: {
              provider: "local"
            }
          }
        }
      }
    }), "utf8");

    await preparePackagedRuntimeConfig({
      env: { MEMMY_CONFIG: configPath },
      secretFactory: () => "stable-secret"
    });
    const config = await readYaml(configPath);

    expect(recordValue(config, "memmyMemory")).toMatchObject({
      activeProfile: "byok",
      profiles: {
        byok: {
          summary: {
            provider: "openai_compatible",
            endpoint: "https://api.example.com/v1",
            model: "memory-model",
            apiKey: "sk-memory"
          }
        }
      }
    });
  });

  it("can resolve defaults without writing config or creating runtime directories", async () => {
    const memmyHome = await makeTempRoot();
    const configPath = join(memmyHome, "config.yaml");

    const runtime = await preparePackagedRuntimeConfig({
      ensureDirectories: false,
      env: { MEMMY_HOME: memmyHome },
      fillMissingAgentSecret: false,
      secretFactory: () => "unused-secret",
      writeConfig: false
    });

    expect(runtime).toMatchObject({
      configPath,
      agentGatewayBaseUrl: "http://127.0.0.1:18980",
      agentGatewayBootstrapSecret: ""
    });
    await expect(stat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(memmyHome, "workspace"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(memmyHome, "memory-service"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("syncs bundled agent skills into the packaged runtime workspace", async () => {
    const root = await makeTempRoot();
    const runtimeDist = join(root, "runtime", "memmy-agent", "dist");
    const agentEntry = join(runtimeDist, "main.js");
    const agentWorkspace = join(root, "home", "workspace");

    await mkdir(join(runtimeDist, "skills", "example", "references"), { recursive: true });
    await writeFile(agentEntry, "", "utf8");
    await writeFile(join(runtimeDist, "skills", "example", "SKILL.md"), "# Example\n", "utf8");
    await writeFile(join(runtimeDist, "skills", "example", "references", "guide.md"), "guide\n", "utf8");

    await syncBundledAgentSkills({ agentEntry, agentWorkspace });

    await expect(readFile(join(agentWorkspace, "skills", "example", "SKILL.md"), "utf8"))
      .resolves.toBe("# Example\n");
    await expect(readFile(join(agentWorkspace, "skills", "example", "references", "guide.md"), "utf8"))
      .resolves.toBe("guide\n");
  });
});

describe("AgentGatewaySupervisor", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("uses one in-flight startup and leaves an already-running external gateway alone", async () => {
    let resolveProbe: ((result: "ready") => void) | null = null;
    const probe = vi.fn(() => new Promise<"ready">((resolve) => {
      resolveProbe = resolve;
    }));
    const harness = createSupervisorHarness({ probe });

    const first = harness.supervisor.ensureStarted();
    const second = harness.supervisor.ensureStarted();

    expect(second).toBe(first);
    expect(probe).toHaveBeenCalledTimes(1);
    resolveProbe?.("ready");
    await Promise.all([first, second]);

    expect(harness.supervisor.ownership).toBe("external");
    expect(harness.spawn).not.toHaveBeenCalled();
    expect(harness.children).toEqual([]);
  });

  it("fails initial startup cleanly without starting an infinite replacement loop", async () => {
    vi.useFakeTimers();
    const harness = createSupervisorHarness({
      waitForHttpService: vi.fn(async () => {
        throw new Error("startup timeout");
      }),
      stopManagedChild: vi.fn(async (child: ManagedChild) => {
        emitChildClose(child, 1);
      })
    });

    await expect(harness.supervisor.ensureStarted()).rejects.toThrow("startup timeout");
    await vi.advanceTimersByTimeAsync(60_000);

    expect(harness.spawn).toHaveBeenCalledTimes(1);
    expect(harness.supervisor.hasReachedReady).toBe(false);
    expect(harness.supervisor.restartTimer).toBeNull();
  });

  it("restarts an owned gateway with bounded escalating delays and ignores old child callbacks", async () => {
    vi.useFakeTimers();
    const harness = createSupervisorHarness();
    await harness.supervisor.ensureStarted();
    const first = harness.spawned[0]!;

    emitChildClose(first, 1);
    await vi.advanceTimersByTimeAsync(249);
    expect(harness.spawn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.spawn).toHaveBeenCalledTimes(2);

    const second = harness.spawned[1]!;
    emitChildClose(first, 1);
    emitChildClose(second, 1);
    await vi.advanceTimersByTimeAsync(999);
    expect(harness.spawn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.spawn).toHaveBeenCalledTimes(3);

    emitChildClose(harness.spawned[2]!, 1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(harness.spawn).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.spawn).toHaveBeenCalledTimes(4);

    emitChildClose(harness.spawned[3]!, 1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(harness.spawn).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.spawn).toHaveBeenCalledTimes(5);

    emitChildClose(harness.spawned[4]!, 1);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(harness.spawn).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.spawn).toHaveBeenCalledTimes(6);

    emitChildClose(harness.spawned[5]!, 1);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(harness.spawn).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.spawn).toHaveBeenCalledTimes(7);
  });

  it("moves to the next backoff step when a replacement never becomes ready", async () => {
    vi.useFakeTimers();
    const waitForHttpService = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("replacement timeout"))
      .mockResolvedValueOnce(undefined);
    const stopManagedChild = vi.fn(async (child: ManagedChild) => {
      emitChildClose(child, 1);
    });
    const harness = createSupervisorHarness({ waitForHttpService, stopManagedChild });
    await harness.supervisor.ensureStarted();

    emitChildClose(harness.spawned[0]!, 1);
    await vi.advanceTimersByTimeAsync(250);
    expect(harness.spawn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(harness.spawn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.spawn).toHaveBeenCalledTimes(3);
  });

  it("resets the crash backoff after an owned replacement stays ready for 30 seconds", async () => {
    vi.useFakeTimers();
    const harness = createSupervisorHarness();
    await harness.supervisor.ensureStarted();
    emitChildClose(harness.spawned[0]!, 1);
    await vi.advanceTimersByTimeAsync(250);
    expect(harness.spawn).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.supervisor.restartAttempt).toBe(0);
    emitChildClose(harness.spawned[1]!, 1);
    await vi.advanceTimersByTimeAsync(249);
    expect(harness.spawn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.spawn).toHaveBeenCalledTimes(3);
  });

  it("stops a still-running child after an error and schedules only one replacement on close", async () => {
    vi.useFakeTimers();
    const stop = vi.fn(async (child: ManagedChild) => {
      emitChildClose(child, 1);
    });
    const harness = createSupervisorHarness({ stopManagedChild: stop });
    await harness.supervisor.ensureStarted();
    const first = harness.spawned[0]!;

    first.process.emit("error", new Error("spawn pipe failed"));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(stop).toHaveBeenCalledTimes(1);
    expect(harness.spawn).toHaveBeenCalledTimes(2);
  });

  it("switches to external ownership if another gateway appears during replacement delay", async () => {
    vi.useFakeTimers();
    const probe = vi.fn()
      .mockResolvedValueOnce("unreachable")
      .mockResolvedValueOnce("ready");
    const harness = createSupervisorHarness({ probe });
    await harness.supervisor.ensureStarted();

    emitChildClose(harness.spawned[0]!, 1);
    await vi.advanceTimersByTimeAsync(250);

    expect(harness.supervisor.ownership).toBe("external");
    expect(harness.spawn).toHaveBeenCalledTimes(1);
    expect(harness.supervisor.ownedChild).toBeNull();
  });

  it("passes one valid managed restart notice to an exit-75 replacement", async () => {
    vi.useFakeTimers();
    const harness = createSupervisorHarness();
    await harness.supervisor.ensureStarted();
    const first = harness.spawned[0]!;
    first.process.emit("message", {
      type: "memmy-agent:restart",
      channel: "websocket",
      chatId: "chat-1",
      startedAt: "123.5",
      metadata: { reason: "command" }
    });

    emitChildClose(first, 75);
    await vi.advanceTimersByTimeAsync(250);

    expect(harness.spawn).toHaveBeenCalledTimes(2);
    expect(harness.spawn.mock.calls[1]?.[3]).toMatchObject({
      MEMMY_DESKTOP_MANAGED_GATEWAY: "1",
      MEMMY_AGENT_RESTART_NOTIFY_CHANNEL: "websocket",
      MEMMY_AGENT_RESTART_NOTIFY_CHAT_ID: "chat-1",
      MEMMY_AGENT_RESTART_STARTED_AT: "123.5",
      MEMMY_AGENT_RESTART_NOTIFY_METADATA: JSON.stringify({ reason: "command" })
    });
  });

  it("keeps a managed restart notice until a replacement reaches readiness", async () => {
    vi.useFakeTimers();
    const waitForHttpService = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("replacement timeout"))
      .mockResolvedValueOnce(undefined);
    const stopManagedChild = vi.fn(async (child: ManagedChild) => {
      emitChildClose(child, 1);
    });
    const harness = createSupervisorHarness({ waitForHttpService, stopManagedChild });
    await harness.supervisor.ensureStarted();
    const first = harness.spawned[0]!;
    first.process.emit("message", {
      type: "memmy-agent:restart",
      channel: "websocket",
      chatId: "chat-1",
      startedAt: "123.5",
      metadata: { reason: "command" }
    });

    emitChildClose(first, 75);
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(harness.spawn).toHaveBeenCalledTimes(3);
    expect(harness.spawn.mock.calls[2]?.[3]).toMatchObject({
      MEMMY_AGENT_RESTART_NOTIFY_CHANNEL: "websocket",
      MEMMY_AGENT_RESTART_NOTIFY_CHAT_ID: "chat-1",
      MEMMY_AGENT_RESTART_STARTED_AT: "123.5",
      MEMMY_AGENT_RESTART_NOTIFY_METADATA: JSON.stringify({ reason: "command" })
    });
  });

  it("rejects invalid managed restart IPC and never respawns after shutdown", async () => {
    vi.useFakeTimers();
    const harness = createSupervisorHarness();
    await harness.supervisor.ensureStarted();
    const first = harness.spawned[0]!;
    first.process.emit("message", {
      type: "memmy-agent:restart",
      channel: "websocket",
      chatId: "chat-1",
      startedAt: "",
      metadata: {},
      unexpected: true
    });
    emitChildClose(first, 75);

    await harness.supervisor.close();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(harness.spawn).toHaveBeenCalledTimes(1);
    expect(harness.supervisor.stopping).toBe(true);
    expect(harness.supervisor.restartTimer).toBeNull();
  });
});

describe("spawnNodeService 落盘与 env 注入", () => {
  it("把子进程 stdout 落盘到指定日志文件", async () => {
    const root = await makeTempRoot();
    const entry = join(root, "entry.js");
    await writeFile(entry, "process.stdout.write('hello-from-child\\n');\n");
    const logFile = join(root, "memory.log");

    const managed = spawnNodeService("memory", entry, [], {}, {
      logFilePath: logFile,
      logLevel: "info"
    });
    await new Promise<void>((done) => managed.process.once("exit", () => done()));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));

    expect(await readFile(logFile, "utf8")).toContain("hello-from-child");
  });

  it("把 MEMMY_LOG_LEVEL 注入子进程环境", async () => {
    const root = await makeTempRoot();
    const entry = join(root, "entry.js");
    await writeFile(entry, "process.stdout.write(process.env.MEMMY_LOG_LEVEL ?? 'unset');\n");
    const logFile = join(root, "agent-gateway.log");

    const managed = spawnNodeService("agent-gateway", entry, [], {}, {
      logFilePath: logFile,
      logLevel: "debug"
    });
    await new Promise<void>((done) => managed.process.once("exit", () => done()));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));

    expect(await readFile(logFile, "utf8")).toContain("debug");
  });
});

function createSupervisorHarness(overrides: {
  probe?: ReturnType<typeof vi.fn>;
  waitForHttpService?: ReturnType<typeof vi.fn>;
  stopManagedChild?: ReturnType<typeof vi.fn>;
} = {}) {
  const entries: RuntimeEntryPaths = {
    memoryEntry: "/runtime/memory.js",
    agentEntry: "/runtime/agent.js"
  };
  const runtimeConfig: PackagedRuntimeConfig = {
    configPath: "/memmy/config.yaml",
    agentWorkspace: "/memmy/workspace",
    memoryDatabasePath: "/memmy/memory.sqlite",
    memoryBaseUrl: "http://127.0.0.1:18960",
    memoryToken: "memory-token",
    memoryListenHost: "127.0.0.1",
    memoryListenPort: 18960,
    agentGatewayBaseUrl: "http://127.0.0.1:18980",
    agentGatewayHealthHost: "127.0.0.1",
    agentGatewayHealthPort: 18970,
    agentGatewayBootstrapSecret: "gateway-secret"
  };
  const options: StartPackagedRuntimeServicesOptions = {
    appPath: "/app",
    resourcesPath: "/resources",
    logDirectory: "/logs",
    logLevel: "info"
  };
  const children: ManagedChild[] = [];
  const spawned: ManagedChild[] = [];
  const spawn = vi.fn(() => {
    const child = createManagedChild();
    spawned.push(child);
    return child;
  });
  const supervisor = new AgentGatewaySupervisor(entries, runtimeConfig, children, options, {
    probeHttpService: overrides.probe ?? vi.fn(async () => "unreachable" as const),
    spawnNodeService: spawn,
    waitForHttpService: overrides.waitForHttpService ?? vi.fn(async () => undefined),
    stopManagedChild: overrides.stopManagedChild ?? vi.fn(async () => undefined)
  });
  return { supervisor, children, spawned, spawn };
}

function createManagedChild(): ManagedChild {
  const process = new EventEmitter() as EventEmitter & {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: ReturnType<typeof vi.fn>;
  };
  process.exitCode = null;
  process.signalCode = null;
  process.kill = vi.fn(() => true);
  return {
    name: "agent-gateway",
    process: process as unknown as ChildProcess,
    stdoutTail: [],
    stderrTail: [],
    exitDescription: null,
    logWriter: null
  };
}

function emitChildClose(child: ManagedChild, code: number): void {
  child.process.emit("close", code, null);
}
