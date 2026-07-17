/** Agent sources route tests. */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createProgressBus, type ProgressBus } from "../../../../services/progress-bus.js";
import { createLocalApiServer } from "../server.js";
import type { FastifyInstance } from "fastify";
import type { PermissionManager } from "../../../../permission/index.js";
import type { AgentSourceService, CollectedSourceScan } from "../../../../services/agent-source-service.js";
import type { BackendServices } from "../../../../services/index.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("agent sources local api routes", () => {
  it("lists agent sources with runtime token authentication", async () => {
    const { server } = createServer();
    app = server;

    const response = await server.inject({
      method: "GET",
      url: "/api/agent-sources",
      headers: { "x-memmy-local-token": "test-token" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({
        sourceId: "cursor",
        status: "not_connected"
      })
    ]);
  });

  it("returns detected memory plugin conflicts", async () => {
    const { server } = createServer({
      agentSources: {
        ...createFakeAgentSourceService(),
        async detectMemoryPluginConflicts() {
          return [
            {
              sourceId: "openclaw",
              displayName: "OpenClaw",
              configPath: "/tmp/openclaw/openclaw.json",
              installedPluginId: "memory-core"
            }
          ];
        }
      }
    });
    app = server;

    const response = await server.inject({
      method: "GET",
      url: "/api/agent-sources/memory-plugin-conflicts",
      headers: { "x-memmy-local-token": "test-token" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      conflicts: [
        {
          sourceId: "openclaw",
          displayName: "OpenClaw",
          configPath: "/tmp/openclaw/openclaw.json",
          installedPluginId: "memory-core"
        }
      ]
    });
  });

  it("runs agent source auto inject through the local api", async () => {
    const calls: string[] = [];
    const { server } = createServer({
      agentSourceAutoInject: {
        async runOnce() {
          calls.push("run");
          return {
            ok: true,
            skipped: false,
            installed: ["cursor"],
            failed: []
          };
        }
      }
    });
    app = server;

    const response = await server.inject({
      method: "POST",
      url: "/api/agent-sources/auto-inject/run",
      headers: { "x-memmy-local-token": "test-token" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      skipped: false,
      installed: ["cursor"],
      failed: []
    });
    expect(calls).toEqual(["run"]);
  });

  it("adds, removes, installs plugin, installs skill, and uninstalls agent sources", async () => {
    const calls: string[] = [];
    const { server } = createServer({
      agentSources: {
        ...createFakeAgentSourceService(),
        async addManual(input) {
          calls.push(`add:${input.displayName}`);
          return {
            sourceId: "manual-1",
            displayName: input.displayName,
            dataPath: input.dataPath,
            builtin: false,
            available: true,
            status: "not_connected",
            messageCount: 0,
            lastScannedAt: null
          };
        },
        async remove(sourceId) {
          calls.push(`remove:${sourceId}`);
        },
        async installSkill(sourceId) {
          calls.push(`install:${sourceId}`);
        },
        async uninstallSkill(sourceId) {
          calls.push(`uninstall:${sourceId}`);
        },
        async installPlugin(sourceId) {
          calls.push(`plugin:${sourceId}`);
        },
        async uninstallPlugin(sourceId) {
          calls.push(`unplugin:${sourceId}`);
        }
      }
    });
    app = server;

    const addResponse = await server.inject({
      method: "POST",
      url: "/api/agent-sources/manual",
      headers: { "x-memmy-local-token": "test-token" },
      payload: {
        displayName: "Manual Agent",
        dataPath: "/tmp/manual"
      }
    });
    const removeResponse = await server.inject({
      method: "DELETE",
      url: "/api/agent-sources/manual-1",
      headers: { "x-memmy-local-token": "test-token" }
    });
    const installResponse = await server.inject({
      method: "POST",
      url: "/api/agent-sources/cursor/skill",
      headers: { "x-memmy-local-token": "test-token" }
    });
    const installPluginResponse = await server.inject({
      method: "POST",
      url: "/api/agent-sources/openclaw/plugin",
      headers: { "x-memmy-local-token": "test-token" }
    });
    const uninstallPluginResponse = await server.inject({
      method: "DELETE",
      url: "/api/agent-sources/openclaw/plugin",
      headers: { "x-memmy-local-token": "test-token" }
    });
    const uninstallResponse = await server.inject({
      method: "DELETE",
      url: "/api/agent-sources/cursor/skill",
      headers: { "x-memmy-local-token": "test-token" }
    });

    expect(addResponse.statusCode).toBe(200);
    expect(removeResponse.json()).toEqual({ ok: true });
    expect(installResponse.json()).toEqual({ ok: true });
    expect(installPluginResponse.json()).toEqual({ ok: true });
    expect(uninstallPluginResponse.json()).toEqual({ ok: true });
    expect(uninstallResponse.json()).toEqual({ ok: true });
    expect(calls).toEqual(["add:Manual Agent", "remove:manual-1", "install:cursor", "plugin:openclaw", "unplugin:openclaw", "uninstall:cursor"]);
  });

  it("returns a structured user-actionable error when skill target is unavailable", async () => {
    const { server } = createServer({
      agentSources: {
        ...createFakeAgentSourceService(),
        async installSkill() {
          throw Object.assign(new Error("Opencode is not installed or its directory is unavailable"), {
            code: "agent_source_unavailable"
          });
        }
      }
    });
    app = server;

    const response = await server.inject({
      method: "POST",
      url: "/api/agent-sources/opencode/skill",
      headers: { "x-memmy-local-token": "test-token", "x-request-id": "req-opencode-skill" }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: "agent_source_unavailable",
        message: "Opencode is not installed or its directory is unavailable",
        requestId: "req-opencode-skill"
      }
    });
  });

  it("returns a structured user-actionable error when plugin target is unavailable", async () => {
    const { server } = createServer({
      agentSources: {
        ...createFakeAgentSourceService(),
        async installPlugin() {
          throw Object.assign(new Error("Hermes is not installed or its directory is unavailable"), {
            code: "agent_source_unavailable"
          });
        }
      }
    });
    app = server;

    const response = await server.inject({
      method: "POST",
      url: "/api/agent-sources/hermes/plugin",
      headers: { "x-memmy-local-token": "test-token", "x-request-id": "req-hermes-plugin" }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: "agent_source_unavailable",
        message: "Hermes is not installed or its directory is unavailable",
        requestId: "req-hermes-plugin"
      }
    });
  });

  it("starts scan jobs and forwards progress through SSE", async () => {
    const progressBus = createProgressBus();
    const { server } = createServer({ progressBus });
    app = server;
    await server.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${(server.server.address() as { port: number }).port}`;

    const controller = new AbortController();
    const eventsResponse = await fetch(`${baseUrl}/api/events?token=test-token`, {
      signal: controller.signal
    });
    const scanResponse = await fetch(`${baseUrl}/api/agent-sources/scan`, {
      method: "POST",
      headers: { "x-memmy-local-token": "test-token" }
    });
    const text = await readStreamUntil(eventsResponse, "agent_source.scan_completed");
    controller.abort();

    expect(scanResponse.status).toBe(200);
    expect(await scanResponse.json()).toEqual({ jobId: expect.any(String) });
    expect(text).toContain('"phase":"scan"');
    expect(text).toContain("adapter read");
    expect(text).toContain("event: agent_source.scan_progress");
    expect(text).toContain("event: agent_source.scan_completed");
  });

  it("responds with the scan job before collecting sources", async () => {
    const calls: string[] = [];
    const { server } = createServer({
      agentSources: {
        ...createFakeAgentSourceService(),
        async collectAll() {
          calls.push("collectAll");
          return [];
        },
        async ingestCollected() {
          return [];
        },
        async processImportSummaries() {
          return undefined;
        }
      }
    });
    app = server;

    const response = await server.inject({
      method: "POST",
      url: "/api/agent-sources/scan",
      headers: { "x-memmy-local-token": "test-token" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ jobId: expect.any(String) });
    expect(calls).toEqual([]);

    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toEqual(["collectAll"]);
  });

  it("starts source-scoped scan jobs from the request body", async () => {
    const calls: string[] = [];
    const { server } = createServer({
      agentSources: {
        ...createFakeAgentSourceService(),
        async collectAll() {
          calls.push("collectAll");
          return [];
        },
        async collectOne(sourceId) {
          calls.push(`collectOne:${sourceId}`);
          return createCollectedFixture(1, sourceId);
        },
        async ingestCollected(collected) {
          calls.push(`ingest:${collected.map((source) => source.sourceId).join(",")}`);
          return collected.map(toScanResult);
        },
        async processImportSummaries(options) {
          calls.push(`summarize:${options?.progressSourceId ?? "all"}`);
        }
      }
    });
    app = server;

    const response = await server.inject({
      method: "POST",
      url: "/api/agent-sources/scan",
      headers: { "x-memmy-local-token": "test-token" },
      payload: { sourceId: "openclaw" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ jobId: expect.any(String) });
    expect(calls).toEqual([]);

    await waitFor(() => calls.includes("summarize:openclaw"));
    expect(calls).toEqual(["collectOne:openclaw", "ingest:openclaw", "summarize:openclaw"]);
  });

  it("stops the active scan job", async () => {
    let resolveStopped: () => void = () => undefined;
    const stopped = new Promise<void>((resolve) => {
      resolveStopped = resolve;
    });
    let collectCalls = 0;
    const { server } = createServer({
      agentSources: {
        ...createFakeAgentSourceService(),
        async collectAll(options) {
          collectCalls += 1;
          if (options?.signal?.aborted) {
            resolveStopped();
          } else {
            options?.signal?.addEventListener("abort", () => resolveStopped(), { once: true });
          }
          await stopped;
          return [];
        },
        async ingestCollected() {
          return [];
        },
        async processImportSummaries() {
          return undefined;
        }
      }
    });
    app = server;

    const scanResponse = await server.inject({
      method: "POST",
      url: "/api/agent-sources/scan",
      headers: { "x-memmy-local-token": "test-token" }
    });
    const stopResponse = await server.inject({
      method: "POST",
      url: "/api/agent-sources/scan/stop",
      headers: { "x-memmy-local-token": "test-token" }
    });
    const stoppedStatusResponse = await server.inject({
      method: "GET",
      url: "/api/agent-sources/scan/status",
      headers: { "x-memmy-local-token": "test-token" }
    });
    await stopped;
    const continueResponse = await server.inject({
      method: "POST",
      url: "/api/agent-sources/scan",
      headers: { "x-memmy-local-token": "test-token" }
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(scanResponse.statusCode).toBe(200);
    expect(stopResponse.json()).toEqual({ ok: true });
    expect(stoppedStatusResponse.json()).toEqual({
      active: false,
      progress: expect.objectContaining({
        jobId: scanResponse.json().jobId,
        phase: "stopped"
      })
    });
    expect(continueResponse.statusCode).toBe(200);
    expect(continueResponse.json()).not.toEqual(scanResponse.json());
    expect(collectCalls).toBe(2);
  });

  it("cancels a paused full scan so a source-scoped scan can start", async () => {
    let resolveCanceled: () => void = () => undefined;
    const canceled = new Promise<void>((resolve) => {
      resolveCanceled = resolve;
    });
    const calls: string[] = [];
    const { server } = createServer({
      agentSources: {
        ...createFakeAgentSourceService(),
        async collectAll(options) {
          calls.push("collectAll");
          if (options?.signal?.aborted) {
            resolveCanceled();
          } else {
            options?.signal?.addEventListener("abort", () => resolveCanceled(), { once: true });
          }
          await canceled;
          return [];
        },
        async collectOne(sourceId) {
          calls.push(`collectOne:${sourceId}`);
          return createCollectedFixture(1, sourceId);
        },
        async ingestCollected(collected) {
          calls.push(`ingest:${collected.map((source) => source.sourceId).join(",")}`);
          return collected.map(toScanResult);
        },
        async processImportSummaries() {
          return undefined;
        }
      }
    });
    app = server;

    const scanResponse = await server.inject({
      method: "POST",
      url: "/api/agent-sources/scan",
      headers: { "x-memmy-local-token": "test-token" }
    });
    await waitFor(() => calls.includes("collectAll"));
    const cancelResponse = await server.inject({
      method: "POST",
      url: "/api/agent-sources/scan/cancel",
      headers: { "x-memmy-local-token": "test-token" }
    });
    await canceled;
    await new Promise((resolve) => setImmediate(resolve));
    const statusResponse = await server.inject({
      method: "GET",
      url: "/api/agent-sources/scan/status",
      headers: { "x-memmy-local-token": "test-token" }
    });
    const openclawResponse = await server.inject({
      method: "POST",
      url: "/api/agent-sources/scan",
      headers: { "x-memmy-local-token": "test-token" },
      payload: { sourceId: "openclaw" }
    });

    expect(scanResponse.statusCode).toBe(200);
    expect(cancelResponse.json()).toEqual({ ok: true });
    expect(statusResponse.json()).toEqual({ active: false, progress: null });
    expect(openclawResponse.statusCode).toBe(200);
    expect(openclawResponse.json()).not.toEqual(scanResponse.json());
    await waitFor(() => calls.includes("collectOne:openclaw"));
    expect(calls).toContain("ingest:openclaw");
  });

  it("resumes a stopped add phase without collecting sources again", async () => {
    let resolveFirstIngest: () => void = () => undefined;
    const firstIngestStopped = new Promise<void>((resolve) => {
      resolveFirstIngest = resolve;
    });
    let collectCalls = 0;
    let ingestCalls = 0;
    const { server } = createServer({
      agentSources: {
        ...createFakeAgentSourceService(),
        async collectAll(options) {
          collectCalls += 1;
          options?.onProgress?.({
            sourceId: "cursor",
            phase: "scan",
            current: 2,
            total: 2,
            message: "Source scan completed"
          });
          return [createCollectedFixture(2)];
        },
        async ingestCollected(collected, options) {
          ingestCalls += 1;
          options?.onProgress?.({
            sourceId: "cursor",
            phase: "add",
            current: ingestCalls === 1 ? 1 : 2,
            total: 2,
            message: "Adding memories"
          });
          if (ingestCalls === 1) {
            if (options?.signal?.aborted) {
              resolveFirstIngest();
            } else {
              options?.signal?.addEventListener("abort", () => resolveFirstIngest(), { once: true });
            }
            await firstIngestStopped;
            options?.signal?.throwIfAborted();
          }
          return collected.map(toScanResult);
        },
        async processImportSummaries() {
          return undefined;
        }
      }
    });
    app = server;

    const scanResponse = await server.inject({
      method: "POST",
      url: "/api/agent-sources/scan",
      headers: { "x-memmy-local-token": "test-token" }
    });
    await waitFor(() => ingestCalls === 1);
    const stopResponse = await server.inject({
      method: "POST",
      url: "/api/agent-sources/scan/stop",
      headers: { "x-memmy-local-token": "test-token" }
    });
    await firstIngestStopped;
    await new Promise((resolve) => setImmediate(resolve));
    const continueResponse = await server.inject({
      method: "POST",
      url: "/api/agent-sources/scan",
      headers: { "x-memmy-local-token": "test-token" }
    });
    await waitFor(() => ingestCalls === 2);
    await new Promise((resolve) => setImmediate(resolve));

    expect(stopResponse.json()).toEqual({ ok: true });
    expect(continueResponse.statusCode).toBe(200);
    expect(continueResponse.json()).toEqual(scanResponse.json());
    expect(collectCalls).toBe(1);
    expect(ingestCalls).toBe(2);
  });

  it("returns active scan status for page reload recovery", async () => {
    let releaseScan: () => void = () => undefined;
    const scanGate = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    const { server } = createServer({
      agentSources: {
        ...createFakeAgentSourceService(),
        async collectAll() {
          return [createCollectedFixture()];
        },
        async ingestCollected(_collected, options) {
          options?.onProgress?.({
            sourceId: "cursor",
            phase: "add",
            current: 2,
            total: 5,
            message: "Adding memories"
          });
          await scanGate;
          return [];
        },
        async processImportSummaries() {
          return undefined;
        }
      }
    });
    app = server;

    const scanResponse = await server.inject({
      method: "POST",
      url: "/api/agent-sources/scan",
      headers: { "x-memmy-local-token": "test-token" }
    });
    await new Promise((resolve) => setImmediate(resolve));
    const statusResponse = await server.inject({
      method: "GET",
      url: "/api/agent-sources/scan/status",
      headers: { "x-memmy-local-token": "test-token" }
    });
    releaseScan();
    await new Promise((resolve) => setImmediate(resolve));

    expect(statusResponse.statusCode).toBe(200);
    expect(statusResponse.json()).toEqual({
      active: true,
      progress: {
        jobId: scanResponse.json().jobId,
        sourceId: "cursor",
        phase: "add",
        current: 2,
        total: 5,
        message: "Adding memories"
      }
    });
  });

  it("keeps stopped scan status when the aborted job emits stale progress", async () => {
    let resolveStopped: () => void = () => undefined;
    const stopped = new Promise<void>((resolve) => {
      resolveStopped = resolve;
    });
    const { server } = createServer({
      agentSources: {
        ...createFakeAgentSourceService(),
        async collectAll() {
          return [createCollectedFixture()];
        },
        async ingestCollected(_collected, options) {
          options?.onProgress?.({
            sourceId: "cursor",
            phase: "add",
            current: 2,
            total: 5,
            message: "Adding memories"
          });
          options?.signal?.addEventListener("abort", () => {
            options.onProgress?.({
              sourceId: "cursor",
              phase: "add",
              current: 4,
              total: 5,
              message: "stale progress after stop"
            });
            resolveStopped();
          }, { once: true });
          await stopped;
          return [];
        },
        async processImportSummaries() {
          return undefined;
        }
      }
    });
    app = server;

    const scanResponse = await server.inject({
      method: "POST",
      url: "/api/agent-sources/scan",
      headers: { "x-memmy-local-token": "test-token" }
    });
    await new Promise((resolve) => setImmediate(resolve));
    const stopResponse = await server.inject({
      method: "POST",
      url: "/api/agent-sources/scan/stop",
      headers: { "x-memmy-local-token": "test-token" }
    });
    await stopped;
    await new Promise((resolve) => setImmediate(resolve));
    const statusResponse = await server.inject({
      method: "GET",
      url: "/api/agent-sources/scan/status",
      headers: { "x-memmy-local-token": "test-token" }
    });

    expect(scanResponse.statusCode).toBe(200);
    expect(stopResponse.json()).toEqual({ ok: true });
    expect(statusResponse.json()).toEqual({
      active: false,
      progress: expect.objectContaining({
        jobId: scanResponse.json().jobId,
        sourceId: "cursor",
        phase: "stopped",
        current: 2,
        total: 5
      })
    });
  });

  it("throttles high-frequency scan progress events before forwarding to SSE", async () => {
    const progressBus = createProgressBus();
    const { server } = createServer({
      progressBus,
      agentSources: {
        ...createFakeAgentSourceService(),
        async collectAll(options) {
          for (let index = 1; index <= 120; index += 1) {
            options?.onProgress?.({
              sourceId: "cursor",
              phase: index % 2 === 0 ? "emit" : "redact",
              current: index,
              total: 120
            });
          }
          return [createCollectedFixture(120)];
        },
        async ingestCollected(collected) {
          return collected.map(toScanResult);
        },
        async processImportSummaries() {
          return undefined;
        }
      }
    });
    app = server;
    await server.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${(server.server.address() as { port: number }).port}`;

    const controller = new AbortController();
    const eventsResponse = await fetch(`${baseUrl}/api/events?token=test-token`, {
      signal: controller.signal
    });
    await fetch(`${baseUrl}/api/agent-sources/scan`, {
      method: "POST",
      headers: { "x-memmy-local-token": "test-token" }
    });
    const text = await readStreamUntil(eventsResponse, "agent_source.scan_completed");
    controller.abort();

    const progressEvents = text.match(/event: agent_source\.scan_progress/g) ?? [];
    expect(progressEvents.length).toBeLessThan(10);
    expect(text).toContain('"current":101');
  });

  it("rejects scan jobs when onboarding scan permission is denied", async () => {
    const { server } = createServer({
      permissionManager: {
        ...createFakePermissionManager(),
        async canScanAgentSource() {
          return false;
        }
      }
    });
    app = server;

    const response = await server.inject({
      method: "POST",
      url: "/api/agent-sources/scan",
      headers: { "x-memmy-local-token": "test-token" }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        code: "scan_not_permitted",
        message: "scan not permitted"
      }
    });
  });
});

