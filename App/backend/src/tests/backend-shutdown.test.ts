import { Agent, request, type ClientRequest, type IncomingMessage } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createLocalBackend } from "../index.js";
import { createLocalApiServer } from "../adapters/inbound/local-api/server.js";
import type { PermissionManager } from "../permission/index.js";
import { createProgressBus } from "../services/progress-bus.js";
import type { BackendServices } from "../services/index.js";
import { createMockCloudClient } from "./support/mock-cloud-client.js";
import { createMockMemoryClient } from "./support/mock-memory-client.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function settlesWithin(promise: Promise<unknown>, milliseconds = 500): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
function connections() {
  const agent = new Agent({ keepAlive: true, maxSockets: 4 });
  const requests: ClientRequest[] = [];
  const responses: IncomingMessage[] = [];
  const bodies = new Map<IncomingMessage, Promise<string>>();
  function open(url: string, headers?: Record<string, string>, payload?: string) {
    return new Promise<IncomingMessage>((resolve, reject) => {
      const clientRequest = request(url, { agent, headers, method: payload === undefined ? "GET" : "POST" }, response => {
        responses.push(response);
        bodies.set(response, new Promise(resolveBody => {
          let body = "";
          response.on("data", chunk => { body += String(chunk); });
          response.once("end", () => resolveBody(body));
          response.on("error", () => {});
        }));
        response.resume(); resolve(response);
      });
      requests.push(clientRequest); clientRequest.on("error", reject); clientRequest.end(payload);
    });
  }
  return { open, body: (response: IncomingMessage) => bodies.get(response)!, destroy() { for (const response of responses) response.destroy(); for (const request of requests) request.destroy(); agent.destroy(); } };
}
function api(verifyRuntimeToken: () => Promise<boolean> = async () => true, executeRouterTool: BackendServices["integrations"]["executeRouterTool"] = async () => ({ saved: true })) {
  const progressBus = createProgressBus();
  const unsubscribers: ReturnType<typeof vi.fn>[] = [];
  const services = {
    bootstrap: { async getBootstrap() { throw new Error("unused"); } },
    integrations: { executeRouterTool },
    progressBus: { ...progressBus, on: ((...args: Parameters<typeof progressBus.on>) => {
      const unsubscribe = vi.fn(progressBus.on(...args)); unsubscribers.push(unsubscribe); return unsubscribe;
    }) }
  } as unknown as BackendServices;
  const app = createLocalApiServer({
    permissionManager: { verifyRuntimeToken } as PermissionManager,
    composioMcpToken: "shutdown-test-mcp", services, heartbeatIntervalMs: 60_000,
  });
  return { app, unsubscribers };
}
async function listen(app: FastifyInstance) { return app.listen({ host: "127.0.0.1", port: 0 }); }

