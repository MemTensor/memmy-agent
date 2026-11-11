import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listenMemoryStartupHttpServer, type MemoryStartupState } from "../src/server/startup-http.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("Memory startup HTTP server", () => {
  it("owns the public port during migration and atomically hands requests to the ready service", async () => {
    const state: MemoryStartupState = {
      status: "upgrading",
      phase: "migration.starting",
      startedAt: Date.now() - 50,
      currentSchemaVersion: 9,
      targetSchemaVersion: 13
    };
    const gateway = await listenMemoryStartupHttpServer({
      host: "127.0.0.1",
      port: 0,
      mode: "local",
      storageBackend: "sqlite",
      state: () => state,
      onShutdownRequested: vi.fn()
    });
    cleanups.push(() => gateway.close());

    const healthResponse = await fetch(`${gateway.url}/api/v1/health`);
    expect(healthResponse.status).toBe(200);
    await expect(healthResponse.json()).resolves.toMatchObject({
      ok: true,
      status: "upgrading",
      storage: { ready: false, schemaVersion: "9", targetSchemaVersion: 13 },
      startup: { phase: "migration.starting", currentSchemaVersion: 9, targetSchemaVersion: 13 }
    });

    const unavailable = await fetch(`${gateway.url}/api/v1/sessions/open`, { method: "POST", body: "{}" });
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("retry-after")).toBe("1");
    await expect(unavailable.json()).resolves.toMatchObject({ error: { code: "memory_upgrading", retryable: true } });

    const ready = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true,"status":"ready"}');
    });
    gateway.activate(ready);
    const readyResponse = await fetch(`${gateway.url}/api/v1/health`);
    await expect(readyResponse.json()).resolves.toEqual({ ok: true, status: "ready" });
  });

  it("keeps startup shutdown authenticated", async () => {
    const shutdown = vi.fn();
    const gateway = await listenMemoryStartupHttpServer({
      host: "127.0.0.1",
      port: 0,
      mode: "local",
      storageBackend: "sqlite",
      localServiceToken: "secret",
      state: () => ({ status: "starting", phase: "database.opening", startedAt: Date.now(), targetSchemaVersion: 13 }),
      onShutdownRequested: shutdown
    });
    cleanups.push(() => gateway.close());
    expect((await fetch(`${gateway.url}/api/v1/admin/shutdown`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${gateway.url}/api/v1/admin/shutdown`, {
      method: "POST",
      headers: { authorization: "Bearer secret" }
    })).status).toBe(200);
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce());
  });
});
