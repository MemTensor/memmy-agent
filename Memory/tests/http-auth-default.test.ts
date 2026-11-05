import { type Server } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { createMemoryHttpServer, closeMemoryHttpServer, type MemoryHttpServerOptions } from "../src/server/http.js";
import type { MemoryService } from "../src/service/memory-service.js";
import { probeMemoryAuthentication } from "../src/cli/auth-probe.js";
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(closeMemoryHttpServer)); });
async function serve(auth?: MemoryHttpServerOptions["auth"]) {
  const service = { health: () => ({ ok: true }), setAppBudgetReconcileListener() {}, setCapturePendingListener() {}, setPersistRecoveredListener() {} } as unknown as MemoryService;
  const shutdown = vi.fn();
  const server = createMemoryHttpServer({ service, auth, onShutdownRequested: shutdown, workerStartupFallbackMs: 600_000, workerPostHealthDelayMs: 600_000 });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing address");
  return { url: `http://127.0.0.1:${address.port}`, shutdown };
}
it.each([undefined, {}])("denies ordinary reads, writes and shutdown by default (%j)", async auth => {
  const { url, shutdown } = await serve(auth);
  for (const [method, path] of [["GET", "/memories"], ["POST", "/memories"], ["DELETE", "/memories/example"], ["POST", "/admin/shutdown"]]) {
    for (const headers of [{}, { authorization: "Bearer wrong" }] as Record<string, string>[]) {
      expect((await fetch(`${url}/api/v1${path}`, { method, headers })).status).toBe(401);
    }
  }
  expect(shutdown).not.toHaveBeenCalled(); expect((await fetch(`${url}/api/v1/health`)).status).toBe(200);
});
it("proves local authentication while retaining authenticated admin shutdown", async () => {
  const { url, shutdown } = await serve({ localServiceToken: "test-secret" });
  expect(await probeMemoryAuthentication(url, "wrong")).toBe("mismatch");
  expect(await probeMemoryAuthentication(url, "test-secret")).toBe("authenticated");
  expect((await fetch(`${url}/api/v1/admin/shutdown`, { method: "POST", headers: { authorization: "Bearer test-secret" } })).status).toBe(200);
  await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce());
});
it("does not mistake explicit test anonymous mode or Viewer for token authentication", async () => {
  const { url } = await serve({ allowAnonymous: true });
  expect((await fetch(`${url}/api/v1/auth/check`)).status).toBe(401);
  expect((await fetch(`${url}/api/v1/auth/check`, { headers: { "x-memmy-viewer": "1" } })).status).toBe(401);
});
it("rejects external-page Viewer requests and preflight without granting cross-origin access", async () => {
  const { url } = await serve({ localServiceToken: "test-secret" });
  for (const method of ["GET", "POST", "OPTIONS"]) {
    const response = await fetch(`${url}/api/v1/memories`, { method, headers: { origin: "https://external.invalid", "x-memmy-viewer": "1", "sec-fetch-site": "cross-site" } });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  }
});