describe("local backend graceful shutdown", () => {
  it("closes with two connected renderer event streams and idle keepalive without client cancellation", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-backend-shutdown-"));
    const clients = connections();
    const backend = await createLocalBackend({
      databasePath: join(root, "app.sqlite"), runtimeConfigPath: join(root, "runtime.json"),
      memmyConfigPath: join(root, "config.yaml"), localToken: "test-token", heartbeatIntervalMs: 60_000,
      memoryClient: createMockMemoryClient(), cloudClient: createMockCloudClient(),
    });
    let shutdown: Promise<void> | undefined;
    try {
      const base = backend.runtimeConfig.baseUrl;
      await clients.body(await clients.open(`${base}/api/health`));
      const streams = await Promise.all([clients.open(`${base}/api/events?token=test-token`), clients.open(`${base}/api/events?token=test-token`)]);
      for (const stream of streams) expect(stream.statusCode).toBe(200);
      shutdown = backend.close();
      expect(await settlesWithin(shutdown)).toBe(true);
      for (const stream of streams) expect(await clients.body(stream)).toContain("event: app.connected");
    } finally { clients.destroy(); await (shutdown ?? backend.close()); rmSync(root, { recursive: true, force: true }); }
  });

  it("unsubscribes each SSE listener once while preserving an in-flight ordinary request", async () => {
    const { app, unsubscribers } = api();
    const clients = connections(); const started = deferred(); const release = deferred();
    let writeFinished = false; let shutdown: Promise<void> | undefined;
    app.get("/shutdown-write", async () => { started.resolve(); await release.promise; writeFinished = true; return { saved: true }; });
    const base = await listen(app);
    try {
      await clients.open(`${base}/api/events?token=test-token`);
      const write = clients.open(`${base}/shutdown-write`);
      await started.promise;
      shutdown = app.close();
      expect(await settlesWithin(shutdown, 30)).toBe(false);
      expect(writeFinished).toBe(false);
      release.resolve();
      const response = await write;
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(await clients.body(response))).toEqual({ saved: true });
      expect(await settlesWithin(shutdown)).toBe(true);
      expect(writeFinished).toBe(true);
      expect(unsubscribers).toHaveLength(2);
      for (const unsubscribe of unsubscribers) expect(unsubscribe).toHaveBeenCalledOnce();
    } finally { release.resolve(); clients.destroy(); await (shutdown ?? app.close()); }
  });

  it("also ends an event stream whose authentication was already in flight when closing started", async () => {
    const entered = deferred(); const authorize = deferred();
    const { app, unsubscribers } = api(async () => { entered.resolve(); await authorize.promise; return true; });
    const clients = connections(); const base = await listen(app); let shutdown: Promise<void> | undefined;
    try {
      const stream = clients.open(`${base}/api/events?token=test-token`);
      await entered.promise;
      shutdown = app.close();
      expect(await settlesWithin(shutdown, 30)).toBe(false);
      authorize.resolve();
      expect((await stream).statusCode).toBe(200);
      expect(await settlesWithin(shutdown)).toBe(true);
      expect(unsubscribers).toHaveLength(2);
      for (const unsubscribe of unsubscribers) expect(unsubscribe).toHaveBeenCalledOnce();
    } finally { authorize.resolve(); clients.destroy(); await (shutdown ?? app.close()); }
  });

  it("also closes the idle Composio MCP notification stream without client cancellation", async () => {
    const { app } = api(); const clients = connections(); const base = await listen(app);
    let shutdown: Promise<void> | undefined;
    try {
      const stream = await clients.open(`${base}/mcp/composio`, {
        accept: "text/event-stream", "x-memmy-mcp-token": "shutdown-test-mcp",
      });
      expect(stream.statusCode).toBe(200);
      shutdown = app.close();
      expect(await settlesWithin(shutdown)).toBe(true);
    } finally { clients.destroy(); await (shutdown ?? app.close()); }
  });

  it("lets an active MCP tool POST finish its write and full response while ending an idle MCP GET", async () => {
    const entered = deferred(); const release = deferred(); let saved = false;
    const { app } = api(undefined, async () => { entered.resolve(); await release.promise; saved = true; return { saved: true }; });
    const clients = connections(); const base = await listen(app); let shutdown: Promise<void> | undefined;
    try {
      await clients.open(`${base}/mcp/composio`, { accept: "text/event-stream", "x-memmy-mcp-token": "shutdown-test-mcp" });
      const tool = clients.open(`${base}/mcp/composio`, {
        accept: "application/json, text/event-stream", "content-type": "application/json", "x-memmy-mcp-token": "shutdown-test-mcp",
      }, JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "composio_execute_tool", arguments: { tool_slug: "FIXTURE_SAVE", arguments: {} } } }));
      await entered.promise;
      shutdown = app.close();
      expect(await settlesWithin(shutdown, 30)).toBe(false);
      expect(saved).toBe(false);
      release.resolve();
      const response = await tool;
      expect(response.statusCode).toBe(200);
      const body = await clients.body(response);
      const result = JSON.parse(body.split("data: ")[1].trim());
      expect(result.id).toBe(7);
      expect(JSON.parse(result.result.content[0].text)).toEqual({ saved: true });
      expect(await settlesWithin(shutdown)).toBe(true);
      expect(saved).toBe(true);
    } finally { release.resolve(); clients.destroy(); await (shutdown ?? app.close()); }
  });
});
