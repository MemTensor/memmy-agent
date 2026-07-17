import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Config } from "../../src/config/schema.js";
import { discoverMemmyMemoryConnection, memmyMemoryConfigPaths } from "../../src/memmy-memory/discovery.js";
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
        embedding: { provider: "hash" },
      },
    });
    const defaultConfig = new Config();
    const disabled = new Config({ memmyMemory: { enabled: false } });

    expect(enabled.memmyMemory.enabled).toBe(true);
    expect(defaultConfig.memmyMemory.enabled).toBe(true);
    expect(resolveMemmyMemoryConfig(enabled).enabled).toBe(true);
    expect(resolveMemmyMemoryConfig(defaultConfig).enabled).toBe(true);
    expect(resolveMemmyMemoryConfig(enabled).userId).toBe("user_config_1");
    expect(resolveMemmyMemoryConfig(disabled).enabled).toBe(false);
    expect(resolveMemmyMemoryConfig(disabled).userId).toBe("local-user");
    expect(enabled.toObject().memmyMemory).toEqual({
      enabled: true,
      userId: "user_config_1",
      version: 1,
      storage: { endpoint: "http://127.0.0.1:18960", token: "service-token" },
      embedding: { provider: "hash" },
    });
    expect(enabled.toObject().app).toEqual({
      userId: "user_config_1",
    });
  });
});
