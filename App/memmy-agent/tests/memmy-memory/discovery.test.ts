import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemmyMemoryClient } from "../../src/memmy-memory/client.js";
import { Config } from "../../src/config/schema.js";
import { discoverMemmyMemoryConnection, discoverMemmyOutputLanguage, memmyMemoryConfigPaths } from "../../src/memmy-memory/discovery.js";
import { resolveMemmyMemoryConfig } from "../../src/memmy-memory/config.js";

const roots: string[] = [];

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-memory-discovery-"));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("memmy memory discovery", () => {
  it("rereads a newly initialized shared token despite empty environment and discovery values", () => {
    const root = tempRoot(); const configPath = path.join(root, "config.yaml");
    const runtimeDir = path.join(root, ".memmy", "memory-service"); fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(path.join(runtimeDir, "runtime.json"), JSON.stringify({ token: "" }));
    const options = { env: { MEMMY_CONFIG: configPath, MEMMY_MEMORY_TOKEN: "", MEMORY_SERVICE_TOKEN: " " }, homeDir: root };
    fs.writeFileSync(configPath, "memmyMemory: {}\n");
    expect(discoverMemmyMemoryConnection(options).token).toBeNull();
    fs.writeFileSync(configPath, "memmyMemory:\n  storage:\n    token: new-shared-token\n");
    expect(discoverMemmyMemoryConnection(options).token).toBe("new-shared-token");
  });
  it.each(["http://new.test:18081", "https://new.test:18080", "http://old.test:18080"])("does not send credentials from %s to the selected service", async (oldEndpoint) => {
    const root = tempRoot();
    const configPath = path.join(root, "config.yaml");
    const endpoint = "http://new.test:18080";
    fs.writeFileSync(configPath, JSON.stringify({ memmyMemory: { storage: { endpoint, token: "new-token" } } }));
    const options = { homeDir: root, env: { MEMMY_CONFIG: configPath, MEMMY_MEMORY_URL: endpoint, MEMORY_SERVICE_URL: oldEndpoint, MEMORY_SERVICE_TOKEN: "old-token" } };
    const sent: (string | null)[] = [];
    const client = new MemmyMemoryClient(discoverMemmyMemoryConnection(options), async (_url, init) => {
      sent.push(new Headers(init?.headers).get("authorization"));
      return new Response("{}");
    });
    await client.get("/api/v1/memory/example");
    expect(sent).toEqual(["Bearer new-token"]);
  });

  it("refreshes a rotated token after 401 without replaying writes, including equivalent origins", async () => {
    const root = tempRoot();
    const configPath = path.join(root, "config.yaml");
    const write = (token: string) => fs.writeFileSync(configPath, JSON.stringify({ memmyMemory: { storage: { endpoint: "https://MEMORY.test:443/", token } } }));
    write("first");
    const discover = () => discoverMemmyMemoryConnection({ homeDir: root, env: { MEMMY_CONFIG: configPath, MEMMY_MEMORY_URL: "https://memory.test" } });
    const sent: (string | null)[] = [];
    const client = new MemmyMemoryClient(discover(), async (_url, init) => {
      sent.push(new Headers(init?.headers).get("authorization"));
      return new Response("{}", { status: sent.length === 1 ? 401 : 200 });
    }, discover);
    await expect(client.post("/write")).rejects.toMatchObject({ status: 401 });
    expect(sent).toHaveLength(1);
    write("rotated");
    await client.post("/write");
    expect(sent).toEqual(["Bearer first", "Bearer rotated"]);
  });

  it("reads the App's resolved language from the same config and notices changes without a restart", () => {
    const root = tempRoot();
    const configPath = path.join(root, "config.yaml");
    const options = { env: { MEMMY_CONFIG: configPath }, homeDir: root };
    fs.writeFileSync(configPath, "memmyMemory:\n  language: zh-CN\n", "utf8");
    expect(discoverMemmyOutputLanguage(options)).toBe("zh-CN");
    fs.writeFileSync(configPath, "memmyMemory:\n  language: en-US\n", "utf8");
    expect(discoverMemmyOutputLanguage(options)).toBe("en-US");
  });

  it("uses the default config language while accepting no instruction for standalone or malformed config", () => {
    const root = tempRoot();
    const options = { env: {}, homeDir: root };
    expect(discoverMemmyOutputLanguage(options)).toBeUndefined();
    const configPath = path.join(root, ".memmy", "config.yaml");
    fs.mkdirSync(path.dirname(configPath));
    fs.writeFileSync(configPath, "memmyMemory:\n  language: zh-CN\n", "utf8");
    expect(discoverMemmyOutputLanguage(options)).toBe("zh-CN");
    for (const content of ["memmyMemory:\n  language: system\n", "memmyMemory: [broken", "[]"]) {
      fs.writeFileSync(configPath, content, "utf8");
      expect(discoverMemmyOutputLanguage(options)).toBeUndefined();
    }
  });

  it.each(["ja-JP", "fr-FR", "pt-BR", "zh-Hant"])("preserves a future resolved App locale %s instead of dropping it", (language) => {
    const root = tempRoot();
    const configPath = path.join(root, "config.yaml");
    const options = { env: { MEMMY_CONFIG: configPath }, homeDir: root };
    fs.writeFileSync(configPath, `memmyMemory:\n  language: ${language.toLowerCase()}\n`, "utf8");
    expect(discoverMemmyOutputLanguage(options)).toBe(language);
  });

  it("reads Memory config from MEMMY_CONFIG", () => {
    const root = tempRoot();
    const configPath = path.join(root, "config.yaml");
    fs.writeFileSync(configPath, "memmyMemory:\n  storage:\n    endpoint: http://127.0.0.1:18888/\n    token: cfg-token\n", "utf8");

    const connection = discoverMemmyMemoryConnection({ env: { MEMMY_CONFIG: configPath }, homeDir: root });

    expect(connection.baseUrl).toBe("http://127.0.0.1:18888");
    expect(connection.token).toBe("cfg-token");
    expect(connection.source).toBe(configPath);
  });

  it("prefers env endpoint and token over local config", () => {
    const root = tempRoot();
    const configPath = path.join(root, "config.yaml");
    fs.writeFileSync(configPath, "memmyMemory:\n  storage:\n    endpoint: http://config.test\n    token: cfg\n", "utf8");

    const connection = discoverMemmyMemoryConnection({
      env: {
        MEMMY_CONFIG: configPath,
        MEMMY_MEMORY_URL: "http://env.test/",
        MEMMY_MEMORY_TOKEN: "env-token",
      },
      homeDir: root,
    });

    expect(connection.baseUrl).toBe("http://env.test");
    expect(connection.token).toBe("env-token");
    expect(connection.source).toBe("env");
  });

  it("uses an environment token without opening the fallback token file", () => {
    const root = tempRoot();
    const runtime = path.join(root, ".memmy", "memory-service");
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(path.join(runtime, "runtime.json"), JSON.stringify({ tokenFile: runtime }));
    expect(discoverMemmyMemoryConnection({ homeDir: root, env: { MEMMY_MEMORY_TOKEN: "explicit" } }).token).toBe("explicit");
  });

  it("an already running client uses the newly initialized token only on its original endpoint", async () => {
    const root = tempRoot();
    const config = path.join(root, "config.yaml");
    const discover = () => discoverMemmyMemoryConnection({ homeDir: root, env: { MEMMY_CONFIG: config } });
    const sent: (string | null)[] = [];
    const client = new MemmyMemoryClient(discover(), async (_url, init) => {
      sent.push(new Headers(init?.headers).get("authorization"));
      return new Response("{}", { status: sent.length === 2 ? 200 : 401 });
    }, discover);
    fs.writeFileSync(config, "memmyMemory: {storage: {endpoint: 'http://other.test', token: other}}");
    await expect(client.post("/write")).rejects.toMatchObject({ status: 401 });
    fs.writeFileSync(config, "memmyMemory: {storage: {token: initialized}}");
    await client.post("/write");
    expect(sent).toEqual([null, "Bearer initialized"]);
  });

  it("can read future runtime discovery token files", () => {
    const root = tempRoot();
    const runtimeDir = path.join(root, ".memmy", "memory-service");
    fs.mkdirSync(runtimeDir, { recursive: true });
    const tokenFile = path.join(runtimeDir, "service-token");
    fs.writeFileSync(tokenFile, "runtime-token\n", "utf8");
    fs.writeFileSync(path.join(runtimeDir, "runtime.json"), JSON.stringify({ url: "http://runtime.test", tokenFile }), "utf8");

    const connection = discoverMemmyMemoryConnection({ env: {}, homeDir: root });

    expect(connection.baseUrl).toBe("http://runtime.test");
    expect(connection.token).toBe("runtime-token");
  });

  it("uses Memory default config path names", () => {
    const root = tempRoot();
    const explicit = path.join(root, "custom-config.yaml");
    expect(memmyMemoryConfigPaths({ env: { MEMMY_CONFIG: explicit }, homeDir: root })).toEqual([
      explicit,
      path.join(root, ".memmy", "config.yaml"),
    ]);
  });

  it("parses memmyMemory.enabled and preserves service fields from memmy-agent config", () => {
    const enabled = new Config({
      app: {
        userId: "user_config_1",
      },
      memmyMemory: {
        enabled: true,
        version: 1,
        storage: { endpoint: "http://127.0.0.1:18960", token: "service-token" },
        retrievalLayers: ["L1", "L3", "L1"],
      },
    });
    const defaultConfig = new Config();
    const disabled = new Config({ memmyMemory: { enabled: false } });

    expect(enabled.memmyMemory.enabled).toBe(true);
    expect(defaultConfig.memmyMemory.enabled).toBe(true);
    expect(resolveMemmyMemoryConfig(enabled).enabled).toBe(true);
    expect(resolveMemmyMemoryConfig(defaultConfig).enabled).toBe(true);
    expect(resolveMemmyMemoryConfig(enabled).userId).toBe("__memmy_device_memory__");
    expect(resolveMemmyMemoryConfig(enabled).retrievalLayers).toEqual(["L1", "L3"]);
    expect(resolveMemmyMemoryConfig(disabled).enabled).toBe(false);
    expect(resolveMemmyMemoryConfig(disabled).userId).toBe("__memmy_device_memory__");
    expect(enabled.toObject().memmyMemory).toEqual({
      enabled: true,
      userId: "user_config_1",
      version: 1,
      storage: { endpoint: "http://127.0.0.1:18960", token: "service-token" },
      retrievalLayers: ["L1", "L3"],
    });
    expect(enabled.toObject().app).toEqual({
      userId: "user_config_1",
    });
  });

  it("round-trips the authoritative Memory service configuration", () => {
    const input = {
      enabled: true,
      roleRouting: { summary: "fixed", evolution: "follow" },
      summary: { provider: "openai_compatible", endpoint: "https://summary.example/v1", model: "summary" },
      evolution: { provider: "anthropic", endpoint: "https://evolution.example/v1", model: "evolution" },
      embedding: { mode: "custom", provider: "openai_compatible", endpoint: "https://embedding.example/v1", model: "embedding" },
      algorithm: { lightweightMemory: { enabled: false } },
      logging: { detailedView: false },
      telemetry: { enabled: false },
      hub: { enabled: true, role: "client" },
      agentAccess: { autoScanKnownAgents: true, watchFileChanges: true, autoInjectSkill: false },
      futureMemorySetting: { keep: true },
    };

    const resolved = new Config({ memmyMemory: input }).toObject().memmyMemory;
    expect(resolved).toMatchObject({
      enabled: true,
      roleRouting: input.roleRouting,
      summary: input.summary,
      evolution: input.evolution,
      embedding: input.embedding,
      algorithm: {},
      telemetry: input.telemetry,
      hub: input.hub,
      agentAccess: input.agentAccess,
      futureMemorySetting: input.futureMemorySetting,
    });
    expect(resolved).not.toHaveProperty("logging");
  });
});
