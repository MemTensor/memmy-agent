import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { runCommand } from "../src/cli/commands.js";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { describe, expect, it, vi } from "vitest";
import { isDirectRun, main, initializeListenerConfig } from "../src/server/index.js";
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
    const create = vi.spyOn(memoryHttp, "createMemoryHttpServer");
    const running = main(["--config", configPath, "--host", "127.0.0.1", "--port", "0"]);
    try {
      const endpoint = await waitForWrittenEndpoint(configPath);
      const response = await waitForResponse(`${endpoint}/api/v1/system/restart`, 202, {
          method: "POST",
          headers: { "x-memmy-viewer": "1", "content-type": "application/json" },
          body: "{}",
        });
      expect(response.status).toBe(202);
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      create.mock.calls[0]![0].onShutdownRequested?.();
      finishCleanup();
      await running;
      expect(create).toHaveBeenCalledOnce();
      expect(["SIGINT", "SIGTERM", "exit"].map((signal) => process.listenerCount(signal))).toEqual(listeners);
      expect(existsSync(join(root, "memory-service", "service.lock"))).toBe(false);
    } finally {
      create.mock.calls[0]?.[0].onShutdownRequested?.();
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

  it("initializes the Memory connection and preserves unknown catalog fields", async () => {
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
      await initializeListenerConfig(configPath, "http://127.0.0.1:18960", "generated", "http://old.local");
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
            token: "generated",
            futureStorageField: "keep-storage"
          }
        }
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["json", "yaml"])("keeps an existing %s config usable by the CLI across service restarts", async extension => {
    const root = mkdtempSync(join(tmpdir(), "memory-credential-restart-"));
    const configPath = join(root, `config.${extension}`);
    const databasePath = join(root, "memory.sqlite");
    const original = {
      appMetadata: { labels: ["01", "off"], enabled: false },
      memmyMemory: { storage: { mode: "local", backend: "sqlite", sqlitePath: databasePath, extra: 42 } }
    };
    const json = extension === "json";
    writeFileSync(configPath, json ? JSON.stringify(original) : YAML.stringify(original));
    const readConfig = () => {
      const contents = readFileSync(configPath, "utf8");
      return json ? JSON.parse(contents) : YAML.parse(contents);
    };
    for (const key of ["MEMMY_MEMORY_TOKEN", "MEMORY_SERVICE_TOKEN", "MEMMY_MEMORY_URL", "MEMORY_SERVICE_URL"]) {
      vi.stubEnv(key, undefined);
    }
    let firstToken: string | undefined;
    let port = "0";
    try {
      for (let start = 0; start < 2; start++) {
        const child = spawn(process.execPath, [
          "--import", "tsx", fileURLToPath(new URL("../src/server/index.ts", import.meta.url)),
          "--config", configPath, "--host", "127.0.0.1", "--port", port
        ], { stdio: "ignore", env: { ...process.env, MEMMY_CONFIG: configPath, HOME: root, USERPROFILE: root } });
        const closed = once(child, "close");
        try {
          await vi.waitFor(async () => {
            const saved = readConfig();
            expect(saved).toMatchObject(original);
            expect(saved.memmyMemory.storage.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
            const response = await runCommand({ argv: ["raw", "GET", "/auth/check", "--config", configPath] });
            expect(response).toMatchObject({ authenticated: true });
          }, { timeout: 10_000 });
          const { endpoint, token } = readConfig().memmyMemory.storage;
          expect(token).toMatch(/^[a-f0-9]{64}$/);
          if (start === 0) firstToken = token;
          else expect(token).toBe(firstToken);
          port = new URL(endpoint).port;
          await runCommand({ argv: ["raw", "POST", "/admin/shutdown", "--config", configPath] });
          expect((await closed)[0]).toBe(0);
        } finally {
          if (child.exitCode === null && child.signalCode === null) child.kill();
          await closed;
        }
      }
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it.each([false, true])("uses the listener origin for the environment credential (saved A: %s)", async savedA => {
    const root = mkdtempSync(join(tmpdir(), "memory-listener-origin-"));
    const configPath = join(root, "config.json");
    const storage = { mode: "local", backend: "sqlite", sqlitePath: join(root, "memory.sqlite"),
      ...(savedA ? { endpoint: "http://127.0.0.1:1", token: "token-A" } : {}) };
    const original = JSON.stringify({ memmyMemory: { storage } });
    writeFileSync(configPath, original);
    const probe = createServer();
    probe.listen(0, "127.0.0.1");
    await once(probe, "listening");
    const address = probe.address();
    if (!address || typeof address === "string") throw new Error("missing test port");
    await new Promise<void>(resolve => probe.close(() => resolve()));
    const endpoint = `http://127.0.0.1:${address.port}`;
    const child = spawn(process.execPath, [
      "--import", "tsx", fileURLToPath(new URL("../src/server/index.ts", import.meta.url)),
      "--config", configPath, "--port", String(address.port), "--host", "127.0.0.1"
    ], { stdio: "ignore", env: { ...process.env, HOME: root, USERPROFILE: root, MEMMY_CONFIG: configPath,
      MEMMY_MEMORY_URL: endpoint, MEMMY_MEMORY_TOKEN: "token-B" } });
    const closed = once(child, "close");
    try {
      const check = (token: string) => fetch(endpoint + "/api/v1/auth/check", { headers: { authorization: "Bearer " + token } });
      await vi.waitFor(async () => expect((await check("token-B")).status).toBe(200), { timeout: 10_000 });
      expect((await check("token-A")).status).toBe(401);
      expect(readFileSync(configPath, "utf8")).toBe(original);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

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
      const token = YAML.parse(readFileSync(configPath, "utf8")).memmyMemory.storage.token;
      expect(token).toMatch(/^[a-f0-9]{64}$/);
      expect((await fetch(`${endpoint}/api/v1/admin/shutdown`, { method: "POST" })).status).toBe(401);
      const response = await fetch(`${endpoint}/api/v1/admin/shutdown`, {
        method: "POST", headers: { authorization: `Bearer ${token}` }
      });

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

async function waitForResponse(url: string, status: number, init: RequestInit): Promise<Response> {
  const deadline = Date.now() + 5_000;
  let response: Response | undefined;
  while (Date.now() < deadline) {
    response = await fetch(url, init);
    if (response.status === status) return response;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`endpoint did not return ${status}; received ${response?.status ?? "no response"}`);
}
