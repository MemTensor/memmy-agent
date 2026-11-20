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
import { createModelCapabilityCatalogSyncService } from "../services/model-capability-catalog-sync-service.js";
import { createAppConfigService } from "../services/app-config-service.js";
import { createMemmyConfigWriter } from "../infrastructure/memmy-config/index.js";
import { readModelCapabilityCatalog } from "../infrastructure/model-capability-catalog/index.js";

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
function api(verifyRuntimeToken: () => Promise<boolean> = async () => true, executeRouterTool: BackendServices["integrations"]["executeRouterTool"] = async () => ({ saved: true }), overrides: Partial<BackendServices> = {}) {
  const progressBus = createProgressBus();
  const unsubscribers: ReturnType<typeof vi.fn>[] = [];
  const subscribedEvents: string[] = [];
  const services = {
    bootstrap: { async getBootstrap() { throw new Error("unused"); } },
    integrations: { executeRouterTool },
    ...overrides,
    progressBus: { ...progressBus, on: ((...args: Parameters<typeof progressBus.on>) => {
      subscribedEvents.push(args[0]);
      const unsubscribe = vi.fn(progressBus.on(...args)); unsubscribers.push(unsubscribe); return unsubscribe;
    }) }
  } as unknown as BackendServices;
  const app = createLocalApiServer({
    permissionManager: { verifyRuntimeToken } as PermissionManager,
    composioMcpToken: "shutdown-test-mcp", services, heartbeatIntervalMs: 60_000,
  });
  return { app, progressBus, unsubscribers, subscribedEvents };
}
async function listen(app: FastifyInstance) { return app.listen({ host: "127.0.0.1", port: 0 }); }

describe("local backend graceful shutdown", () => {
  it("publishes committed catalog changes over SSE and serves the new view without changing user configuration", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-catalog-events-"));
    const filePath = join(root, "models.json");
    const writer = createMemmyConfigWriter({ configPath: join(root, "config.yaml") });
    const appConfig = createAppConfigService({
      bootstrapRepository: {} as Parameters<typeof createAppConfigService>[0]["bootstrapRepository"],
      memmyConfigWriter: writer,
      getModelCapabilityCatalog: () => readModelCapabilityCatalog(filePath)
    });
    const { app, progressBus } = api(undefined, undefined, { appConfig });
    const clients = connections();
    // Real model configuration from the original client tables at b9e5a37a.
    const catalog = { catalogVersion: 1, models: { "gpt-5.4-mini": {
      inputModalities: ["text" as const, "image" as const], contextWindowTokens: 400000, maxTokens: 128000,
      thinking: { switchable: true, defaultEnabled: true, levels: ["low" as const, "medium" as const, "high" as const], defaultLevel: "medium" as const }
    } } };
    const getModelCapabilityCatalog = vi.fn<Parameters<typeof createModelCapabilityCatalogSyncService>[0]["cloudClient"]["getModelCapabilityCatalog"]>()
      .mockResolvedValue({ status: "updated", catalog });
    const sync = createModelCapabilityCatalogSyncService({
      cloudClient: { getModelCapabilityCatalog }, getCloudUuid: () => "isolated-test-account", filePath,
      onUpdated: updated => progressBus.emit("model_catalog.updated", { catalogVersion: updated.catalogVersion })
    });
    const base = await listen(app);
    try {
      const initial = await appConfig.getModelConfig();
      const stream = await clients.open(`${base}/api/events?token=test-token`);
      let body = "";
      let notify = () => {};
      stream.on("data", chunk => { body += String(chunk); notify(); });
      for (const version of [1, 2]) {
        const updated = version === 1 ? catalog : { catalogVersion: 2, models: {} };
        getModelCapabilityCatalog.mockResolvedValueOnce({ status: "updated", catalog: updated });
        const received = new Promise<void>(resolve => {
          notify = () => { if (body.includes(`"catalogVersion":${version}`)) resolve(); };
        });
        expect((await sync.sync()).status).toBe("updated");
        expect(await settlesWithin(received, 1000)).toBe(true);
        // Read immediately after the event, as the renderer does; the committed file must already be visible.
        const response = await app.inject({ method: "GET", url: "/api/app/model-config", headers: { "x-memmy-local-token": "test-token" } });
        expect(response.statusCode).toBe(200);
        const { capabilityCatalog, ...config } = response.json();
        expect(capabilityCatalog).toEqual(updated);
        expect(config).toEqual(initial);
      }
      getModelCapabilityCatalog.mockResolvedValueOnce({ status: "not-modified" });
      expect((await sync.sync()).status).toBe("not-modified");
      // Use an ordered stream marker to count all notifications preceding it.
      progressBus.emit("model_catalog.updated", { catalogVersion: 3 });
      await vi.waitFor(() => expect(body).toContain('"catalogVersion":3'));
      expect(body.match(/event: model_catalog.updated/g)).toHaveLength(3);
      expect(await writer.readModelConfig()).toEqual(initial);
    } finally {
      await sync.stop();
      clients.destroy();
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("delivers model catalog refresh notifications over the authenticated event stream", async () => {
    const { app, progressBus } = api();
    const clients = connections();
    const base = await listen(app);
    try {
      const stream = await clients.open(`${base}/api/events?token=test-token`);
      let body = "";
      const received = new Promise<void>(resolve => stream.on("data", chunk => {
        body += String(chunk);
        if (body.includes('"type":"model_catalog.updated"')) resolve();
      }));
      progressBus.emit("model_catalog.updated", { catalogVersion: 22 });
      expect(await settlesWithin(received, 1000)).toBe(true);
      expect(body).toContain('"payload":{"catalogVersion":22}');
    } finally {
      clients.destroy();
      await app.close();
    }
  });
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
    const { app, unsubscribers, subscribedEvents } = api();
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
      expect(subscribedEvents).toEqual(["agent_source.scan_progress", "agent_source.scan_completed", "plugin.capability_event", "model_catalog.updated"]);
      expect(unsubscribers).toHaveLength(4);
      for (const unsubscribe of unsubscribers) expect(unsubscribe).toHaveBeenCalledOnce();
    } finally { release.resolve(); clients.destroy(); await (shutdown ?? app.close()); }
  });

  it("also ends an event stream whose authentication was already in flight when closing started", async () => {
    const entered = deferred(); const authorize = deferred();
    const { app, unsubscribers, subscribedEvents } = api(async () => { entered.resolve(); await authorize.promise; return true; });
    const clients = connections(); const base = await listen(app); let shutdown: Promise<void> | undefined;
    try {
      const stream = clients.open(`${base}/api/events?token=test-token`);
      await entered.promise;
      shutdown = app.close();
      expect(await settlesWithin(shutdown, 30)).toBe(false);
      authorize.resolve();
      expect((await stream).statusCode).toBe(200);
      expect(await settlesWithin(shutdown)).toBe(true);
      expect(subscribedEvents).toEqual(["agent_source.scan_progress", "agent_source.scan_completed", "plugin.capability_event", "model_catalog.updated"]);
      expect(unsubscribers).toHaveLength(4);
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
