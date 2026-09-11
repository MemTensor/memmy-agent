import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { describe, expect, it, vi } from "vitest";
import { isDirectRun, main, writeCurrentEndpoint } from "../src/server/index.js";
import * as memoryHttp from "../src/server/http.js";
import * as memoryRestart from "../src/server/service-restart.js";

describe("memmy memory server entrypoint", () => {
  it("gives shutdown priority over restart while cleanup is still pending", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-memory-restart-shutdown-"));
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, YAML.stringify({ memmyMemory: {
      storage: { mode: "local", backend: "sqlite", sqlitePath: join(root, "memory.sqlite") },
    } }));
    const listeners = ["SIGINT", "SIGTERM", "exit"].map((signal) => process.listenerCount(signal));
    vi.stubEnv("MEMMY_DESKTOP_MANAGED_MEMORY", "1");
    const originalRestart = memoryRestart.requestMemoryServiceRestart;
    vi.spyOn(memoryRestart, "requestMemoryServiceRestart").mockImplementation((dependencies) =>
      originalRestart({ ...dependencies, send: null }));
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((done) => { finishCleanup = done; });
    const originalClose = memoryHttp.closeMemoryHttpServer;
    const close = vi.spyOn(memoryHttp, "closeMemoryHttpServer").mockImplementation(async (server) => {
      await cleanup;
      await originalClose(server);
    });
    const listen = vi.spyOn(memoryHttp, "listenMemoryHttpServer");
    const running = main(["--config", configPath, "--host", "127.0.0.1", "--port", "0"]);
    try {
      const endpoint = await waitForWrittenEndpoint(configPath);
      const response = await fetch(`${endpoint}/api/v1/system/restart`, {
        method: "POST",
        headers: { "x-memmy-viewer": "1", "content-type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(202);
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      listen.mock.calls[0]![0].onShutdownRequested?.();
      finishCleanup();
      await running;
      expect(listen).toHaveBeenCalledOnce();
      expect(["SIGINT", "SIGTERM", "exit"].map((signal) => process.listenerCount(signal))).toEqual(listeners);
      expect(existsSync(join(root, "memory-service", "service.lock"))).toBe(false);
    } finally {
      listen.mock.calls[0]?.[0].onShutdownRequested?.();
      finishCleanup();
      await running;
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

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
