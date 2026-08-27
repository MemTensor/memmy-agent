import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { isDirectRun, main, writeCurrentEndpoint } from "../src/server/index.js";

describe("memmy memory server entrypoint", () => {
  it("recognizes Windows packaged paths as direct server execution", () => {
    const entry = "C:\\Users\\tester\\AppData\\Local\\Programs\\Memmy\\resources\\app.asar\\dist\\runtime\\memory\\src\\server\\index.js";

    expect(isDirectRun(entry, entry)).toBe(true);
    expect(isDirectRun(
      "C:\\Users\\tester\\AppData\\Local\\Programs\\Memmy\\resources\\app.asar\\dist\\runtime\\memory\\src\\cli\\index.js",
      entry
    )).toBe(false);
  });

  it("patches only the Memory endpoint and preserves unknown catalog fields", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-memory-server-config-"));
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, YAML.stringify({
      futureSection: { keepMe: true },
      providers: {
        openai: {
          futureProviderField: "keep-provider",
          endpoints: { chat: { futureEndpointField: "keep-endpoint" } }
        }
      },
      modelPresets: {
        "future-preset": { futurePresetField: "keep-preset" }
      },
      memmyMemory: {
        futureMemoryField: "keep-memory",
        storage: { endpoint: "http://old.local", futureStorageField: "keep-storage" }
      }
    }));

    try {
      await writeCurrentEndpoint(configPath, "http://127.0.0.1:18960");
      const saved = YAML.parse(readFileSync(configPath, "utf8"));
      expect(saved).toMatchObject({
        futureSection: { keepMe: true },
        providers: {
          openai: {
            futureProviderField: "keep-provider",
            endpoints: { chat: { futureEndpointField: "keep-endpoint" } }
          }
        },
        modelPresets: {
          "future-preset": { futurePresetField: "keep-preset" }
        },
        memmyMemory: {
          futureMemoryField: "keep-memory",
          storage: {
            endpoint: "http://127.0.0.1:18960",
            futureStorageField: "keep-storage"
          }
        }
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("shuts down through the admin endpoint and releases the sqlite server lock", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-memory-server-shutdown-"));
    const configPath = join(root, "config.yaml");
    const databasePath = join(root, "memory.sqlite");
    const lockPath = `${databasePath}.server.lock`;
    writeFileSync(configPath, YAML.stringify({
      memmyMemory: {
        storage: {
          mode: "local",
          backend: "sqlite",
          sqlitePath: databasePath
        }
      }
    }));

    try {
      const running = main([
        "--config", configPath,
        "--host", "127.0.0.1",
        "--port", "0",
        "--db", databasePath
      ]);
      const endpoint = await waitForWrittenEndpoint(configPath);
      const response = await fetch(`${endpoint}/api/v1/admin/shutdown`, { method: "POST" });

      expect(response.ok).toBe(true);
      await running;
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

async function waitForWrittenEndpoint(configPath: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const config = YAML.parse(readFileSync(configPath, "utf8")) as {
      memmyMemory?: { storage?: { endpoint?: unknown } };
    };
    const endpoint = config.memmyMemory?.storage?.endpoint;
    if (typeof endpoint === "string" && !endpoint.endsWith(":18960")) {
      return endpoint;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error("Memory server did not write its bound endpoint");
}