function createServer(
  overrides: {
    agentSources?: AgentSourceService;
    agentSourceAutoInject?: BackendServices["agentSourceAutoInject"];
    progressBus?: ProgressBus;
    permissionManager?: PermissionManager;
  } = {}
): {
  server: FastifyInstance;
} {
  const progressBus = overrides.progressBus ?? createProgressBus();
  const services = {
    agentAdapterRegistry: {
      listAdapters: () => []
    },
    bootstrap: {
      async getBootstrap() {
        throw new Error("bootstrap not used in this test");
      }
    },
    agentSources: overrides.agentSources ?? createFakeAgentSourceService(),
    agentSourceAutoInject: overrides.agentSourceAutoInject ?? {
      async runOnce() {
        return {
          ok: true,
          skipped: true,
          reason: "test",
          installed: [],
          failed: []
        };
      }
    },
    progressBus
  } as unknown as BackendServices;

  return {
    server: createLocalApiServer({
      permissionManager: overrides.permissionManager ?? createFakePermissionManager(),
      services,
      heartbeatIntervalMs: 20
    })
  };
}

function createFakeAgentSourceService(): AgentSourceService {
  async function collectAll(options?: Parameters<AgentSourceService["collectAll"]>[0]) {
    options?.onProgress?.({
      sourceId: "cursor",
      phase: "read",
      current: 1,
      total: 1,
      message: "adapter read"
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    return [createCollectedFixture()];
  }

  async function ingestCollected(collected: readonly CollectedSourceScan[]) {
    return collected.map(toScanResult);
  }

  async function processImportSummaries() {
    return undefined;
  }

  return {
    async list() {
      return [
        {
          sourceId: "cursor",
          displayName: "Cursor",
          dataPath: "/tmp/cursor",
          builtin: true,
          available: true,
          status: "not_connected",
          messageCount: 0,
          lastScannedAt: null
        }
      ];
    },
    async scanAll(options) {
      const collected = await collectAll(options);
      const results = await ingestCollected(collected);
      await processImportSummaries();
      return results;
    },
    collectAll,
    async collectOne(sourceId, options) {
      return collectAll(options).then(() => createCollectedFixture(1, sourceId));
    },
    ingestCollected,
    processImportSummaries,
    async scanOne(sourceId) {
      return toScanResult({
        ...createCollectedFixture(),
        sourceId
      });
    },
    async addManual(input) {
      return {
        sourceId: randomUUID(),
        displayName: input.displayName,
        dataPath: input.dataPath,
        builtin: false,
        available: true,
        status: "not_connected",
        messageCount: 0,
        lastScannedAt: null
      };
    },
    async remove() {
      return undefined;
    },
    async installSkill() {
      return undefined;
    },
    async uninstallSkill() {
      return undefined;
    },
    async installPlugin() {
      return undefined;
    },
    async uninstallPlugin() {
      return undefined;
    },
    async detectMemoryPluginConflicts() {
      return [];
    }
  };
}

function createCollectedFixture(messageCount = 1, sourceId = "cursor"): CollectedSourceScan {
  const conversationId = `${sourceId}-conversation-1`;
  return {
    sourceId,
    conversationIds: messageCount > 0 ? [conversationId] : [],
    messages: Array.from({ length: messageCount }, (_, index) => ({
      messageId: `${sourceId}-message-${index + 1}`,
      sourceId,
      conversationId,
      role: "user",
      content: `message ${index + 1}`,
      createdAt: "2026-06-01T00:00:00.000Z",
      workspacePath: null,
      gitRoot: null,
      rawMeta: {}
    })),
    errors: []
  };
}

function toScanResult(collected: CollectedSourceScan) {
  return {
    sourceId: collected.sourceId,
    discoveredConversations: collected.conversationIds.length,
    emittedMessages: collected.messages.length,
    skipped: 0,
    errors: collected.errors
  };
}

function createFakePermissionManager(): PermissionManager {
  return {
    async getRuntimeToken() {
      return "test-token";
    },
    async verifyRuntimeToken(token) {
      return token === "test-token";
    },
    async getScanPermission() {
      return "scan_and_write_skill";
    },
    async setScanPermission() {
      return undefined;
    },
    async canDetectAgentSources() {
      return true;
    },
    async canScanAgentSource() {
      return true;
    },
    async canWriteAgentSkill() {
      return true;
    },
    async canSearchMemory() {
      return true;
    },
    async revokeAgentSource() {
      return undefined;
    }
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const timeoutAt = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > timeoutAt) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function readStreamUntil(response: Response, expected: string): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Expected readable response body");
  }

  const decoder = new TextDecoder();
  let text = "";
  const timeoutAt = Date.now() + 2_000;

  while (!text.includes(expected)) {
    if (Date.now() > timeoutAt) {
      throw new Error(`Timed out waiting for ${expected}`);
    }

    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }

    text += decoder.decode(chunk.value, { stream: true });
  }

  await reader.cancel();
  return text;
}
