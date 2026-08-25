import { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentGatewaySupervisor,
  ensureMemoryService,
  preparePackagedBrowser,
  preparePackagedRuntimeConfig,
  readLiveMemoryServerLock,
  resolveDevelopmentRuntimeExecutable,
  resolveDevelopmentRuntimeEntryPaths,
  resolvePackagedRuntimeMigrationTargets,
  resolveRuntimeEntryPaths,
  runPackagedMigrationCommand,
  restartExternalMemoryService,
  spawnNodeService,
  startAgentGatewayWithRecovery,
  startPackagedBrowserPreparation,
  stopManagedChild,
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
    delete process.env.MEMMY_MIGRATIONS_READY_CONFIG;
    delete process.env.MEMMY_MIGRATIONS_READY_WORKSPACE;
    delete process.env.MEMMY_MIGRATIONS_READY_APP_DATABASE;
    await Promise.all(testServers.splice(0).map((server) => new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
      server.closeAllConnections();
    })));
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("runs packaged migrations through the Agent CLI with exact targets", async () => {
    const root = await makeTempRoot();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      exitCode: null,
      signalCode: null,
      kill: vi.fn()
    }) as unknown as ChildProcess;
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    });
    process.env.MEMMY_MIGRATIONS_READY_CONFIG = "/stale/config.yaml";
    process.env.MEMMY_MIGRATIONS_READY_WORKSPACE = "/stale/workspace";
    process.env.MEMMY_MIGRATIONS_READY_APP_DATABASE = "/stale/app.sqlite";

    await runPackagedMigrationCommand({
      agentEntry: "/runtime/memmy-agent/dist/main.js",
      configPath: join(root, "config.yaml"),
      agentWorkspace: join(root, "workspace"),
      appDatabaseFile: join(root, "app.sqlite"),
      logDirectory: root,
      logLevel: "info",
      spawnProcess: spawnProcess as typeof import("node:child_process").spawn
    });
    expect(spawnProcess).toHaveBeenCalledWith(
      process.execPath,
      [
        "/runtime/memmy-agent/dist/main.js",
        "migrate",
        "--config",
        join(root, "config.yaml"),
        "--workspace",
        join(root, "workspace"),
        "--app-database",
        join(root, "app.sqlite")
      ],
      expect.objectContaining({
        env: expect.objectContaining({
          ELECTRON_RUN_AS_NODE: "1",
          MEMMY_LOG_LEVEL: "info"
        }),
        stdio: ["ignore", "pipe", "pipe"],
        shell: false
      })
    );
    const spawnedEnv = spawnProcess.mock.calls[0]?.[2]?.env;
    expect(spawnedEnv).not.toHaveProperty("MEMMY_MIGRATIONS_READY_CONFIG");
    expect(spawnedEnv).not.toHaveProperty("MEMMY_MIGRATIONS_READY_WORKSPACE");
    expect(spawnedEnv).not.toHaveProperty("MEMMY_MIGRATIONS_READY_APP_DATABASE");
  });

  it("omits an implicit workspace override while still passing the Desktop database target", async () => {
    const root = await makeTempRoot();
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null,
      kill: vi.fn()
    }) as unknown as ChildProcess;
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    });

    await runPackagedMigrationCommand({
      agentEntry: "/runtime/memmy-agent/dist/main.js",
      configPath: join(root, "config.yaml"),
      appDatabaseFile: join(root, "app.sqlite"),
      logDirectory: root,
      logLevel: "info",
      spawnProcess: spawnProcess as typeof import("node:child_process").spawn
    });

    expect(spawnProcess.mock.calls[0]?.[1]).toEqual([
      "/runtime/memmy-agent/dist/main.js",
      "migrate",
      "--config",
      join(root, "config.yaml"),
      "--app-database",
      join(root, "app.sqlite")
    ]);
  });

  it("rejects when the packaged migration command exits unsuccessfully", async () => {
    const root = await makeTempRoot();
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null,
      kill: vi.fn()
    }) as unknown as ChildProcess;

    const promise = runPackagedMigrationCommand({
      agentEntry: "/runtime/memmy-agent/dist/main.js",
      configPath: join(root, "config.yaml"),
      agentWorkspace: join(root, "workspace"),
      appDatabaseFile: join(root, "app.sqlite"),
      logDirectory: root,
      logLevel: "info",
      spawnProcess: (() => child) as typeof import("node:child_process").spawn
    });
    queueMicrotask(() => child.emit("close", 1, null));

    await expect(promise).rejects.toThrow("Migration command exited with code 1");
  });

  it("terminates a packaged migration command that exceeds startup timeout", async () => {
    const root = await makeTempRoot();
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null,
      kill: vi.fn()
    }) as unknown as ChildProcess;

    await expect(runPackagedMigrationCommand({
      agentEntry: "/runtime/memmy-agent/dist/main.js",
      configPath: join(root, "config.yaml"),
      agentWorkspace: join(root, "workspace"),
      appDatabaseFile: join(root, "app.sqlite"),
      logDirectory: root,
      logLevel: "info",
      timeoutMs: 5,
      spawnProcess: (() => child) as typeof import("node:child_process").spawn
    })).rejects.toThrow("Migration command timed out after 5ms");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
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
        defaults: { workspace: join(memmyHome, "workspace") }
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
      fileMemory: {
        enabled: false
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
    expect(recordValue(recordValue(config, "agents"), "defaults")).not.toHaveProperty("model");
    expect(recordValue(recordValue(config, "agents"), "defaults")).not.toHaveProperty("provider");
  });

  it("recognizes a live Memory server lock for the configured sqlite database", async () => {
    const root = await makeTempRoot();
    const databasePath = join(root, "memory.sqlite");
    await writeFile(`${databasePath}.server.lock`, JSON.stringify({
      pid: process.pid,
      host: "127.0.0.1",
      port: 18960,
      sqlitePath: databasePath
    }));

    expect(readLiveMemoryServerLock(databasePath)).toEqual({
      pid: process.pid,
      host: "127.0.0.1",
      port: 18960,
      sqlitePath: databasePath
    });
  });

  it("ignores a Memory server lock that names another sqlite database", async () => {
    const root = await makeTempRoot();
    const databasePath = join(root, "memory.sqlite");
    await writeFile(`${databasePath}.server.lock`, JSON.stringify({
      pid: process.pid,
      sqlitePath: join(root, "other.sqlite")
    }));

    expect(readLiveMemoryServerLock(databasePath)).toBeNull();
  });

  it("waits for and reuses a live locked Memory service instead of spawning another", async () => {
    const root = await makeTempRoot();
    const databasePath = join(root, "memory.sqlite");
    const reservation = createServer();
    await new Promise<void>((resolveListen) => reservation.listen(0, "127.0.0.1", resolveListen));
    const address = reservation.address();
    if (!address || typeof address === "string") throw new Error("expected TCP address");
    const port = address.port;
    await new Promise<void>((resolveClose) => reservation.close(() => resolveClose()));
    await writeFile(`${databasePath}.server.lock`, JSON.stringify({
      pid: process.pid,
      host: "127.0.0.1",
      port,
      sqlitePath: databasePath
    }));

    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
    testServers.push(server);
    setTimeout(() => server.listen(port, "127.0.0.1"), 100);
    const children: ManagedChild[] = [];

    await ensureMemoryService(
      { memoryEntry: join(root, "missing-memory.js"), agentEntry: join(root, "missing-agent.js") },
      {
        configPath: join(root, "config.yaml"),
        agentWorkspace: join(root, "workspace"),
        memoryDatabasePath: databasePath,
        memoryBaseUrl: `http://127.0.0.1:${port}`,
        memoryToken: "",
        memoryListenHost: "127.0.0.1",
        memoryListenPort: port,
        agentGatewayBaseUrl: "http://127.0.0.1:18980",
        agentGatewayHealthHost: "127.0.0.1",
        agentGatewayHealthPort: 18970,
        agentGatewayBootstrapSecret: "secret"
      },
      children,
      {
        appPath: root,
        appDatabaseFile: join(root, "app.sqlite"),
        resourcesPath: root,
        logDirectory: root,
        logLevel: "info"
      }
    );

    expect(children).toHaveLength(0);
  });

  it("rereads the migrated workspace instead of pinning the pre-migration legacy value", async () => {
    const memmyHome = await makeTempRoot();
    const configPath = join(memmyHome, "config.yaml");
    const legacyWorkspace = join(memmyHome, "legacy-workspace");
    await writeFile(configPath, YAML.stringify({
      agent: { workspace: legacyWorkspace }
    }), "utf8");

    expect(await resolvePackagedRuntimeMigrationTargets({
      MEMMY_HOME: memmyHome,
      MEMMY_CONFIG: configPath
    })).toEqual({ configPath });

    await writeFile(configPath, YAML.stringify({
      agents: { defaults: { workspace: legacyWorkspace } }
    }), "utf8");
    const runtime = await preparePackagedRuntimeConfig({
      env: { MEMMY_HOME: memmyHome, MEMMY_CONFIG: configPath },
      secretFactory: () => "stable-secret"
    });

    expect(runtime.agentWorkspace).toBe(legacyWorkspace);
  });

  it("preserves existing user model, memory, and websocket settings", async () => {
    const memmyHome = await makeTempRoot();
    const configPath = join(memmyHome, "config.yaml");
    const workspace = join(memmyHome, "custom-workspace");
    const sqlitePath = join(memmyHome, "db", "memory.sqlite");
    await writeFile(configPath, YAML.stringify({
      fileMemory: {
        enabled: true
      },
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
        anthropic: {
          apiKey: "sk-test",
          futureProviderField: "keep-provider",
          endpoints: { chat: { futureEndpointField: "keep-endpoint" } }
        }
      },
      modelPresets: {
        "future-preset": { futurePresetField: "keep-preset" }
      },
      futureSection: {
        keepMe: true
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
    expect(recordValue(config, "fileMemory")).toEqual({ enabled: true });
    expect(recordValue(config, "futureSection")).toEqual({ keepMe: true });
    expect(recordValue(recordValue(config, "providers"), "anthropic")).toMatchObject({
      futureProviderField: "keep-provider",
      endpoints: { chat: { futureEndpointField: "keep-endpoint" } }
    });
    expect(recordValue(recordValue(config, "modelPresets"), "future-preset")).toEqual({
      futurePresetField: "keep-preset"
    });
  });

  it("fills a missing file memory enabled field without changing explicit values", async () => {
    const missingHome = await makeTempRoot();
    const missingPath = join(missingHome, "config.yaml");
    await writeFile(missingPath, "fileMemory: {}\n", "utf8");

    await preparePackagedRuntimeConfig({
      env: { MEMMY_CONFIG: missingPath },
      secretFactory: () => "stable-secret"
    });

    expect(recordValue(await readYaml(missingPath), "fileMemory")).toEqual({
      enabled: false
    });

    const explicitHome = await makeTempRoot();
    const explicitPath = join(explicitHome, "config.yaml");
    await writeFile(
      explicitPath,
      "fileMemory:\n  enabled: false\n",
      "utf8"
    );
    await preparePackagedRuntimeConfig({
      env: { MEMMY_CONFIG: explicitPath },
      secretFactory: () => "stable-secret"
    });
    expect(recordValue(await readYaml(explicitPath), "fileMemory")).toEqual({
      enabled: false
    });
  });

  it.each([
    ["null", null],
    ["array", []],
    ["scalar", false],
    ["non-boolean enabled", { enabled: "false" }]
  ])("preserves invalid file memory config for schema rejection: %s", async (_label, expected) => {
    const memmyHome = await makeTempRoot();
    const configPath = join(memmyHome, "config.yaml");
    await writeFile(configPath, YAML.stringify({ fileMemory: expected }), "utf8");

    await preparePackagedRuntimeConfig({
      env: { MEMMY_CONFIG: configPath },
      secretFactory: () => "stable-secret"
    });

    expect((await readYaml(configPath)).fileMemory).toEqual(expected);
  });

  it("does not restore the retired memory active profile field", async () => {
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

    const memmyMemory = recordValue(config, "memmyMemory");
    expect(memmyMemory).not.toHaveProperty("activeProfile");
    expect(memmyMemory).toMatchObject({
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

  it("prepares the packaged browser with the bundled agent runtime before services start", async () => {
    const root = await makeTempRoot();
    const agentEntry = join(root, "runtime", "memmy-agent", "dist", "main.js");
    const logDirectory = join(root, "logs");
    await mkdir(join(root, "runtime", "memmy-agent", "dist"), { recursive: true });
    await mkdir(logDirectory, { recursive: true });
    await writeFile(agentEntry, "// bundled agent\n", "utf8");
    const child = new EventEmitter() as ChildProcess;
    (child as any).stdout = Object.assign(new EventEmitter(), {
      setEncoding: vi.fn(),
    });
    (child as any).stderr = Object.assign(new EventEmitter(), {
      setEncoding: vi.fn(),
    });
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    });
    const runtimeConfig = {
      configPath: join(root, "config.yaml"),
      agentWorkspace: join(root, "workspace"),
    } as PackagedRuntimeConfig;

    await expect(
      preparePackagedBrowser(
        { agentEntry, memoryEntry: join(root, "memory.js") },
        runtimeConfig,
        {
          appPath: root,
          resourcesPath: root,
          logDirectory,
          logLevel: "info",
        },
        spawnProcess as any,
      ),
    ).resolves.toBe(true);

    expect(spawnProcess).toHaveBeenCalledWith(
      process.execPath,
      [agentEntry, "internal", "browser-prepare"],
      expect.objectContaining({
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: expect.objectContaining({
          MEMMY_CONFIG: runtimeConfig.configPath,
          MEMMY_AGENT_WORKSPACE: runtimeConfig.agentWorkspace,
          ELECTRON_RUN_AS_NODE: "1",
        }),
      }),
    );
  });

  it("starts packaged browser preparation without waiting and stops the owned child", async () => {
    const root = await makeTempRoot();
    const agentEntry = join(root, "runtime", "memmy-agent", "dist", "main.js");
    const logDirectory = join(root, "logs");
    await mkdir(join(root, "runtime", "memmy-agent", "dist"), { recursive: true });
    await mkdir(logDirectory, { recursive: true });
    await writeFile(agentEntry, "// bundled agent\n", "utf8");
    const child = new EventEmitter() as ChildProcess;
    (child as any).stdout = Object.assign(new EventEmitter(), {
      setEncoding: vi.fn(),
    });
    (child as any).stderr = Object.assign(new EventEmitter(), {
      setEncoding: vi.fn(),
    });
    child.kill = vi.fn(() => true);
    const spawnProcess = vi.fn(() => child);
    const runtimeConfig = {
      configPath: join(root, "config.yaml"),
      agentWorkspace: join(root, "workspace"),
    } as PackagedRuntimeConfig;

    const preparation = startPackagedBrowserPreparation(
      { agentEntry, memoryEntry: join(root, "memory.js") },
      runtimeConfig,
      {
        appPath: root,
        resourcesPath: root,
        logDirectory,
        logLevel: "info",
      },
      spawnProcess as any,
      "test-browser-attempt",
    );
    let completed = false;
    void preparation.completion.then(() => {
      completed = true;
    });

    await Promise.resolve();
    expect(completed).toBe(false);
    expect(spawnProcess).toHaveBeenCalledOnce();
    expect(spawnProcess.mock.calls[0]?.[2]?.env).toMatchObject({
      MEMMY_BROWSER_PREPARATION_ATTEMPT_ID: "test-browser-attempt",
    });
    await expect(readFile(
      join(root, "mcp", "playwright", "browser-preparation-state.json"),
      "utf8",
    ).then((content) => JSON.parse(content))).resolves.toMatchObject({
      status: "preparing",
      attemptId: "test-browser-attempt",
      progressPercent: 0,
    });

    preparation.stop();
    await expect(preparation.completion).resolves.toBe(false);
    preparation.stop();
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("publishes an unavailable state when browser preparation cannot start", async () => {
    const root = await makeTempRoot();
    const agentEntry = join(root, "runtime", "memmy-agent", "dist", "main.js");
    const logDirectory = join(root, "logs");
    await mkdir(join(root, "runtime", "memmy-agent", "dist"), { recursive: true });
    await mkdir(logDirectory, { recursive: true });
    await writeFile(agentEntry, "// bundled agent\n", "utf8");

    const preparation = startPackagedBrowserPreparation(
      { agentEntry, memoryEntry: join(root, "memory.js") },
      {
        configPath: join(root, "config.yaml"),
        agentWorkspace: join(root, "workspace"),
      } as PackagedRuntimeConfig,
      {
        appPath: root,
        resourcesPath: root,
        logDirectory,
        logLevel: "info",
      },
      vi.fn(() => {
        throw new Error("spawn failed");
      }) as any,
      "failed-browser-attempt",
    );

    await expect(preparation.completion).resolves.toBe(false);
    await expect(readFile(
      join(root, "mcp", "playwright", "browser-preparation-state.json"),
      "utf8",
    ).then((content) => JSON.parse(content))).resolves.toMatchObject({
      status: "unavailable",
      attemptId: "failed-browser-attempt",
      error: expect.stringContaining("spawn failed"),
    });
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

  it("keeps retrying after an explicitly recoverable initial startup failure", async () => {
    vi.useFakeTimers();
    const waitForHttpService = vi.fn()
      .mockRejectedValueOnce(new Error("invalid runtime config"))
      .mockRejectedValueOnce(new Error("runtime config is still invalid"))
      .mockResolvedValueOnce(undefined);
    const harness = createSupervisorHarness({
      waitForHttpService,
      stopManagedChild: vi.fn(async (child: ManagedChild) => {
        emitChildClose(child, 1);
      })
    });

    await expect(harness.supervisor.ensureStarted()).rejects.toThrow("invalid runtime config");
    harness.supervisor.startRecovery();
    await vi.advanceTimersByTimeAsync(249);
    expect(harness.spawn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(harness.spawn).toHaveBeenCalledTimes(2);
    expect(harness.supervisor.hasReachedReady).toBe(false);
    await vi.advanceTimersByTimeAsync(999);
    expect(harness.spawn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);

    expect(harness.spawn).toHaveBeenCalledTimes(3);
    expect(harness.supervisor.hasReachedReady).toBe(true);
    expect(harness.supervisor.restartTimer).toBeNull();
  });

  it("cancels pending initial recovery during shutdown", async () => {
    vi.useFakeTimers();
    const harness = createSupervisorHarness({
      waitForHttpService: vi.fn(async () => {
        throw new Error("invalid runtime config");
      }),
      stopManagedChild: vi.fn(async (child: ManagedChild) => {
        emitChildClose(child, 1);
      })
    });

    await expect(harness.supervisor.ensureStarted()).rejects.toThrow("invalid runtime config");
    harness.supervisor.startRecovery();
    await harness.supervisor.close();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(harness.spawn).toHaveBeenCalledTimes(1);
    expect(harness.supervisor.restartTimer).toBeNull();
  });

  it("contains the initial Agent failure and enables background recovery", async () => {
    const failure = new Error("invalid runtime config");
    const supervisor = {
      ensureStarted: vi.fn(async () => {
        throw failure;
      }),
      startRecovery: vi.fn()
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(startAgentGatewayWithRecovery(supervisor)).resolves.toBeNull();

    expect(supervisor.startRecovery).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "Agent gateway unavailable during desktop startup: invalid runtime config"
    );
  });

  it("classifies a rejected model config without exposing the startup error", async () => {
    const supervisor = {
      ensureStarted: vi.fn(async () => {
        throw new Error(
          "agent-gateway exited before it became ready (code 1). stderr: memmy: Failed to load config from C:/Memmy/config.yaml: providers current contract does not accept legacy field 'apiBase'"
        );
      }),
      startRecovery: vi.fn()
    };
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(startAgentGatewayWithRecovery(supervisor)).resolves.toBe("model_config_invalid");
    expect(supervisor.startRecovery).toHaveBeenCalledTimes(1);
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
      MEMMY_MIGRATIONS_READY_CONFIG: "/memmy/config.yaml",
      MEMMY_MIGRATIONS_READY_WORKSPACE: "/memmy/workspace",
      MEMMY_MIGRATIONS_READY_SESSION_DAG: resolve("/memmy/session-dag"),
      MEMMY_APP_DATABASE: "/memmy/app.sqlite",
      MEMMY_MIGRATIONS_READY_APP_DATABASE: "/memmy/app.sqlite",
      MEMMY_BROWSER_PREPARATION_ATTEMPT_ID: "test-browser-attempt",
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

  it("把 Agent Gateway 子进程 stderr 落盘到 agent-gateway.log", async () => {
    const root = await makeTempRoot();
    const entry = join(root, "entry.js");
    await writeFile(entry, "process.stderr.write('[session-dag] compaction failed SQLITE_CANTOPEN\\n');\n");
    const logFile = join(root, "agent-gateway.log");

    const managed = spawnNodeService("agent-gateway", entry, [], {}, {
      logFilePath: logFile,
      logLevel: "info"
    });
    await new Promise<void>((done) => managed.process.once("exit", () => done()));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));

    const logText = await readFile(logFile, "utf8");
    expect(logText).toContain("[session-dag] compaction failed");
    expect(logText).toContain("SQLITE_CANTOPEN");
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

  it("强杀后等待 Memory 子进程真正退出", async () => {
    const root = await makeTempRoot();
    const entry = join(root, "stubborn-memory.js");
    await writeFile(entry, [
      "process.on('SIGTERM', () => {});",
      "process.stdout.write('ready\\n');",
      "setInterval(() => {}, 1000);"
    ].join("\n"));
    const managed = spawnNodeService("memory", entry, [], {}, {
      logFilePath: join(root, "stubborn-memory.log"),
      logLevel: "info"
    });
    await new Promise<void>((ready) => managed.process.stdout?.once("data", () => ready()));

    await stopManagedChild(managed);

    expect(managed.exitDescription).toBe("signal SIGKILL");
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
    appDatabaseFile: "/memmy/app.sqlite",
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
    appDatabaseFile: "/memmy/app.sqlite",
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
  }, "test-browser-attempt");
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
