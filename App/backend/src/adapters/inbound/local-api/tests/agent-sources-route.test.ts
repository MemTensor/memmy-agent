/** Agent sources route tests. */
import { randomUUID } from "node:crypto";
import { MANAGED_AGENT_DISCOVERY_PENDING_DATA_PATH } from "@memmy/local-api-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgressBus, type ProgressBus } from "../../../../services/progress-bus.js";
import { createLocalApiServer } from "../server.js";
import type { FastifyInstance } from "fastify";
import type { PermissionManager } from "../../../../permission/index.js";
import type { AgentSourceService } from "../../../../services/agent-source-service.js";
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
            dataPath: MANAGED_AGENT_DISCOVERY_PENDING_DATA_PATH,
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
        displayName: "Manual Agent"
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

  it("accepts AI-normalized history batches and managed Skill status updates", async () => {
    const calls: string[] = [];
    const { server } = createServer({
      agentSources: {
        ...createFakeAgentSourceService(),
        async importManaged(sourceId, input) {
          calls.push(`import:${sourceId}:${input.mode}:${input.messages.length}:${input.final}`);
          return {
            sourceId,
            attempted: input.messages.length,
            written: input.messages.length,
            deduped: 0,
            failed: 0,
            memoryIds: ["memory-1"],
            syncBoundaryAt: input.syncBoundaryAt ?? null,
            errors: []
          };
        },
        async syncManaged(sourceId) {
          calls.push(`sync:${sourceId}`);
          return {
            sourceId,
            attempted: 2,
            written: 1,
            deduped: 1,
            failed: 0,
            memoryIds: ["memory-2"],
            syncBoundaryAt: "2026-07-01T10:00:00.000Z",
            errors: []
          };
        },
        async updateManaged(sourceId, input) {
          calls.push(`update:${sourceId}:${input.skillInstalled}`);
          return {
            sourceId,
            displayName: "Aider",
            dataPath: input.dataPath ?? "/tmp/aider",
            builtin: false,
            available: true,
            status: input.skillInstalled ? "skill_installed" : "not_connected",
            messageCount: 2,
            lastScannedAt: null,
            syncBoundaryAt: null
          };
        }
      }
    });
    app = server;

    const importResponse = await server.inject({
      method: "POST",
      url: "/api/agent-sources/manual-1/managed/import",
      headers: { "x-memmy-local-token": "test-token" },
      payload: {
        mode: "initial_subset",
        messages: [
          {
            messageId: "message-1",
            conversationId: "conversation-1",
            role: "user",
            content: "question",
            createdAt: "2026-07-01T10:00:00.000Z"
          }
        ],
        syncBoundaryAt: "2026-07-01T10:00:00.000Z",
        final: true
      }
    });
    const updateResponse = await server.inject({
      method: "PATCH",
      url: "/api/agent-sources/manual-1/managed",
      headers: { "x-memmy-local-token": "test-token" },
      payload: {
        dataPath: "/tmp/aider",
        skillInstalled: true
      }
    });
    const syncResponse = await server.inject({
      method: "POST",
      url: "/api/agent-sources/manual-1/managed/sync",
      headers: { "x-memmy-local-token": "test-token" }
    });

    expect(importResponse.statusCode).toBe(200);
    expect(importResponse.json()).toMatchObject({
      sourceId: "manual-1",
      attempted: 1,
      syncBoundaryAt: "2026-07-01T10:00:00.000Z"
    });
    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json()).toMatchObject({
      sourceId: "manual-1",
      status: "skill_installed",
      dataPath: "/tmp/aider"
    });
    expect(syncResponse.json()).toMatchObject({
      sourceId: "manual-1",
      attempted: 2,
      written: 1,
      deduped: 1
    });
    expect(calls).toEqual([
      "import:manual-1:initial_subset:1:true",
      "update:manual-1:true",
      "sync:manual-1"
    ]);
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
    scanClient?: import("../../../outbound/memory-client/types.js").AgentSourceScanClient;
    agentSourceAutoInject?: BackendServices["agentSourceAutoInject"];
    progressBus?: ProgressBus;
    permissionManager?: PermissionManager;
  } = {}
): {
  server: FastifyInstance;
} {
  const progressBus = overrides.progressBus ?? createProgressBus();
  const services = {
    memoryClient: { agentSources: overrides.scanClient },
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
    async addManual(input) {
      return {
        sourceId: randomUUID(),
        displayName: input.displayName,
        dataPath: MANAGED_AGENT_DISCOVERY_PENDING_DATA_PATH,
        builtin: false,
        available: true,
        status: "not_connected",
        messageCount: 0,
        lastScannedAt: null
      };
    },
    async importManaged(sourceId, input) {
      return {
        sourceId,
        attempted: input.messages.length,
        written: input.messages.length,
        deduped: 0,
        failed: 0,
        memoryIds: [],
        syncBoundaryAt: input.syncBoundaryAt ?? null,
        errors: []
      };
    },
    async syncManaged(sourceId) {
      return {
        sourceId,
        attempted: 0,
        written: 0,
        deduped: 0,
        failed: 0,
        memoryIds: [],
        syncBoundaryAt: null,
        errors: []
      };
    },
    async updateManaged(sourceId, input) {
      return {
        sourceId,
        displayName: "Manual Agent",
        dataPath: input.dataPath ?? MANAGED_AGENT_DISCOVERY_PENDING_DATA_PATH,
        builtin: false,
        available: true,
        status: input.skillInstalled ? "skill_installed" : "not_connected",
        messageCount: 0,
        lastScannedAt: null,
        syncBoundaryAt: null
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
    async isInstalledHookCurrent() {
      return true;
    },
    async detectMemoryPluginConflicts() {
      return [];
    }
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

it("forwards initial, incremental and full scans through Memory with desktop permission checks", async () => {
  const status = { running: false, jobId: null, sourceId: null, mode: null, progress: null, startedAt: null, completedAt: null, error: null };
  const start = vi.fn(async () => ({ jobId: "memory-job" }));
  const scanClient = { start, status: async () => status } as unknown as import("../../../outbound/memory-client/types.js").AgentSourceScanClient;
  const { server } = createServer({ scanClient }); app = server;
  for (const body of [{ sourceId: "all", mode: "initial_subset" }, { sourceId: "codex" }, { sourceId: "all", mode: "full" }]) {
    const response = await server.inject({ method: "POST", url: "/api/agent-sources/scan", headers: { "x-memmy-local-token": "test-token" }, payload: body });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ jobId: "memory-job" });
    expect(start).toHaveBeenLastCalledWith(body);
  }
  const unauthorized = await server.inject({ method: "POST", url: "/api/agent-sources/scan", payload: { sourceId: "all" } });
  expect(unauthorized.statusCode).toBe(401);
  expect(start).toHaveBeenCalledTimes(3);
});
