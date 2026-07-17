import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { preparePackagedRuntimeConfig, spawnNodeService, syncBundledAgentSkills } from "../src/main/runtime-services.js";

const tempRoots: string[] = [];
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
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
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
