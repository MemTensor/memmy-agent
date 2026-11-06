import * as fsPromises from "node:fs/promises";
import YAML from "yaml";
import { renderMemmyDefaultSkillManifest } from "../../adapters/outbound/skill-writer/templates/memmy-default.js";
/** Agent source service tests. */
import { DatabaseSync } from "node:sqlite";
import { MANAGED_AGENT_DISCOVERY_PENDING_DATA_PATH } from "@memmy/local-api-contracts";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSourceRegistry } from "@memmy/agent-source-readers/adapters/source-registry";
import type {
  ConversationMessage,
  ScanOptions,
  SourceAdapter,
  SourceDescriptor
} from "@memmy/agent-source-readers/adapters/types";
import type { MemoryClient } from "../../adapters/outbound/memory-client/index.js";
import { MemoryLayerError, MemoryLayerNetworkError } from "../../adapters/outbound/memory-client/errors.js";
import { createAgentSourceRepository, type AgentSourceRepository } from "../../infrastructure/agent-source-store/index.js";
import { createMockMemoryClient } from "../../tests/support/mock-memory-client.js";
import type { IngestionService } from "../ingestion-service.js";
import { createAgentSourceService, type AgentSourceService } from "../agent-source-service.js";
import {
  AGENT_SOURCE_ANALYTICS_EVENTS,
  buildAgentSourceConflictParams,
  buildAgentSourcePluginLifecycleParams,
  buildAgentSourceSkillLifecycleParams,
  type AgentSourceLifecycleAnalytics,
} from "../../analytics/agent-source-analytics.js";
import { createSkillDistributionService, type SkillDistributionService } from "../skill-distribution-service.js";
import { createAgentSourceAutoInjectService } from "../agent-source-auto-inject-service.js";
import { resolveAgentSourceConnectionAction } from "../../../../frontend/desktop/src/pages/memory-sources-page.js";
import { createCodexSkillTarget } from "../../adapters/outbound/skill-writer/codex/index.js";
import { createClaudeCodeSkillTarget } from "../../adapters/outbound/skill-writer/claude-code/index.js";
import { createOpencodeSkillTarget } from "../../adapters/outbound/skill-writer/opencode/index.js";
import { createOpenclawSkillTarget } from "../../adapters/outbound/skill-writer/openclaw/index.js";
import { createHermesSkillTarget } from "../../adapters/outbound/skill-writer/hermes/index.js";
import { createWorkbuddySkillTarget } from "../../adapters/outbound/skill-writer/workbuddy/index.js";
import { createSkillTargetRegistry } from "../../adapters/outbound/skill-writer/target-registry.js";
import { createAgentSourceExecutor } from "../../../../../Memory/src/agent-source/runtime.js";
import { createCapturingEmbedder, createFailingLlm, createMemoryServiceFixture } from "../../../../../Memory/tests/fixtures/memory-service-fixture.js";

vi.mock("node:fs/promises", async importOriginal => ({ ...await importOriginal<typeof import("node:fs/promises")>() }));

const isolatedUser = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await vi.importActual<typeof import("node:os")>("node:os");
  const { join } = await import("node:path");
  return { home: mkdtempSync(join(tmpdir(), "pr780-connection-user-")) };
});

// Every production import, including shared-skill discovery and installation-id
// creation, sees the synthetic user. Agent-specific overrides and process HOME are also isolated.
vi.mock("node:os", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:os")>(),
  homedir: () => isolatedUser.home
}));

beforeEach(() => {
  for (const name of ["HOME", "USERPROFILE"]) vi.stubEnv(name, isolatedUser.home);
  for (const [name, directory] of Object.entries({ CODEX_HOME: ".codex", CLAUDE_CONFIG_DIR: ".claude", XDG_CONFIG_HOME: ".config", HERMES_HOME: ".hermes", OPENCLAW_STATE_DIR: ".openclaw" })) vi.stubEnv(name, join(isolatedUser.home, directory));

  rmSync(isolatedUser.home, { recursive: true, force: true });
  mkdirSync(isolatedUser.home, { recursive: true });
  vi.stubEnv("MEMMY_HOME", join(isolatedUser.home, ".memmy"));
  vi.stubEnv("MEMMY_CONFIG", join(isolatedUser.home, ".memmy", "config.yaml"));
  vi.stubEnv("MEMMY_MEMORY_HOME", join(isolatedUser.home, ".memmy", "memory-service"));
  vi.stubEnv("MEMMY_APP_DATABASE", join(isolatedUser.home, ".memmy", "app.sqlite"));
});
afterAll(() => rmSync(isolatedUser.home, { recursive: true, force: true }));

const memoryFixture = createMemoryServiceFixture();
const connectionExecutors: ReturnType<typeof createAgentSourceExecutor>[] = [];
let db: DatabaseSync | undefined;
let tempDir: string | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  for (const executor of connectionExecutors.splice(0)) await executor.dispose();
  await memoryFixture.cleanup();
  vi.unstubAllEnvs();
  db?.close();
  db = undefined;
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("agent source service", () => {
  it.each([
    new MemoryLayerError("memory_scan_upgrade_required", 503, "Update Memory"),
    new MemoryLayerNetworkError()
  ])("keeps builtin discovery and managed sources when scan metadata is unavailable", async (error) => {
    const repository = createRepository();
    repository.upsertSource({ sourceId: "manual-1", displayName: "Manual", dataPath: "/tmp/manual", builtin: false });
    const memoryClient = createMockMemoryClient();
    memoryClient.agentSources = { list: async () => { throw error; } } as NonNullable<MemoryClient["agentSources"]>;
    const service = createService({ repository, adapters: [createFakeAdapter("cursor")], memoryClient });
    const sources = await service.list();
    expect(sources.map((source) => source.sourceId)).toEqual(["cursor", "manual-1"]);
    expect(sources[0]).toMatchObject({ available: true, messageCount: 0 });
  });

  it("does not hide an unexpected scanner metadata error", async () => {
    const memoryClient = createMockMemoryClient();
    memoryClient.agentSources = { list: async () => { throw new Error("invalid response schema"); } } as NonNullable<MemoryClient["agentSources"]>;
    await expect(createService({ memoryClient }).list()).rejects.toThrow("invalid response schema");
  });
  it("lists builtin registry sources together with persisted manual sources", async () => {
    const repository = createRepository();
    repository.upsertSource({
      sourceId: "manual-1",
      displayName: "Manual Agent",
      dataPath: "/tmp/manual",
      builtin: false
    });
    const service = createService({
      repository,
      adapters: [createFakeAdapter("cursor")]
    });

    await expect(service.list()).resolves.toEqual([
      expect.objectContaining({
        sourceId: "cursor",
        displayName: "Cursor",
        builtin: true,
        available: true,
        status: "not_connected"
      }),
      expect.objectContaining({
        sourceId: "manual-1",
        displayName: "Manual Agent",
        builtin: false
      })
    ]);
  });

  it("uses current builtin metadata instead of persisted display metadata", async () => {
    const repository = createRepository();
    repository.upsertSource({
      sourceId: "cursor",
      displayName: "Legacy Cursor Name",
      dataPath: "/tmp/legacy-cursor",
      builtin: true
    });
    const service = createService({
      repository,
      adapters: [createFakeAdapter("cursor")]
    });

    await expect(service.list()).resolves.toEqual([
      expect.objectContaining({
        sourceId: "cursor",
        displayName: "Cursor",
        dataPath: "/tmp/cursor",
        builtin: true
      })
    ]);
  });

  it("marks unavailable builtin sources without removing them from the list", async () => {
    const service = createService({
      adapters: [createFakeAdapter("claude_code", [], undefined, false)]
    });

    await expect(service.list()).resolves.toEqual([
      expect.objectContaining({
        sourceId: "claude_code",
        available: false,
        status: "not_connected"
      })
    ]);
  });

  it("rejects plugin install before touching the target when the source is unavailable", async () => {
    const calls: string[] = [];
    const service = createService({
      adapters: [createFakeAdapter("claude_code", [], undefined, false)],
      skillDistributionService: {
        async install() {
          calls.push("install");
        },
        async uninstall() {
          calls.push("uninstall");
        },
        async installPlugin() {
          calls.push("installPlugin");
        },
        async uninstallPlugin() {
          calls.push("uninstallPlugin");
        }
      }
    });

    await expect(service.installPlugin("claude_code")).rejects.toMatchObject({
      code: "agent_source_unavailable"
    });
    expect(calls).toEqual([]);
  });

  it("adds and removes manual sources", async () => {
    const service = createService();

    const added = await service.addManual({
      displayName: "Manual Agent"
    });
    await service.remove(added.sourceId);

    expect(added).toMatchObject({
      displayName: "Manual Agent",
      dataPath: MANAGED_AGENT_DISCOVERY_PENDING_DATA_PATH,
      builtin: false
    });
    await expect(service.list()).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ sourceId: added.sourceId })])
    );
  });

  it("imports AI-normalized history and records the 500th-turn sync boundary", async () => {
    const repository = createRepository();
    const ingested: ConversationMessage[] = [];
    let memorySource: string | undefined;
    const service = createService({
      repository,
      ingestionService: {
        async ingest(messages, context) {
          memorySource = context.memorySource;
          for await (const message of messages) {
            ingested.push(message);
          }
          return {
            attempted: ingested.length,
            written: ingested.length,
            deduped: 0,
            failed: 0,
            writtenMemories: 1,
            dedupedMemories: 0,
            failedMemories: 0,
            memoryIds: [],
            importSummaryMemoryIds: [],
            conversations: 1,
            completedConversationIds: ["conversation-1"],
            incompleteConversationIds: [],
            failedConversationIds: [],
            errors: []
          };
        }
      }
    });
    const source = await service.addManual({ displayName: "Aider" });

    const result = await service.importManaged(source.sourceId, {
      mode: "initial_subset",
      dataPath: "/Users/test/.aider/history.jsonl",
      syncBoundaryAt: "2026-07-01T10:00:00.000Z",
      final: true,
      messages: [
        {
          messageId: "user-1",
          conversationId: "conversation-1",
          role: "user",
          content: "question",
          createdAt: "2026-07-01T10:00:00.000Z"
        },
        {
          messageId: "assistant-1",
          conversationId: "conversation-1",
          role: "assistant",
          content: "answer",
          createdAt: "2026-07-01T10:00:01.000Z"
        }
      ]
    });

    expect(ingested.map((message) => message.sourceId)).toEqual([source.sourceId, source.sourceId]);
    expect(memorySource).toBe("Aider");
    expect(result).toMatchObject({
      sourceId: source.sourceId,
      attempted: 2,
      written: 2,
      syncBoundaryAt: "2026-07-01T10:00:00.000Z",
      errors: []
    });
    await expect(service.list()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceId: source.sourceId,
        dataPath: "/Users/test/.aider/history.jsonl",
        lastScannedAt: "2026-05-28T10:00:00.000Z",
        syncBoundaryAt: "2026-07-01T10:00:00.000Z"
      })
    ]));
  });

  it("waits for managed import processing without bypassing the shared scheduler", async () => {
    const base = createReadyMemoryClient();
    const runWorker = vi.fn(base.runWorker);
    const enqueueImportSummaries = vi.fn(base.enqueueImportSummaries);
    let polls = 0;
    const getMemoryProcessingStatus = vi.fn(async (ids: string[]) => {
      const result = await base.getMemoryProcessingStatus(ids);
      return ++polls === 1
        ? { ...result, items: result.items.map(item => ({ ...item, state: "summary_pending" as const })) }
        : result;
    });
    const memoryIds = ["managed-memory"];
    const service = createService({
      memoryClient: { ...base, runWorker, enqueueImportSummaries, getMemoryProcessingStatus },
      ingestionService: ingestionWithMemoryIds(memoryIds)
    });
    const source = await service.addManual({ displayName: "Managed queue regression" });
    await expect(service.importManaged(source.sourceId, { mode: "full", messages: [] }))
      .resolves.toMatchObject({ memoryIds });
    expect(enqueueImportSummaries).toHaveBeenCalledExactlyOnceWith(memoryIds);
    expect(getMemoryProcessingStatus).toHaveBeenCalledTimes(2);
    expect(runWorker).not.toHaveBeenCalled();
  });

  it("keeps managed imports bounded and deduplicated without targeted worker drains", async () => {
    const base = createReadyMemoryClient();
    const runWorker = vi.fn(base.runWorker);
    const enqueueImportSummaries = vi.fn(base.enqueueImportSummaries);
    const getMemoryProcessingStatus = vi.fn(base.getMemoryProcessingStatus);
    const memoryIds = Array.from({ length: 205 }, (_, index) => `managed-${index}`);
    const service = createService({
      memoryClient: { ...base, runWorker, enqueueImportSummaries, getMemoryProcessingStatus },
      ingestionService: ingestionWithMemoryIds([...memoryIds, memoryIds[0]!])
    });
    const source = await service.addManual({ displayName: "Managed cohort regression" });
    await service.importManaged(source.sourceId, { mode: "full", messages: [] });
    const batches = enqueueImportSummaries.mock.calls.map(([ids]) => ids!);
    expect(batches.map(ids => ids.length)).toEqual([100, 100, 5]);
    expect(batches.flat()).toEqual(memoryIds);
    expect(getMemoryProcessingStatus.mock.calls.map(([ids]) => ids)).toEqual(batches);
    expect(runWorker).not.toHaveBeenCalled();
  });

  it("reports a stalled managed processing queue without issuing a worker call", async () => {
    const base = createReadyMemoryClient();
    const runWorker = vi.fn(base.runWorker);
    let clock = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const service = createService({
      memoryClient: { ...base, runWorker,
        async getMemoryProcessingStatus(ids) {
          clock += 2_400_000;
          const result = await base.getMemoryProcessingStatus(ids);
          return { ...result, items: result.items.map(item => ({ ...item, state: "embedding_pending" as const })) };
        }
      },
      ingestionService: ingestionWithMemoryIds(["managed-stalled"])
    });
    const source = await service.addManual({ displayName: "Managed timeout regression" });
    await expect(service.importManaged(source.sourceId, { mode: "full", messages: [] }))
      .rejects.toThrow("Timed out waiting for 1 imported memories to finish indexing");
    expect(runWorker).not.toHaveBeenCalled();
  });

  it("persists the AI-discovered recipe and later syncs without another Agent session", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-managed-sync-"));
    const historyPath = join(tempDir, "history.jsonl");
    writeFileSync(historyPath, [
      JSON.stringify({ id: "u1", conversation: "c1", role: "user", content: "old", createdAt: "2026-07-01T10:00:00.000Z" }),
      JSON.stringify({ id: "a1", conversation: "c1", role: "assistant", content: "old answer", createdAt: "2026-07-01T10:00:01.000Z" }),
      JSON.stringify({ id: "u2", conversation: "c1", role: "user", content: "new", createdAt: "2026-07-02T10:00:00.000Z" }),
      JSON.stringify({ id: "a2", conversation: "c1", role: "assistant", content: "new answer", createdAt: "2026-07-02T10:00:01.000Z" })
    ].join("\n"), "utf8");
    const repository = createRepository();
    const ingestionCalls: ConversationMessage[][] = [];
    const service = createService({
      repository,
      ingestionService: {
        async ingest(messages) {
          const ingested: ConversationMessage[] = [];
          for await (const message of messages) ingested.push(message);
          ingestionCalls.push(ingested);
          return {
            attempted: ingested.length,
            written: ingested.length,
            deduped: 0,
            failed: 0,
            writtenMemories: ingested.length > 0 ? 1 : 0,
            dedupedMemories: 0,
            failedMemories: 0,
            memoryIds: [],
            importSummaryMemoryIds: [],
            conversations: ingested.length > 0 ? 1 : 0,
            completedConversationIds: ingested.length > 0 ? ["c1"] : [],
            incompleteConversationIds: [],
            failedConversationIds: [],
            errors: []
          };
        }
      }
    });
    const source = await service.addManual({ displayName: "Example Agent" });
    await service.importManaged(source.sourceId, {
      mode: "initial_subset",
      messages: [
        {
          messageId: "u1",
          conversationId: "c1",
          role: "user",
          content: "old",
          createdAt: "2026-07-01T10:00:00.000Z"
        },
        {
          messageId: "a1",
          conversationId: "c1",
          role: "assistant",
          content: "old answer",
          createdAt: "2026-07-01T10:00:01.000Z"
        }
      ],
      syncBoundaryAt: "2026-07-01T10:00:00.000Z",
      final: true
    });
    const updated = await service.updateManaged(source.sourceId, {
      dataPath: historyPath,
      syncRecipe: {
        version: 1,
        format: "jsonl",
        path: historyPath,
        fields: {
          messageId: "id",
          conversationId: "conversation",
          role: "role",
          content: "content",
          createdAt: "createdAt"
        },
        timestampFormat: "auto"
      }
    });

    const result = await service.syncManaged(source.sourceId);

    expect(updated.syncReady).toBe(true);
    expect(ingestionCalls.at(-1)?.map((message) => message.messageId)).toEqual(["u2", "a2"]);
    expect(result).toMatchObject({
      attempted: 2,
      written: 2,
      syncBoundaryAt: "2026-07-01T10:00:00.000Z"
    });
  });

  it("updates Skill state only for AI-managed sources", async () => {
    const repository = createRepository();
    repository.upsertSource({
      sourceId: "cursor",
      displayName: "Cursor",
      dataPath: "/tmp/cursor",
      builtin: true
    });
    const service = createService({ repository });
    const source = await service.addManual({ displayName: "Aider" });

    await expect(service.updateManaged(source.sourceId, {
      dataPath: "/Users/test/.aider",
      skillInstalled: true
    })).resolves.toMatchObject({
      sourceId: source.sourceId,
      dataPath: "/Users/test/.aider",
      status: "skill_installed"
    });
    await expect(service.updateManaged("cursor", { skillInstalled: true })).rejects.toThrow(
      "not managed by Memmy Agent"
    );
  });

  it("stops sharing an Agent's skills as soon as its connection is removed", async () => {
    const repository = createRepository();
    repository.upsertSource({ sourceId: "cursor", displayName: "Cursor", dataPath: "/tmp/cursor", builtin: true });
    const reconciled: Parameters<MemoryClient["reconcileAgentSkills"]>[0][] = [];
    const memoryClient = createMockMemoryClient();
    const service = createService({
      repository,
      memoryClient: {
        ...memoryClient,
        async reconcileAgentSkills(input, context) {
          reconciled.push(input);
          return memoryClient.reconcileAgentSkills(input, context);
        }
      },
      skillDistributionService: {
        async install() {},
        async uninstall() {},
        async installPlugin() {},
        async uninstallPlugin() {}
      }
    });

    await service.uninstallSkill("cursor");

    expect(reconciled).toEqual([{ sourceAgentId: "cursor", complete: false, disconnected: true, connectionState: "disconnected", connectionKind: "skill", skills: [] }]);
  });

  it.each(["skill", "plugin"] as const)("notifies Memory of explicit %s connections but excludes auto injection", async (kind) => {
    const memoryClient = createMockMemoryClient();
    memoryClient.agentSources = { connectionState: async () => ({ connectionState: null }) } as NonNullable<MemoryClient["agentSources"]>;
    const reconcileAgentSkills = vi.spyOn(memoryClient, "reconcileAgentSkills");
    const service = createService({ memoryClient });
    if (kind === "skill") await service.installSkill("cursor", { installType: "auto_inject" });
    else await service.installPlugin("cursor", { installType: "auto_inject" });
    expect(reconcileAgentSkills).not.toHaveBeenCalled();
    if (kind === "skill") await service.installSkill("cursor");
    else await service.installPlugin("cursor");
    expect(reconcileAgentSkills).toHaveBeenLastCalledWith({ sourceAgentId: "cursor", complete: false,
      connectionState: "connected", connectionKind: kind, disconnected: false, skills: [] });
  });

  it.each(["installSkill", "uninstallSkill", "installPlugin", "uninstallPlugin"] as const)("reports a failed %s notification and retries it on the next explicit action", async (action) => {
    const memoryClient = createMockMemoryClient();
    const reconcile = vi.spyOn(memoryClient, "reconcileAgentSkills").mockRejectedValueOnce(new MemoryLayerNetworkError());
    const service = createService({ memoryClient });
    await expect(service[action]("cursor")).rejects.toBeInstanceOf(MemoryLayerNetworkError);
    await expect(service[action]("cursor")).resolves.toBeUndefined();
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(reconcile).toHaveBeenLastCalledWith(expect.objectContaining({
      connectionState: action.startsWith("uninstall") ? "disconnected" : "connected"
    }));
  });

  it("delegates skill install and uninstall then updates source status", async () => {
    const repository = createRepository();
    repository.upsertSource({
      sourceId: "cursor",
      displayName: "Cursor",
      dataPath: "/tmp/cursor",
      builtin: true
    });
    const calls: string[] = [];
    const service = createService({
      repository,
      skillDistributionService: {
        async install(sourceId) {
          calls.push(`install:${sourceId}`);
        },
        async uninstall(sourceId) {
          calls.push(`uninstall:${sourceId}`);
        },
        async installPlugin() {
          return undefined;
        },
        async uninstallPlugin() {
          return undefined;
        }
      }
    });

    await service.installSkill("cursor");
    expect(repository.isAutoInjectSuppressed("cursor")).toBe(false);
    await service.uninstallSkill("cursor");

    expect(calls).toEqual(["install:cursor", "uninstall:cursor"]);
    expect(repository.listSources()[0]?.status).toBe("not_connected");
    expect(repository.isAutoInjectSuppressed("cursor")).toBe(true);
  });

  it("delegates native plugin install then updates source status", async () => {
    const repository = createRepository();
    repository.upsertSource({
      sourceId: "openclaw",
      displayName: "OpenClaw",
      dataPath: "/tmp/openclaw",
      builtin: true
    });
    const calls: string[] = [];
    const service = createService({
      repository,
      adapters: [createFakeAdapter("openclaw")],
      skillDistributionService: {
        async install(sourceId) {
          calls.push(`install:${sourceId}`);
        },
        async uninstall(sourceId) {
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

    await service.installPlugin("openclaw");
    expect(repository.isAutoInjectSuppressed("openclaw")).toBe(false);
    await service.uninstallPlugin("openclaw");

    expect(calls).toEqual(["plugin:openclaw", "unplugin:openclaw"]);
    expect(repository.listSources()[0]?.status).toBe("not_connected");
    expect(repository.isAutoInjectSuppressed("openclaw")).toBe(true);
  });

  it("delegates memory plugin conflict detection to the skill distribution service", async () => {
    const service = createService({
      skillDistributionService: {
        async install() {
          return undefined;
        },
        async uninstall() {
          return undefined;
        },
        async installPlugin() {
          return undefined;
        },
        async uninstallPlugin() {
          return undefined;
        },
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

    await expect(service.detectMemoryPluginConflicts()).resolves.toEqual([
      {
        sourceId: "openclaw",
        displayName: "OpenClaw",
        configPath: "/tmp/openclaw/openclaw.json",
        installedPluginId: "memory-core"
      }
    ]);
  });

  it("emits agent source lifecycle and conflict analytics", async () => {
    const repository = createRepository();
    repository.upsertSource({
      sourceId: "cursor",
      displayName: "Cursor",
      dataPath: "/tmp/cursor",
      builtin: true
    });
    const analytics = createAgentSourceAnalyticsRecorder();
    const service = createService({
      repository,
      adapters: [createFakeAdapter("cursor")],
      agentSourceAnalytics: analytics.recorder,
      getScanPermission: async () => "scan_and_write_skill",
      skillDistributionService: {
        async install() {
          return undefined;
        },
        async uninstall() {
          return undefined;
        },
        async installPlugin() {
          return undefined;
        },
        async uninstallPlugin() {
          return undefined;
        },
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

    await service.installPlugin("cursor", { installType: "manual" });
    await service.uninstallPlugin("cursor", { installType: "manual" });
    await service.detectMemoryPluginConflicts();

    expect(analytics.events.map((event) => event.eventName)).toEqual([
      AGENT_SOURCE_ANALYTICS_EVENTS.pluginInstalled,
      AGENT_SOURCE_ANALYTICS_EVENTS.pluginUninstalled,
      AGENT_SOURCE_ANALYTICS_EVENTS.pluginConflictDetected,
    ]);
    expect(analytics.events[0]?.params).toMatchObject({
      source_id: "cursor",
      source_kind: "hook",
      permission: "scan_and_write_skill",
      status_before: "not_connected",
      status_after: "plugin_installed",
      install_type: "manual",
      success: 1,
    });
    expect(analytics.events[1]?.params).toMatchObject({
      source_id: "cursor",
      status_after: "not_connected",
      success: 1,
    });
    expect(analytics.events[2]?.params).toMatchObject({
      source_id: "openclaw",
      source_kind: "native_plugin",
      permission: "scan_and_write_skill",
      installed_plugin_id: "memory-core",
    });
  });

  it("reports whether an installed hook matches the bundled revision", async () => {
    const fallback = createService();
    const service = createService({
      skillDistributionService: {
        async install() {
          return undefined;
        },
        async uninstall() {
          return undefined;
        },
        async installPlugin() {
          return undefined;
        },
        async uninstallPlugin() {
          return undefined;
        },
        async isInstalledHookCurrent(sourceId) {
          return sourceId !== "cursor";
        }
      }
    });

    await expect(fallback.isInstalledHookCurrent("cursor")).resolves.toBe(true);
    await expect(service.isInstalledHookCurrent("cursor")).resolves.toBe(false);
    await expect(service.isInstalledHookCurrent("claude_code")).resolves.toBe(true);
  });

  it("emits skill install analytics", async () => {
    const repository = createRepository();
    repository.upsertSource({
      sourceId: "workbuddy",
      displayName: "WorkBuddy",
      dataPath: "/tmp/workbuddy",
      builtin: true,
      status: "not_connected",
    });
    const analytics = createAgentSourceAnalyticsRecorder();
    const service = createService({
      repository,
      adapters: [createFakeAdapter("workbuddy")],
      agentSourceAnalytics: analytics.recorder,
      getScanPermission: async () => "scan_only",
      skillDistributionService: {
        async install() {
          return undefined;
        },
        async uninstall() {
          return undefined;
        },
        async installPlugin() {
          return undefined;
        },
        async uninstallPlugin() {
          return undefined;
        },
      },
    });

    await service.installSkill("workbuddy");

    expect(analytics.events).toHaveLength(1);
    expect(analytics.events[0]).toMatchObject({
      eventName: AGENT_SOURCE_ANALYTICS_EVENTS.skillInstalled,
      params: {
        source_id: "workbuddy",
        source_kind: "skill",
        permission: "scan_only",
        status_before: "not_connected",
        status_after: "skill_installed",
        success: 1,
      },
    });
  });

  it("emits failed plugin install analytics before rethrowing", async () => {
    const repository = createRepository();
    repository.upsertSource({
      sourceId: "cursor",
      displayName: "Cursor",
      dataPath: "/tmp/cursor",
      builtin: true
    });
    const analytics = createAgentSourceAnalyticsRecorder();
    const service = createService({
      memoryClient: { ...createMockMemoryClient(), agentSources: { connectionState: async () => ({ connectionState: null }) } as NonNullable<MemoryClient["agentSources"]> },
      repository,
      adapters: [createFakeAdapter("cursor")],
      agentSourceAnalytics: analytics.recorder,
      getScanPermission: async () => "scan_and_write_skill",
      skillDistributionService: {
        async install() {
          return undefined;
        },
        async uninstall() {
          return undefined;
        },
        async installPlugin() {
          throw new Error("install failed");
        },
        async uninstallPlugin() {
          return undefined;
        }
      }
    });

    await expect(service.installPlugin("cursor", { installType: "auto_inject" })).rejects.toThrow("install failed");
    expect(analytics.events).toHaveLength(1);
    expect(analytics.events[0]).toMatchObject({
      eventName: AGENT_SOURCE_ANALYTICS_EVENTS.pluginInstalled,
      params: {
        source_id: "cursor",
        source_kind: "hook",
        permission: "scan_and_write_skill",
        status_before: "not_connected",
        status_after: "not_connected",
        install_type: "auto_inject",
        success: 0,
        error_code: "install failed",
      },
    });
  });
});

function createService(
  options: {
    repository?: AgentSourceRepository;
    adapters?: readonly SourceAdapter[];
    ingestionService?: IngestionService;
    skillDistributionService?: SkillDistributionService;
    memoryClient?: MemoryClient;
    agentSourceAnalytics?: AgentSourceLifecycleAnalytics;
    memoryAddAnalytics?: {
      trackAddStarted: (input: Record<string, unknown>) => void;
      trackAddSucceeded: (input: Record<string, unknown>) => void;
      trackAddFailed: (input: Record<string, unknown>) => void;
    };
    scanStoreDirectory?: string;
    getScanPermission?: () => Promise<import("@memmy/local-api-contracts").ScanPermission>;
  } = {}
): AgentSourceService {
  return createAgentSourceService({
    sourceRegistry: createSourceRegistry(options.adapters ?? [createFakeAdapter("cursor")]),
    agentSourceRepository: options.repository ?? createRepository(),
    ingestionService: options.ingestionService ?? createFakeIngestionService(),
    memoryClient: options.memoryClient ?? createMockMemoryClient(),
    agentSourceAnalytics: options.agentSourceAnalytics,
    memoryAddAnalytics: options.memoryAddAnalytics as never,
    scanStoreDirectory: options.scanStoreDirectory,
    getScanPermission: options.getScanPermission,
    skillDistributionService:
      options.skillDistributionService ??
      ({
        async install() {
          return undefined;
        },
        async uninstall() {
          return undefined;
        },
        async installPlugin() {
          return undefined;
        },
        async uninstallPlugin() {
          return undefined;
        }
      } satisfies SkillDistributionService),
    now: () => "2026-05-28T10:00:00.000Z",
    createId: () => "manual-id-1"
  });
}

function createRepository(path = ":memory:"): AgentSourceRepository {
  db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE cloud_accounts (
      uuid TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE account_agent_sources (
      uuid            TEXT NOT NULL REFERENCES cloud_accounts(uuid) ON DELETE CASCADE,
      source_id       TEXT NOT NULL,
      display_name    TEXT NOT NULL,
      data_path       TEXT NOT NULL,
      builtin         INTEGER NOT NULL CHECK(builtin IN (0,1)),
      status          TEXT NOT NULL DEFAULT 'not_connected',
      auto_inject_suppressed INTEGER NOT NULL DEFAULT 0 CHECK(auto_inject_suppressed IN (0,1)),
      last_scanned_at TEXT,
      sync_recipe_json TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (uuid, source_id)
    );
    CREATE TABLE account_ingestion_seen (
      uuid       TEXT NOT NULL REFERENCES cloud_accounts(uuid) ON DELETE CASCADE,
      dedup_key  TEXT NOT NULL,
      source_id  TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (uuid, dedup_key),
      FOREIGN KEY (uuid, source_id) REFERENCES account_agent_sources(uuid, source_id) ON DELETE CASCADE
    );
    CREATE TABLE account_agent_source_watermarks (
      uuid                   TEXT NOT NULL REFERENCES cloud_accounts(uuid) ON DELETE CASCADE,
      source_id              TEXT NOT NULL,
      mode                   TEXT NOT NULL CHECK(mode IN ('initial_subset','incremental','full')),
      baseline_at            TEXT,
      latest_seen_created_at TEXT,
      created_at             TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (uuid, source_id),
      FOREIGN KEY (uuid, source_id) REFERENCES account_agent_sources(uuid, source_id) ON DELETE CASCADE
    );
    CREATE TABLE account_agent_source_conversation_checkpoints (
      uuid            TEXT NOT NULL REFERENCES cloud_accounts(uuid) ON DELETE CASCADE,
      source_id       TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      last_message_id TEXT NOT NULL,
      last_created_at TEXT NOT NULL,
      content_hash    TEXT NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (uuid, source_id, conversation_id),
      FOREIGN KEY (uuid, source_id) REFERENCES account_agent_sources(uuid, source_id) ON DELETE CASCADE
    );
    INSERT INTO cloud_accounts (uuid) VALUES ('cloud-account-a');
  `);

  return createAgentSourceRepository(db);
}

function createFakeAdapter(
  sourceId: string,
  messages: readonly ConversationMessage[] = [createMessage(sourceId, 1)],
  scanImpl?: (options: ScanOptions) => AsyncIterable<ConversationMessage>,
  available = true
): SourceAdapter {
  const descriptor: SourceDescriptor = {
    sourceId,
    displayName: sourceId === "cursor" ? "Cursor" : "Custom",
    builtin: sourceId === "cursor",
    dataPath: `/tmp/${sourceId}`
  };

  return {
    descriptor,
    async detect() {
      return available;
    },
    scan(options) {
      return scanImpl ? scanImpl(options) : toAsyncIterable(messages);
    }
  };
}

function createAddAnalyticsRecorder(events: Array<{ name: string; payload: Record<string, unknown> }>) {
  return {
    trackAddStarted(input: Record<string, unknown>) {
      events.push({ name: "started", payload: { ...input } });
    },
    trackAddSucceeded(input: Record<string, unknown>) {
      events.push({ name: "succeeded", payload: { ...input } });
    },
    trackAddFailed(input: Record<string, unknown>) {
      events.push({ name: "failed", payload: { ...input } });
    }
  };
}

function createReadyMemoryClient(): MemoryClient {
  const base = createMockMemoryClient();
  return {
    ...base,
    async enqueueImportSummaries(memoryIds) {
      return {
        enqueued: memoryIds?.length ?? 0,
        memoryIds: memoryIds ?? [],
        serverTime: "2026-05-28T10:00:00.000Z"
      };
    },
    async getMemoryProcessingStatus(memoryIds) {
      return {
        items: memoryIds.map((memoryId) => ({
          memoryId,
          state: "ready" as const,
          stage: null,
          activeJobId: null,
          attemptCount: 1,
          manualRetryCount: 0,
          retryAction: "retry" as const,
          errorCode: null,
          errorMessage: null,
          failedAt: null,
          updatedAt: "2026-05-28T10:00:00.000Z"
        })),
        serverTime: "2026-05-28T10:00:00.000Z"
      };
    }
  };
}

function ingestionWithMemoryIds(memoryIds: string[]): IngestionService {
  const base = createFakeIngestionService();
  return { async ingest(messages, context) {
    return { ...await base.ingest(messages, context), memoryIds };
  } };
}

function createFakeIngestionService(): IngestionService {
  return {
    async ingest(messages) {
      let attempted = 0;
      const conversationIds = new Set<string>();
      for await (const message of messages) {
        attempted += 1;
        conversationIds.add(message.conversationId);
      }

      return {
        attempted,
        written: attempted,
        deduped: 0,
        failed: 0,
        writtenMemories: attempted,
        dedupedMemories: 0,
        failedMemories: 0,
        memoryIds: [],
        importSummaryMemoryIds: [],
        conversations: 1,
        completedConversationIds: [...conversationIds],
        incompleteConversationIds: [],
        failedConversationIds: [],
        errors: []
      };
    }
  };
}

async function* toAsyncIterable(messages: readonly ConversationMessage[]): AsyncIterable<ConversationMessage> {
  for (const message of messages) {
    yield message;
  }
}

function createMessage(sourceId: string, index: number): ConversationMessage {
  return {
    messageId: `${sourceId}-msg-${index}`,
    sourceId,
    conversationId: `${sourceId}-conv-1`,
    role: "user",
    content: `message ${index}`,
    createdAt: "2026-05-28T10:00:00.000Z",
    workspacePath: null,
    gitRoot: null,
    rawMeta: Object.freeze({})
  };
}

function stagedNativeMessages(sourceId: string): ConversationMessage[] {
  const sourceTurn = {
    source: sourceId,
    conversationId: `${sourceId}-conv-1`,
    turnId: "native-turn",
    sequence: 1,
    startedAt: "2026-05-28T10:00:00.000Z",
    completedAt: "2026-05-28T10:01:00.000Z",
    completionEvidence: "task_complete:native-turn",
    query: "Run tests",
    answer: "Tests passed",
    status: "succeeded",
    toolCalls: [],
    toolResults: []
  };
  return [
    {
      ...createMessage(sourceId, 1),
      role: "user",
      content: sourceTurn.query,
      createdAt: sourceTurn.startedAt,
      rawMeta: { sourceTurnId: "native-turn", sourceTurnState: "complete" }
    },
    {
      ...createMessage(sourceId, 2),
      role: "assistant",
      content: sourceTurn.answer,
      createdAt: sourceTurn.completedAt,
      rawMeta: { sourceTurnId: "native-turn", sourceTurnState: "complete", sourceTurn }
    }
  ];
}

function createCompleteMemoryMessages(
  sourceId: string,
  count: number,
  newestAt: string,
  options: { includeTool?: boolean } = {}
): ConversationMessage[] {
  const newest = Date.parse(newestAt);
  return Array.from({ length: count }, (_, index) => {
    const turnNumber = index + 1;
    const userAt = newest - index * 10_000;
    const conversationId = `${sourceId}-conv-${turnNumber}`;
    const user: ConversationMessage = {
      ...createMessage(sourceId, turnNumber),
      messageId: `${sourceId}-turn-${turnNumber}-user`,
      conversationId,
      role: "user",
      content: `query ${turnNumber}`,
      createdAt: new Date(userAt).toISOString()
    };
    const tool: ConversationMessage = {
      ...createMessage(sourceId, turnNumber),
      messageId: `${sourceId}-turn-${turnNumber}-tool`,
      conversationId,
      role: "tool",
      content: `tool ${turnNumber}`,
      createdAt: new Date(userAt + 1_000).toISOString()
    };
    const assistant: ConversationMessage = {
      ...createMessage(sourceId, turnNumber),
      messageId: `${sourceId}-turn-${turnNumber}-assistant`,
      conversationId,
      role: "assistant",
      content: `answer ${turnNumber}`,
      createdAt: new Date(userAt + 2_000).toISOString()
    };

    return options.includeTool ? [user, tool, assistant] : [user, assistant];
  }).flat();
}

function createIncompleteUserMessages(sourceId: string, count: number, newestAt: string): ConversationMessage[] {
  const newest = Date.parse(newestAt);
  return Array.from({ length: count }, (_, index) => {
    const turnNumber = index + 1;
    return {
      ...createMessage(sourceId, turnNumber),
      messageId: `${sourceId}-incomplete-${turnNumber}-user`,
      conversationId: `${sourceId}-incomplete-conv-${turnNumber}`,
      role: "user",
      content: `incomplete query ${turnNumber}`,
      createdAt: new Date(newest - index * 10_000).toISOString()
    };
  });
}

function expectMemoryCount(messages: readonly ConversationMessage[] | undefined, expected: number): void {
  expect(messages?.filter((message) => message.role === "user")).toHaveLength(expected);
}

function createAgentSourceAnalyticsRecorder(): {
  recorder: AgentSourceLifecycleAnalytics;
  events: Array<{ eventName: string; params: Record<string, unknown> }>;
} {
  const events: Array<{ eventName: string; params: Record<string, unknown> }> = [];
  return {
    events,
    recorder: {
      trackPluginInstalled(input) {
        events.push({
          eventName: AGENT_SOURCE_ANALYTICS_EVENTS.pluginInstalled,
          params: buildAgentSourcePluginLifecycleParams(input),
        });
      },
      trackPluginUninstalled(input) {
        events.push({
          eventName: AGENT_SOURCE_ANALYTICS_EVENTS.pluginUninstalled,
          params: buildAgentSourcePluginLifecycleParams(input),
        });
      },
      trackSkillInstalled(input) {
        events.push({
          eventName: AGENT_SOURCE_ANALYTICS_EVENTS.skillInstalled,
          params: buildAgentSourceSkillLifecycleParams(input),
        });
      },
      trackSkillUninstalled(input) {
        events.push({
          eventName: AGENT_SOURCE_ANALYTICS_EVENTS.skillUninstalled,
          params: buildAgentSourceSkillLifecycleParams(input),
        });
      },
      trackPluginConflictDetected(input) {
        events.push({
          eventName: AGENT_SOURCE_ANALYTICS_EVENTS.pluginConflictDetected,
          params: buildAgentSourceConflictParams(input),
        });
      },
      async flush() {
        return undefined;
      },
    },
  };
}


function createConnectionHarness(kind: "skill" | "plugin", legacySource?: "codex" | "claude_code" | "opencode" | "openclaw" | "hermes") {
  const root = memoryFixture.createTestRoot("pr780-app-connection-");
  const sourceId = legacySource ?? (kind === "plugin" ? "codex" : "workbuddy");
  const agentRoot = join(root, `.${sourceId}`);
  const configPath = join(root, "config.yaml");
  mkdirSync(join(agentRoot, "skills", "deploy-helper"), { recursive: true });
  writeFileSync(join(agentRoot, "skills", "deploy-helper", "SKILL.md"), "---\nname: deploy-helper\ndescription: Verify deployment.\n---\nDeployment guide.\n");
  writeFileSync(configPath, JSON.stringify({ memmyMemory: { agentAccess: {
    autoScanKnownAgents: false, autoInjectSkill: false, watchFileChanges: false, scanPermission: "scan_only"
  } } }));
  const inputs: string[] = [];
  const { db: memoryDb, service: memory } = memoryFixture.createTestService({ llm: createFailingLlm(), embedder: createCapturingEmbedder(inputs) });
  const target = sourceId === "workbuddy" ? createWorkbuddySkillTarget({ rootDirectory: agentRoot })
    : sourceId === "hermes" ? createHermesSkillTarget({ rootDirectory: agentRoot, memmyConfigPath: configPath })
    : sourceId === "claude_code" ? createClaudeCodeSkillTarget({ rootDirectory: agentRoot, memmyConfigPath: configPath })
    : sourceId === "opencode" ? createOpencodeSkillTarget({ rootDirectory: agentRoot, memmyConfigPath: configPath })
    : sourceId === "openclaw" ? createOpenclawSkillTarget({ rootDirectory: agentRoot, workspaceDirectory: join(agentRoot, "workspace"), memmyConfigPath: configPath })
    : createCodexSkillTarget({ rootDirectory: agentRoot, memmyConfigPath: configPath, trustHooks: async () => {} });
  const registry = createSkillTargetRegistry([target]);
  const adapter: SourceAdapter = {
    descriptor: { sourceId, displayName: sourceId, builtin: true, dataPath: agentRoot },
    detect: vi.fn(async () => true), async *scan() {}
  };
  const statePath = join(root, "sources.json");
  const executorOptions: Parameters<typeof createAgentSourceExecutor>[0] = {
    service: memory, configPath, statePath, initialScanDelayMs: 0, scheduledScanIntervalMs: 10,
    resolveAgentSkillRoot: () => agentRoot,
    sourceRegistry: createSourceRegistry([adapter]), integrationRegistry: registry
  };
  let executor = createAgentSourceExecutor(executorOptions);
  connectionExecutors.push(executor);
  const restartExecutor = async () => {
    await executor.dispose();
    connectionExecutors.splice(connectionExecutors.indexOf(executor), 1);
    executor = createAgentSourceExecutor(executorOptions);
    connectionExecutors.push(executor);
    return executor;
  };
  const memoryClient = createMockMemoryClient();
  memoryClient.agentSources = { list: () => executor.list(), connectionState: id => executor.connectionState(id) } as NonNullable<MemoryClient["agentSources"]>;
  memoryClient.reconcileAgentSkills = vi.fn(async (request) => memory.reconcileAgentSkills(request));
  let repository = createRepository(join(root, "app.sqlite"));
  const skillDistributionService = createSkillDistributionService({ targetRegistry: registry });
  const appService = (repository: AgentSourceRepository) => createService({ repository, adapters: [adapter], memoryClient, skillDistributionService });
  const service = appService(repository);
  const restartService = () => {
    db!.close();
    db = new DatabaseSync(join(root, "app.sqlite"));
    repository = createAgentSourceRepository(db);
    return appService(repository);
  };
  const connect = () => kind === "plugin" ? service.installPlugin(sourceId) : service.installSkill(sourceId);
  const disconnect = () => kind === "plugin" ? service.uninstallPlugin(sourceId) : service.uninstallSkill(sourceId);
  const status = async () => (await service.list()).find((source) => source.sourceId === sourceId)!.status;
  const scan = async () => {
    await executor.startScan({ sourceId });
    await vi.waitFor(() => expect(executor.scanStatus().running).toBe(false));
    expect(executor.scanStatus().error).toBeNull();
    return memoryDb.db.prepare("SELECT status, memory_value FROM memories WHERE json_extract(properties_json, '$.internal_info.source_skill_id') = 'deploy-helper'").get() as { status: string; memory_value: string };
  };
  return { memory, memoryDb, memoryClient, target, sourceId, connect, disconnect, status, scan, inputs, get repository() { return repository; }, service, agentRoot, restartService, adapter, get executor() { return executor; }, configPath, statePath, restartExecutor };
}

describe("App disconnection keeps failed integration cleanup retryable", () => {
  it("keeps an automatically reinstalled legacy Skill cleanup reachable when the Hook source is unavailable and Memory is offline", async () => {
    const h = createConnectionHarness("skill", "codex");
    await h.connect();
    await h.disconnect();
    // Simulate leftover files written by an older process before the authority guard existed.
    await h.target.install(renderMemmyDefaultSkillManifest(h.sourceId));
    h.repository.setStatus(h.sourceId, "skill_installed");
    expect(h.repository.isAutoInjectSuppressed(h.sourceId)).toBe(true);
    expect(h.memory.agentSkillConnectionState(h.sourceId)).toBe("disconnected");
    vi.mocked(h.adapter.detect).mockResolvedValue(false);
    h.memoryClient.agentSources!.list = vi.fn().mockRejectedValue(new MemoryLayerNetworkError());

    const listed = (await h.service.list()).find(source => source.sourceId === h.sourceId)!;
    expect.soft(listed.status).toBe("plugin_installed");
    expect(listed.available).toBe(false);
    expect.soft(resolveAgentSourceConnectionAction(listed)).toBe("remove_hook");
    await h.service.uninstallPlugin(h.sourceId);
    expect(await h.target.isInstalled(h.sourceId)).toBe(false);
    expect(h.memory.agentSkillConnectionState(h.sourceId)).toBe("disconnected");
  });

  it.each((["skill", "plugin"] as const).flatMap(kind => [false, true].map(notificationFails => ({ kind, notificationFails }))))(
    "attempts $kind disconnection when saving cleanup state fails, notificationFails=$notificationFails", async ({ kind, notificationFails }) => {
      const h = createConnectionHarness(kind);
      await h.connect();
      await h.scan();
      const cleanup = vi.spyOn(h.target, kind === "plugin" ? "uninstallPlugin" : "uninstall");
      const saveError = new Error("fixture cleanup state save failed");
      vi.spyOn(h.repository, "setConnectionState").mockImplementationOnce(() => { throw saveError; });
      const notificationError = new Error("fixture disconnect notification failed");
      if (notificationFails) vi.mocked(h.memoryClient.reconcileAgentSkills).mockRejectedValueOnce(notificationError);

      const failure = await h.disconnect().catch(error => error as Error);
      expect.soft(vi.mocked(h.memoryClient.reconcileAgentSkills)).toHaveBeenLastCalledWith(expect.objectContaining({ connectionState: "disconnected" }));
      expect(cleanup).not.toHaveBeenCalled();
      expect(await h.target.isInstalled(h.sourceId)).toBe(true);
      if (notificationFails) {
        expect.soft(failure).toBeInstanceOf(AggregateError);
        expect((failure as AggregateError).errors).toEqual([saveError, notificationError]);
        expect((failure as Error).message).toContain(saveError.message);
        expect((failure as Error).message).toContain(notificationError.message);
        expect((failure as Error).message).not.toContain("Skill sharing is stopped");
        expect(h.memory.agentSkillConnectionState(h.sourceId)).toBe("connected");
      } else {
        expect.soft((failure as Error).message).toContain("Skill sharing is stopped");
        expect((failure as Error).cause).toBe(saveError);
        expect(h.memory.agentSkillConnectionState(h.sourceId)).toBe("disconnected");
      }
      await h.disconnect();
      expect(await h.status()).toBe("not_connected");
      expect(h.memory.agentSkillConnectionState(h.sourceId)).toBe("disconnected");
      expect(h.inputs).toEqual([]);
    }
  );

  it.each((["skill", "plugin"] as const).flatMap(kind => [false, true].map(partial => ({ kind, partial }))))(
    "keeps $kind sharing stopped after cleanup fails, partial=$partial", async ({ kind, partial }) => {
      const h = createConnectionHarness(kind);
      await h.connect(); await h.scan();
      const remove = kind === "plugin" ? h.target.uninstallPlugin!.bind(h.target) : h.target.uninstall.bind(h.target);
      const cleanup = vi.spyOn(h.target, kind === "plugin" ? "uninstallPlugin" : "uninstall");
      cleanup.mockImplementationOnce(async () => {
        if (partial) await remove(h.sourceId);
        throw new Error("fixture cleanup failure");
      });
      const failure = await h.disconnect().catch(error => error as Error);
      expect(failure).toBeInstanceOf(Error);
      expect.soft((failure as Error).message).toContain("Skill sharing is stopped");
      expect((failure as Error).message).toContain("fixture cleanup failure");
      expect(h.memory.agentSkillConnectionState(h.sourceId)).toBe("disconnected");
      expect.soft(h.repository.isAutoInjectSuppressed(h.sourceId)).toBe(true);
      expect.soft(await h.status()).toBe(kind === "plugin" ? "plugin_installed" : "skill_installed");
      expect((await h.scan()).memory_value).toBe("");

      const install = vi.spyOn(h.target, kind === "plugin" ? "installPlugin" : "install");
      const automatic = createAgentSourceAutoInjectService({
        agentSources: h.service,
        permissionManager: { async canWriteAgentSkill() { return true; } },
        getScanPreferences: () => ({ autoScanKnownAgents: false, autoInjectSkill: true, watchFileChanges: false }),
        isAutoInjectSuppressed: sourceId => h.repository.isAutoInjectSuppressed(sourceId)
      });
      expect((await automatic.runOnce()).installed).toEqual([]);
      expect(install).not.toHaveBeenCalled();
      expect(h.memory.agentSkillConnectionState(h.sourceId)).toBe("disconnected");

      const restarted = h.restartService();
      vi.mocked(h.adapter.detect).mockResolvedValue(false);
      const listed = (await restarted.list()).find(source => source.sourceId === h.sourceId)!;
      expect.soft(listed.status).toBe(kind === "plugin" ? "plugin_installed" : "skill_installed");
      expect(listed.available).toBe(false);
      expect(resolveAgentSourceConnectionAction(listed)).toBe(kind === "plugin" ? "remove_hook" : "remove_skill");
      if (kind === "plugin") await restarted.uninstallPlugin(h.sourceId);
      else await restarted.uninstallSkill(h.sourceId);
      expect((await restarted.list()).find(source => source.sourceId === h.sourceId)?.status).toBe("not_connected");
      expect(h.memory.agentSkillConnectionState(h.sourceId)).toBe("disconnected");
      expect(vi.mocked(h.memoryClient.reconcileAgentSkills).mock.calls.slice(1).every(([request]) => request.connectionState === "disconnected")).toBe(true);

      vi.mocked(h.adapter.detect).mockResolvedValue(true);
      if (kind === "plugin") await restarted.installPlugin(h.sourceId);
      else await restarted.installSkill(h.sourceId);
      expect(h.memory.agentSkillConnectionState(h.sourceId)).toBe("connected");
      expect((await h.scan()).status).toBe("activated");
      expect(h.inputs).toEqual([]);
    }
  );
});

describe("App connection fixture isolation", () => {
  it("isolates shared skills and installation identity under the fixture home", async () => {
    // Fail before starting an executor if this suite loses its filesystem isolation.
    expect(homedir()).toBe(isolatedUser.home);
    expect(process.env.MEMMY_HOME).toBe(join(isolatedUser.home, ".memmy"));
    const sharedPath = join(isolatedUser.home, ".agents", "skills", "isolated-shared", "SKILL.md");
    mkdirSync(join(sharedPath, ".."), { recursive: true });
    writeFileSync(sharedPath, "---\nname: isolated-shared\ndescription: Fixture shared skill.\n---\nFixture-only shared instructions.\n");
    const h = createConnectionHarness("plugin");
    await h.connect();
    await h.scan();
    expect(h.memoryDb.db.prepare("SELECT COUNT(*) AS count FROM memories WHERE json_extract(properties_json, '$.internal_info.source_skill_path') = ?").get(sharedPath)).toMatchObject({ count: 1 });
    expect(existsSync(join(isolatedUser.home, ".memmy", "installation-id"))).toBe(true);
  });
});

describe("App connection failures through the Memory list and scanner", () => {
  it.each(["skill", "plugin"] as const)("keeps the %s removal action reachable until Memory accepts disconnection", async (kind) => {
    const h = createConnectionHarness(kind);
    await h.connect();
    expect((await h.scan()).status).toBe("activated");
    const cleanup = vi.spyOn(h.target, kind === "plugin" ? "uninstallPlugin" : "uninstall");
    const notificationError = new Error("fixture notification failed");
    vi.mocked(h.memoryClient.reconcileAgentSkills).mockRejectedValueOnce(notificationError);
    await expect(h.disconnect()).rejects.toBe(notificationError);
    expect(cleanup).not.toHaveBeenCalled();
    expect(h.repository.isAutoInjectSuppressed(h.sourceId)).toBe(true);
    expect(await h.status()).toBe(kind === "plugin" ? "plugin_installed" : "skill_installed");
    expect(h.repository.listSources()[0]?.status).toBe(kind === "plugin" ? "plugin_installed" : "skill_installed");
    expect(h.memory.agentSkillConnectionState(h.sourceId)).toBe("connected");
    expect((await h.scan()).status).toBe("activated");
    const restarted = h.restartService();
    expect((await restarted.list())[0]?.status).toBe(kind === "plugin" ? "plugin_installed" : "skill_installed");
    if (kind === "plugin") await restarted.uninstallPlugin(h.sourceId);
    else await restarted.uninstallSkill(h.sourceId);
    expect((await restarted.list())[0]?.status).toBe("not_connected");
    expect((await h.scan()).memory_value).toBe("");
    expect(h.inputs).toEqual([]);
  });

  it.each(["skill", "plugin"] as const)("restores a fresh %s connect action after a failed notification", async (kind) => {
    const h = createConnectionHarness(kind);
    h.memory.reconcileAgentSkills({ sourceAgentId: h.sourceId, connectionState: "disconnected", complete: false, skills: [] });
    vi.mocked(h.memoryClient.reconcileAgentSkills).mockRejectedValueOnce(new Error("fixture notification failed"));
    await expect(h.connect()).rejects.toThrow("notification failed");
    expect(await h.status()).toBe("not_connected");
    expect(h.repository.listSources()[0]?.status ?? "not_connected").toBe("not_connected");
    expect((await h.scan()).memory_value).toBe("");
    await h.connect();
    expect(await h.status()).toBe(kind === "plugin" ? "plugin_installed" : "skill_installed");
    expect((await h.scan()).status).toBe("activated");
    expect(h.inputs).toEqual([]);
  });

  it.each(["skill", "plugin"] as const)("preserves an existing %s installation on a failed repeated connect", async (kind) => {
    const h = createConnectionHarness(kind);
    await h.connect();
    vi.mocked(h.memoryClient.reconcileAgentSkills).mockRejectedValueOnce(new Error("fixture notification failed"));
    await expect(h.connect()).rejects.toThrow("notification failed");
    expect(await h.target.isInstalled(h.sourceId)).toBe(true);
    expect(await h.status()).toBe(kind === "plugin" ? "plugin_installed" : "skill_installed");
    expect((await h.scan()).status).toBe("activated");
    await h.connect();
  });

  it("keeps an applied disconnect fail-closed when the response is lost", async () => {
    const h = createConnectionHarness("plugin");
    await h.connect();
    await h.scan();
    vi.mocked(h.memoryClient.reconcileAgentSkills).mockImplementationOnce(async (request) => {
      h.memory.reconcileAgentSkills(request);
      throw new Error("fixture response lost");
    });
    await expect(h.disconnect()).rejects.toThrow("response lost");
    expect(await h.status()).toBe("plugin_installed");
    expect(h.memory.agentSkillConnectionState(h.sourceId)).toBe("disconnected");
    expect((await h.scan()).memory_value).toBe("");
    await h.disconnect();
    expect(await h.status()).toBe("not_connected");
  });
});


describe("fresh connection acknowledgement failures", () => {
  it.each(["skill", "plugin"] as const)("compensates an applied %s connection before removing a fresh installation", async (kind) => {
    const h = createConnectionHarness(kind);
    h.memory.reconcileAgentSkills({ sourceAgentId: h.sourceId, connectionState: "disconnected", complete: false, skills: [] });
    vi.mocked(h.memoryClient.reconcileAgentSkills).mockImplementationOnce(async (request) => {
      h.memory.reconcileAgentSkills(request);
      throw new Error("fixture connect response lost");
    });
    await expect(h.connect()).rejects.toThrow("connect response lost");
    expect(h.memory.agentSkillConnectionState(h.sourceId)).toBe("disconnected");
    expect(await h.status()).toBe("not_connected");
    expect((await h.scan()).memory_value).toBe("");
    await h.connect();
    expect((await h.scan()).status).toBe("activated");
  });

  it.each(["skill", "plugin"] as const)("retains the %s removal action when connection and compensation cannot be confirmed", async (kind) => {
    const h = createConnectionHarness(kind);
    h.memory.reconcileAgentSkills({ sourceAgentId: h.sourceId, connectionState: "disconnected", complete: false, skills: [] });
    vi.mocked(h.memoryClient.reconcileAgentSkills)
      .mockImplementationOnce(async (request) => {
        h.memory.reconcileAgentSkills(request);
        throw new Error("fixture connect response lost");
      })
      .mockRejectedValueOnce(new Error("fixture compensation unavailable"));
    await expect(h.connect()).rejects.toThrow("connection result is uncertain");
    expect(await h.status()).toBe(kind === "plugin" ? "plugin_installed" : "skill_installed");
    expect(await h.target.isInstalled(h.sourceId)).toBe(true);
    expect((await h.scan()).status).toBe("activated");
    await h.disconnect();
    expect(await h.status()).toBe("not_connected");
    expect((await h.scan()).memory_value).toBe("");
  });

  it("restores a pre-existing Skill after a failed upgrade to a Hook", async () => {
    const h = createConnectionHarness("plugin");
    await h.service.installSkill(h.sourceId);
    expect(await h.status()).toBe("plugin_installed");
    vi.mocked(h.memoryClient.reconcileAgentSkills).mockRejectedValueOnce(new Error("fixture notification failed"));
    await expect(h.connect()).rejects.toThrow("notification failed");
    expect(await h.target.isInstalled(h.sourceId)).toBe(true);
    expect(await h.target.isPluginInstalled?.()).toBe(false);
    expect(await h.status()).toBe("plugin_installed");
    expect((await h.scan()).status).toBe("activated");
    await h.connect();
    expect(await h.status()).toBe("plugin_installed");
  });
});


describe("legacy CLI-only connection failure preservation", () => {
  const legacyCases = [
    ["codex", "AGENTS.md"], ["claude_code", "CLAUDE.md"],
    ["opencode", "AGENTS.md"], ["openclaw", "workspace/AGENTS.md"]
  ] as const;
  for (const kind of ["skill", "plugin"] as const) {
    it.each(legacyCases)(`preserves %s legacy CLI instructions when ${kind} connection notification fails`, async (sourceId, instructionsPath) => {
      const h = createConnectionHarness(kind, sourceId);
      const filePath = join(h.agentRoot, instructionsPath);
      mkdirSync(join(filePath, ".."), { recursive: true });
      writeFileSync(filePath, "User instructions.\n<!-- memmy-memory cli : start -->\nExisting Memmy CLI integration.\n<!-- memmy-memory cli : end -->\n");
      expect(await h.target.isInstalled(sourceId)).toBe(false);
      h.memory.reconcileAgentSkills({ sourceAgentId: sourceId, connectionState: "connected", complete: false, skills: [] });
      vi.mocked(h.memoryClient.reconcileAgentSkills).mockRejectedValueOnce(new Error("fixture notification failed"));
      const connect = () => kind === "plugin" ? h.service.installPlugin(sourceId) : h.service.installSkill(sourceId);
      await expect(connect()).rejects.toThrow("notification failed");
      expect(h.memory.agentSkillConnectionState(sourceId)).toBe("connected");
      expect(await h.target.isInstalled(sourceId)).toBe(true);
      expect(await h.status()).toBe("plugin_installed");
      expect(resolveAgentSourceConnectionAction({ sourceId, builtin: true, status: await h.status() })).toBe(sourceId === "codex" || sourceId === "claude_code" ? "remove_hook" : "remove_plugin");
      expect(await h.target.isPluginInstalled?.()).toBe(false);
      expect((await h.scan()).status).toBe("activated");
    });
  }
});


describe("connection list preserves the existing UI removal contract", () => {
  it("keeps a Skill-only Hook source directly removable", async () => {
    const h = createConnectionHarness("plugin");
    await h.service.installSkill(h.sourceId);
    expect(resolveAgentSourceConnectionAction({ sourceId: h.sourceId, builtin: true, status: await h.status() })).toBe("remove_hook");
    await h.disconnect();
    expect((await h.scan()).memory_value).toBe("");
  });

  it.each(["invalid", "unreadable"] as const)("retains a confirmed Skill removal action when plugin state is %s", async (failure) => {
    const h = createConnectionHarness("plugin");
    await h.service.installSkill(h.sourceId);
    const hooksDirectory = join(h.agentRoot, "hooks");
    mkdirSync(hooksDirectory, { recursive: true });
    if (failure === "invalid") writeFileSync(join(h.agentRoot, "hooks.json"), "{");
    else chmodSync(hooksDirectory, 0);
    try {
      const listedStatus = await h.status();
      expect(listedStatus).toBe("plugin_installed");
      expect(resolveAgentSourceConnectionAction({ sourceId: h.sourceId, builtin: true, status: listedStatus })).toBe("remove_hook");
      const callsBefore = vi.mocked(h.memoryClient.reconcileAgentSkills).mock.calls.length;
      await expect(h.connect()).rejects.toThrow();
      expect(vi.mocked(h.memoryClient.reconcileAgentSkills)).toHaveBeenCalledTimes(callsBefore);
    } finally {
      chmodSync(hooksDirectory, 0o700);
      writeFileSync(join(h.agentRoot, "hooks.json"), "{}");
    }
    await h.disconnect();
    expect((await h.scan()).memory_value).toBe("");
  });
});


describe("Hermes legacy instruction connection failures", () => {
  const legacyInstructions = [
    ["AGENTS.md", "<!-- memmy-memory cli : start -->", "<!-- memmy-memory cli : end -->"],
    ["AGENTS.md", "<!-- memmy:start v=1 -->", "<!-- memmy:end v=1 -->"],
    ["SOUL.md", "<!-- memmy-memory cli : start -->", "<!-- memmy-memory cli : end -->"]
  ] as const;
  for (const kind of ["skill", "plugin"] as const) {
    it.each(legacyInstructions)(`preserves Hermes %s %s when ${kind} notification fails`, async (fileName, marker, endMarker) => {
      const h = createConnectionHarness(kind, "hermes");
      writeFileSync(join(h.agentRoot, fileName), `User instructions.\n${marker}\nExisting Memmy CLI integration.\n${endMarker}\n`);
      expect(await h.target.isInstalled("hermes")).toBe(false);
      h.memory.reconcileAgentSkills({ sourceAgentId: "hermes", connectionState: "connected", complete: false, skills: [] });
      vi.mocked(h.memoryClient.reconcileAgentSkills).mockRejectedValueOnce(new Error("fixture notification failed"));
      const connect = () => kind === "plugin" ? h.service.installPlugin("hermes") : h.service.installSkill("hermes");
      await expect(connect()).rejects.toThrow("notification failed");
      expect(h.memory.agentSkillConnectionState("hermes")).toBe("connected");
      expect(await h.target.isInstalled("hermes")).toBe(true);
      expect(await h.target.isPluginInstalled?.()).toBe(false);
      expect(await h.status()).toBe("plugin_installed");
      expect(resolveAgentSourceConnectionAction({ sourceId: "hermes", builtin: true, status: await h.status() })).toBe("remove_plugin");
      expect((await h.scan()).status).toBe("activated");
      expect(h.inputs).toEqual([]);
    });
  }
});


describe("legacy connection deletion completes the disk and scan lifecycle", () => {
  const instructionCases = [
    ["opencode", "AGENTS.md", "<!-- memmy-memory cli : start -->", "<!-- memmy-memory cli : end -->"],
    ["opencode", "AGENTS.md", "<!-- memmy:start v=1 -->", "<!-- memmy:end v=1 -->"],
    ["openclaw", "workspace/AGENTS.md", "<!-- memmy-memory cli : start -->", "<!-- memmy-memory cli : end -->"],
    ["openclaw", "workspace/AGENTS.md", "<!-- memmy:start v=1 -->", "<!-- memmy:end v=1 -->"],
    ["hermes", "AGENTS.md", "<!-- memmy-memory cli : start -->", "<!-- memmy-memory cli : end -->"],
    ["hermes", "AGENTS.md", "<!-- memmy:start v=1 -->", "<!-- memmy:end v=1 -->"],
    ["hermes", "SOUL.md", "<!-- memmy-memory cli : start -->", "<!-- memmy-memory cli : end -->"],
    ["hermes", "SOUL.md", "<!-- memmy:start v=1 -->", "<!-- memmy:end v=1 -->"]
  ] as const;
  for (const kind of ["skill", "plugin"] as const) {
    it.each(instructionCases)(`removes %s %s %s through ${kind} deletion`, async (sourceId, fileName, marker, endMarker) => {
      const h = createConnectionHarness(kind, sourceId);
      const filePath = join(h.agentRoot, fileName);
      mkdirSync(join(filePath, ".."), { recursive: true });
      const block = `${marker}\nExisting Memmy integration.\n${endMarker}\n`;
      writeFileSync(filePath, `User instructions before.\n${block}${block}User instructions after.\n`);
      const nativeConfigPath = join(h.agentRoot, sourceId === "hermes" ? "config.yaml" : sourceId === "openclaw" ? "openclaw.json" : "opencode.json");
      writeFileSync(nativeConfigPath, JSON.stringify({ unrelated: { retained: true } }));
      h.memory.reconcileAgentSkills({ sourceAgentId: sourceId, connectionState: "connected", complete: false, skills: [] });
      expect(await h.status()).toBe("plugin_installed");
      expect((await h.scan()).status).toBe("activated");
      const disconnect = () => kind === "plugin" ? h.service.uninstallPlugin(sourceId) : h.service.uninstallSkill(sourceId);
      expect(resolveAgentSourceConnectionAction({ sourceId, builtin: true, status: await h.status() })).toBe("remove_plugin");
      await disconnect();
      expect(await h.status()).toBe("not_connected");
      expect(readFileSync(filePath, "utf8")).toBe("User instructions before.\nUser instructions after.\n");
      expect(YAML.parse(readFileSync(nativeConfigPath, "utf8"))).toMatchObject({ unrelated: { retained: true } });
      expect(h.memory.agentSkillConnectionState(sourceId)).toBe("disconnected");
      expect((await h.scan()).memory_value).toBe("");
      await disconnect();
      expect(await h.status()).toBe("not_connected");
      expect(readFileSync(filePath, "utf8")).toBe("User instructions before.\nUser instructions after.\n");
      expect(h.inputs).toEqual([]);
    });
  }
});


describe("uncertain connection state survives an offline App restart", () => {
  it.each([["skill", undefined, "remove_skill"], ["plugin", undefined, "remove_hook"], ["skill", "codex", "remove_hook"]] as const)("retains %s %s removal after both notifications fail", async (kind, source, action) => {
    const h = createConnectionHarness(kind, source);
    h.memory.reconcileAgentSkills({ sourceAgentId: h.sourceId, connectionState: "disconnected", complete: false, skills: [] });
    vi.mocked(h.memoryClient.reconcileAgentSkills)
      .mockRejectedValueOnce(new MemoryLayerNetworkError())
      .mockRejectedValueOnce(new MemoryLayerNetworkError());
    h.memoryClient.agentSources = { list: async () => { throw new MemoryLayerNetworkError(); } } as NonNullable<MemoryClient["agentSources"]>;
    await expect(h.connect()).rejects.toThrow("connection result is uncertain");
    const restarted = h.restartService();
    const listed = (await restarted.list()).find((candidate) => candidate.sourceId === h.sourceId)!;
    expect(resolveAgentSourceConnectionAction(listed)).toBe(action);
    expect(h.memory.agentSkillConnectionState(h.sourceId)).toBe("disconnected");
    expect((await h.scan()).memory_value).toBe("");
    if (action === "remove_skill") await restarted.uninstallSkill(h.sourceId);
    else await restarted.uninstallPlugin(h.sourceId);
    const removed = (await restarted.list()).find((candidate) => candidate.sourceId === h.sourceId)!;
    expect(removed.status).toBe("not_connected");
    expect((await h.scan()).memory_value).toBe("");
  });
});


describe("cross-process automatic connection authority", () => {
  it.each([false, true])("blocks App auto install/refresh after Memory disconnect, refresh=%s", async refresh => {
    const h = createConnectionHarness("plugin", "opencode");
    await h.connect();
    await h.executor.mutateConnection(h.sourceId, "plugin", "DELETE");
    if (refresh) await h.target.installPlugin!(h.sourceId);
    const install = vi.spyOn(h.target, "installPlugin");
    const auto = createAgentSourceAutoInjectService({ agentSources: h.service,
      permissionManager: { async canWriteAgentSkill() { return true; } },
      getScanPreferences: () => ({ autoInjectSkill: true, autoScanKnownAgents: false, watchFileChanges: false }) });
    vi.spyOn(h.target, "isInstalledHookCurrent").mockResolvedValue(false);
    await auto.runOnce();
    expect(install).not.toHaveBeenCalled();
    expect(h.memory.agentSkillConnectionState(h.sourceId)).toBe("disconnected");
  });

  it("blocks Memory automation after App disconnect with independent local state", async () => {
    const h = createConnectionHarness("plugin", "opencode");
    await h.connect(); await h.disconnect();
    writeFileSync(h.configPath, JSON.stringify({ memmyMemory: { agentAccess: {
      autoInjectSkill: true, autoScanKnownAgents: false, watchFileChanges: false, scanPermission: "scan_and_write_skill"
    } } }));
    const install = vi.spyOn(h.target, "installPlugin");
    h.executor.startAutomation();
    await new Promise(resolve => setTimeout(resolve, 1500));
    expect(install).not.toHaveBeenCalled();
    expect(await h.target.isInstalled(h.sourceId)).toBe(false);
  });

  it.each(["skill", "plugin"] as const)("reports stopped sharing and retains retry on App %s final save failure", async kind => {
    const h = createConnectionHarness(kind); await h.connect();
    const save = h.repository.setConnectionState.bind(h.repository);
    vi.spyOn(h.repository, "setConnectionState").mockImplementation((id, status, suppressed) => {
      if (status === "not_connected") throw new Error("fixture final save failed");
      save(id, status, suppressed);
    });
    await expect(h.disconnect()).rejects.toThrow("Skill sharing is stopped. Cleanup state could not be saved. Retry removal.");
    expect(h.memory.agentSkillConnectionState(h.sourceId)).toBe("disconnected");
    expect(await h.status()).toBe(kind === "plugin" ? "plugin_installed" : "skill_installed");
  });

  it.each(["skill", "plugin"] as const)("fails closed before %s writes when authority is unavailable", async kind => {
    const h = createConnectionHarness(kind);
    h.memoryClient.agentSources!.connectionState = async () => { throw new Error("fixture authority unavailable"); };
    const install = vi.spyOn(h.target, kind === "plugin" ? "installPlugin" : "install");
    await expect(kind === "plugin" ? h.service.installPlugin(h.sourceId, { installType: "auto_inject" })
      : h.service.installSkill(h.sourceId, { installType: "auto_inject" })).rejects.toThrow("authority unavailable");
    expect(install).not.toHaveBeenCalled();
  });
});


describe("automatic connection asynchronous boundaries", () => {
  it.each(["permission", "root", "install", "install_failure", "postcheck_failure"])("handles a remote disconnect at %s", async boundary => {
    const h = createConnectionHarness("plugin", "opencode");
    const disconnect = () => h.memory.reconcileAgentSkills({ sourceAgentId: h.sourceId, complete: false, connectionState: "disconnected", skills: [] });
    const install = h.target.installPlugin!.bind(h.target);
    const wrote = vi.spyOn(h.target, "installPlugin").mockImplementation(async id => {
      await install(id);
      if (boundary.startsWith("install")) disconnect();
      if (boundary === "install_failure") throw new Error("fixture partial install failed");
      if (boundary === "postcheck_failure") h.memoryClient.agentSources!.connectionState = async () => { throw new Error("fixture postcheck unavailable"); };
    });
    if (boundary === "root") {
      const root = h.target.resolveRootDirectory.bind(h.target);
      vi.spyOn(h.target, "resolveRootDirectory").mockImplementation(async () => { disconnect(); return root(); });
    }
    const auto = createAgentSourceAutoInjectService({ agentSources: h.service,
      permissionManager: { async canWriteAgentSkill() { if (boundary === "permission") disconnect(); return true; } },
      getScanPreferences: () => ({ autoInjectSkill: true, autoScanKnownAgents: false, watchFileChanges: false }) });
    const result = await auto.runOnce();
    expect(result.installed).toEqual([]);
    expect(await h.target.isInstalled(h.sourceId)).toBe(false);
    if (["permission", "root"].includes(boundary)) expect(wrote).not.toHaveBeenCalled();
    expect(h.memoryClient.reconcileAgentSkills).not.toHaveBeenCalled();
  });

  it("does not overwrite an explicit reconnect during disk-only compensation", async () => {
    const h = createConnectionHarness("plugin", "opencode");
    const install = h.target.installPlugin!.bind(h.target);
    vi.spyOn(h.target, "installPlugin").mockImplementationOnce(async id => {
      await install(id);
      h.memory.reconcileAgentSkills({ sourceAgentId: id, complete: false, connectionState: "disconnected", skills: [] });
    });
    const remove = h.target.uninstallPlugin!.bind(h.target);
    vi.spyOn(h.target, "uninstallPlugin").mockImplementationOnce(async id => {
      h.memory.reconcileAgentSkills({ sourceAgentId: id, complete: false, connectionState: "connected", skills: [] });
      await remove(id);
    });
    await expect(h.service.installPlugin(h.sourceId, { installType: "auto_inject" })).rejects.toThrow();
    expect(h.memory.agentSkillConnectionState(h.sourceId)).toBe("connected");
    expect(h.memoryClient.reconcileAgentSkills).not.toHaveBeenCalled();
  });
});

it("reads persistent authority through the real local HTTP client without probing disk", async () => {
  const { createMemoryServiceFixture } = await import("../../../../../Memory/tests/fixtures/memory-service-fixture.js");
  const { createMemoryHttpServer, closeMemoryHttpServer } = await import("../../../../../Memory/src/server/http.js");
  const { createHttpMemoryClient } = await import("../../adapters/outbound/memory-client/http-memory-client.js");
  const fixture = createMemoryServiceFixture();
  const { service } = fixture.createTestService();
  const server = createMemoryHttpServer({ service, auth: { mode: "dev", localServiceToken: "fixture-token" } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as import("node:net").AddressInfo;
  const client = createHttpMemoryClient({ baseUrl: `http://127.0.0.1:${address.port}`, token: "fixture-token", timeoutMs: 5000, maxRetries: 0 });
  try {
    expect(typeof client.agentSources!.connectionState).toBe("function");
    await expect(client.agentSources!.connectionState("codex")).resolves.toMatchObject({ connectionState: null });
    service.reconcileAgentSkills({ sourceAgentId: "codex", connectionState: "disconnected", complete: false, skills: [] });
    await expect(client.agentSources!.connectionState("codex")).resolves.toMatchObject({ connectionState: "disconnected" });
    expect((await fetch(`http://127.0.0.1:${address.port}/api/v1/agent-sources/codex/connection-state`)).status).toBe(401);
    service.reconcileAgentSkills({ sourceAgentId: "codex", connectionState: "connected", complete: false, skills: [] });
    await expect(client.agentSources!.connectionState("codex")).resolves.toMatchObject({ connectionState: "connected" });
  } finally { await closeMemoryHttpServer(server); await fixture.cleanup(); }
}, 30000);


it("cleans up when the outer automatic completion authority check becomes unavailable", async () => {
  const h = createConnectionHarness("plugin", "opencode");
  const save = h.repository.setConnectionState.bind(h.repository);
  vi.spyOn(h.repository, "setConnectionState").mockImplementation((id, status, suppressed) => {
    save(id, status, suppressed);
    if (status === "plugin_installed" && !suppressed) h.memoryClient.agentSources!.connectionState = async () => { throw new Error("fixture completion authority unavailable"); };
  });
  const auto = createAgentSourceAutoInjectService({ agentSources: h.service,
    permissionManager: { async canWriteAgentSkill() { return true; } },
    getScanPreferences: () => ({ autoInjectSkill: true, autoScanKnownAgents: false, watchFileChanges: false }) });
  expect((await auto.runOnce()).installed).toEqual([]);
  expect(await h.target.isInstalled(h.sourceId)).toBe(false);
  expect(h.memoryClient.reconcileAgentSkills).not.toHaveBeenCalled();
});

it("allows App automatic refresh after an explicit remote reconnect supersedes completed local removal", async () => {
  const h = createConnectionHarness("plugin", "opencode");
  await h.connect(); await h.disconnect();
  await h.executor.mutateConnection(h.sourceId, "plugin", "POST");
  vi.spyOn(h.target, "isInstalledHookCurrent").mockResolvedValue(false);
  const install = vi.spyOn(h.target, "installPlugin");
  const auto = createAgentSourceAutoInjectService({ agentSources: h.service,
    permissionManager: { async canWriteAgentSkill() { return true; } },
    isAutoInjectSuppressed: id => h.repository.isAutoInjectSuppressed(id),
    getScanPreferences: () => ({ autoInjectSkill: false, autoScanKnownAgents: false, watchFileChanges: false }) });
  await auto.runOnce();
  expect(install).toHaveBeenCalledOnce();
  expect(h.repository.isAutoInjectSuppressed(h.sourceId)).toBe(false);
});


it("compensates permission revocation at the outer automatic completion boundary", async () => {
  const h = createConnectionHarness("plugin", "opencode");
  let allowed = true;
  const save = h.repository.setConnectionState.bind(h.repository);
  vi.spyOn(h.repository, "setConnectionState").mockImplementation((id, status, suppressed) => {
    save(id, status, suppressed);
    if (status === "plugin_installed" && !suppressed) allowed = false;
  });
  const auto = createAgentSourceAutoInjectService({ agentSources: h.service,
    permissionManager: { async canWriteAgentSkill() { return true; } }, isScanAllowed: () => allowed,
    getScanPreferences: () => ({ autoInjectSkill: true, autoScanKnownAgents: false, watchFileChanges: false }) });
  expect((await auto.runOnce()).installed).toEqual([]);
  expect(await h.target.isInstalled(h.sourceId)).toBe(false);
});


it.each(["skill", "plugin"] as const)("preserves pending local %s disconnection after App automatic refresh compensation", async kind => {
  const h = createConnectionHarness(kind, kind === "plugin" ? "opencode" : undefined);
  await h.connect();
  expect(h.memory.agentSkillConnectionState(h.sourceId)).toBe("connected");
  const refresh = () => kind === "plugin" ? h.service.installPlugin(h.sourceId, { installType: "auto_inject" })
    : h.service.installSkill(h.sourceId, { installType: "auto_inject" });
  const installPlugin = h.target.installPlugin?.bind(h.target);
  const installSkill = h.target.install.bind(h.target);
  const disconnectDuringRefresh = async () => {
    vi.mocked(h.memoryClient.reconcileAgentSkills).mockRejectedValueOnce(new Error("fixture disconnect notification failed"));
    await expect(h.disconnect()).rejects.toThrow("notification failed");
  };
  const wrote = kind === "plugin"
    ? vi.spyOn(h.target, "installPlugin").mockImplementationOnce(async id => {
      await installPlugin!(id);
      await disconnectDuringRefresh();
    })
    : vi.spyOn(h.target, "install").mockImplementationOnce(async manifest => {
      await installSkill(manifest);
      await disconnectDuringRefresh();
    });

  await expect(refresh()).rejects.toThrow("installed files removed");
  expect(await h.target.isInstalled(h.sourceId)).toBe(false);
  expect(h.memory.agentSkillConnectionState(h.sourceId)).toBe("connected");
  expect(h.repository.isAutoInjectSuppressed(h.sourceId)).toBe(true);
  expect.soft(await h.status()).toBe(kind === "plugin" ? "plugin_installed" : "skill_installed");
  await expect.soft(refresh()).rejects.toThrow("pending cleanup");
  expect.soft(wrote).toHaveBeenCalledTimes(1);

  const restarted = h.restartService();
  const listed = (await restarted.list()).find(source => source.sourceId === h.sourceId)!;
  expect.soft(resolveAgentSourceConnectionAction(listed)).toBe(kind === "plugin" ? "remove_plugin" : "remove_skill");
  await expect.soft(restarted.isAutomaticConnectionAllowed(h.sourceId)).resolves.toBe(false);
  if (kind === "plugin") await restarted.uninstallPlugin(h.sourceId);
  else await restarted.uninstallSkill(h.sourceId);
  expect(h.memory.agentSkillConnectionState(h.sourceId)).toBe("disconnected");
  expect((await restarted.list()).find(source => source.sourceId === h.sourceId)?.status).toBe("not_connected");
  if (kind === "plugin") await restarted.installPlugin(h.sourceId);
  else await restarted.installSkill(h.sourceId);
  expect(h.memory.agentSkillConnectionState(h.sourceId)).toBe("connected");
  expect(await h.target.isInstalled(h.sourceId)).toBe(true);
});


it.each(["failed_disconnect", "reconnect"])("preserves a newer local %s during App compensation uninstall", async action => {
  const h = createConnectionHarness("plugin", "opencode");
  await h.connect();
  let allowed = true;
  const install = h.target.installPlugin!.bind(h.target);
  vi.spyOn(h.target, "installPlugin").mockImplementationOnce(async id => { await install(id); allowed = false; });
  const remove = h.target.uninstallPlugin!.bind(h.target);
  vi.spyOn(h.target, "uninstallPlugin").mockImplementationOnce(async id => {
    if (action === "failed_disconnect") {
      vi.mocked(h.memoryClient.reconcileAgentSkills).mockRejectedValueOnce(new Error("fixture disconnect notification failed"));
      await expect(h.disconnect()).rejects.toThrow("notification failed");
    } else await h.connect();
    await remove(id);
  });
  const refresh = () => h.service.installPlugin(h.sourceId, { installType: "auto_inject" }, () => {
    if (!allowed) throw new Error("fixture permission revoked");
  });

  await expect(refresh()).rejects.toThrow("installed files removed");
  expect(await h.target.isInstalled(h.sourceId)).toBe(action === "reconnect");
  expect(h.memory.agentSkillConnectionState(h.sourceId)).toBe("connected");
  expect.soft(h.repository.isAutoInjectSuppressed(h.sourceId)).toBe(action === "failed_disconnect");
  expect.soft(h.repository.listSources().find(source => source.sourceId === h.sourceId)?.status).toBe("plugin_installed");
  allowed = true;
  if (action === "failed_disconnect") await expect.soft(refresh()).rejects.toThrow("pending cleanup");
  const restarted = h.restartService();
  await expect.soft(restarted.isAutomaticConnectionAllowed(h.sourceId)).resolves.toBe(action === "reconnect");
  if (action === "failed_disconnect") {
    const listed = (await restarted.list()).find(source => source.sourceId === h.sourceId)!;
    expect.soft(resolveAgentSourceConnectionAction(listed)).toBe("remove_plugin");
    await restarted.uninstallPlugin(h.sourceId);
    expect(h.memory.agentSkillConnectionState(h.sourceId)).toBe("disconnected");
  } else {
    await restarted.installPlugin(h.sourceId, { installType: "auto_inject" });
    expect(await h.target.isInstalled(h.sourceId)).toBe(true);
  }
});


async function useRealConnectionHttpClient(h: ReturnType<typeof createConnectionHarness>) {
  const { createMemoryHttpServer, closeMemoryHttpServer } = await import("../../../../../Memory/src/server/http.js");
  const { createHttpMemoryClient } = await import("../../adapters/outbound/memory-client/http-memory-client.js");
  const server = createMemoryHttpServer({ service: h.memory, configPath: h.configPath, agentSourceExecutor: h.executor,
    auth: { mode: "dev", localServiceToken: "fixture-token" } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as import("node:net").AddressInfo;
  const client = createHttpMemoryClient({ baseUrl: `http://127.0.0.1:${address.port}`, token: "fixture-token", timeoutMs: 5000, maxRetries: 0 });
  h.memoryClient.agentSources = client.agentSources;
  return { client, close: () => closeMemoryHttpServer(server) };
}

function automaticConnectionRunner(service: AgentSourceService) {
  return createAgentSourceAutoInjectService({ agentSources: service,
    permissionManager: { async canWriteAgentSkill() { return true; } },
    getScanPreferences: () => ({ autoInjectSkill: true, autoScanKnownAgents: false, watchFileChanges: false }) });
}

describe("real HTTP connection authority protects App automatic installation", () => {
  it.each([false, true].flatMap(restart => [false, true].map(oldHook => ({ restart, oldHook }))))(
    "blocks a failed Viewer disconnect with stale connected KV, restart=$restart oldHook=$oldHook", async ({ restart, oldHook }) => {
      const h = createConnectionHarness("plugin", "opencode");
      await h.connect(); await h.disconnect();
      await h.executor.mutateConnection(h.sourceId, "plugin", "POST");
      vi.spyOn(h.memory, "reconcileAgentSkills").mockImplementationOnce(() => { throw new Error("fixture Viewer notification failed"); });
      await expect(h.executor.mutateConnection(h.sourceId, "plugin", "DELETE")).rejects.toThrow("notification failed");
      expect(h.memory.agentSkillConnectionState(h.sourceId)).toBe("connected");
      expect(h.repository.isAutoInjectSuppressed(h.sourceId)).toBe(true);
      if (!oldHook) await h.target.uninstallPlugin!(h.sourceId);
      const app = restart ? h.restartService() : h.service;
      if (restart) await h.restartExecutor();
      const http = await useRealConnectionHttpClient(h);
      try {
        const install = vi.spyOn(h.target, "installPlugin");
        vi.spyOn(h.target, "isInstalledHookCurrent").mockResolvedValue(false);
        await expect.soft(http.client.agentSources!.connectionState(h.sourceId)).resolves.toMatchObject({ connectionState: "disconnected" });
        const result = await automaticConnectionRunner(app).runOnce();
        expect.soft(result.installed).toEqual([]);
        expect.soft(install).not.toHaveBeenCalled();
        expect.soft(h.repository.isAutoInjectSuppressed(h.sourceId)).toBe(true);
        await expect.soft(app.installPlugin(h.sourceId, { installType: "auto_inject" })).rejects.toThrow("pending cleanup");
        expect(await h.target.isInstalled(h.sourceId)).toBe(oldHook);
        expect(h.memory.agentSkillConnectionState(h.sourceId)).toBe("connected");
        expect(JSON.parse(readFileSync(h.statePath, "utf8")).sources[h.sourceId]).toMatchObject({ status: "plugin_installed", autoInjectSuppressed: true });
      } finally { await http.close(); }
    });

  it.each(["not_connected", "plugin_installed"].flatMap(status => [false, true].map(oldHook => ({ status, oldHook }))))(
    "blocks legacy $status suppression without KV or imported rows, oldHook=$oldHook", async ({ status, oldHook }) => {
      const h = createConnectionHarness("plugin", "opencode");
      writeFileSync(h.statePath, JSON.stringify({ version: 2, sources: {
        [h.sourceId]: { status, autoInjectSuppressed: true, messageCount: 0, lastScannedAt: null, latestSeenAt: null }
      } }));
      if (oldHook) await h.target.installPlugin!(h.sourceId);
      await h.restartExecutor();
      const app = h.restartService();
      const http = await useRealConnectionHttpClient(h);
      try {
        const install = vi.spyOn(h.target, "installPlugin");
        vi.spyOn(h.target, "isInstalledHookCurrent").mockResolvedValue(false);
        expect(h.memoryDb.db.prepare("SELECT COUNT(*) AS n FROM memories").get()).toMatchObject({ n: 0 });
        expect(h.memory.agentSkillConnectionState(h.sourceId)).toBeUndefined();
        const source = (await app.list()).find(source => source.sourceId === h.sourceId)!;
        expect(source.status).toBe(status === "not_connected" && !oldHook ? "not_connected" : "plugin_installed");
        await expect.soft(http.client.agentSources!.connectionState(h.sourceId)).resolves.toMatchObject({ connectionState: "disconnected" });
        expect.soft((await automaticConnectionRunner(app).runOnce()).installed).toEqual([]);
        expect.soft(install).not.toHaveBeenCalled();
        await expect.soft(app.installPlugin(h.sourceId, { installType: "auto_inject" })).rejects.toThrow("pending cleanup");
        expect(await h.target.isInstalled(h.sourceId)).toBe(oldHook);
        expect(h.memory.agentSkillConnectionState(h.sourceId)).toBeUndefined();
      } finally { await http.close(); }
    });

  it.each(["App", "Memory"])("allows an explicit remote reconnect to supersede completed %s suppression after restart", async staleSide => {
    const h = createConnectionHarness("plugin", "opencode");
    await h.connect(); await h.disconnect();
    if (staleSide === "App") await h.executor.mutateConnection(h.sourceId, "plugin", "POST");
    else {
      await h.executor.mutateConnection(h.sourceId, "plugin", "DELETE");
      await h.connect();
      expect(JSON.parse(readFileSync(h.statePath, "utf8")).sources[h.sourceId]).toMatchObject({ status: "not_connected", autoInjectSuppressed: true });
    }
    await h.target.uninstallPlugin!(h.sourceId);
    await h.restartExecutor();
    const app = h.restartService();
    const http = await useRealConnectionHttpClient(h);
    try {
      await expect(http.client.agentSources!.connectionState(h.sourceId)).resolves.toMatchObject({ connectionState: "connected" });
      const result = await automaticConnectionRunner(app).runOnce();
      expect(result.installed).toEqual([h.sourceId]);
      expect(await h.target.isInstalled(h.sourceId)).toBe(true);
      expect(h.repository.isAutoInjectSuppressed(h.sourceId)).toBe(false);
    } finally { await http.close(); }
  });

  it("fails closed through HTTP when Memory cannot load its local connection state", async () => {
    const h = createConnectionHarness("plugin", "opencode");
    writeFileSync(h.statePath, "{invalid state");
    const http = await useRealConnectionHttpClient(h);
    try {
      const install = vi.spyOn(h.target, "installPlugin");
      await expect.soft(http.client.agentSources!.connectionState(h.sourceId)).rejects.toThrow();
      await expect.soft(h.service.installPlugin(h.sourceId, { installType: "auto_inject" })).rejects.toThrow();
      expect(install).not.toHaveBeenCalled();
      expect(await h.target.isInstalled(h.sourceId)).toBe(false);
    } finally { await http.close(); }
  });
});


describe("automatic compensation follows newer cross-runtime explicit events over real HTTP", () => {
  it.each(["App", "Memory"].flatMap(cleanupSide => ["reconnect", "skill", "disconnect", "failed_connect", "unchanged"].map(action => ({ cleanupSide, action }))))(
    "preserves the final files for $action while $cleanupSide removes its canceled refresh", async ({ cleanupSide, action }) => {
      const h = createConnectionHarness("plugin", "opencode");
      await h.connect();
      const http = await useRealConnectionHttpClient(h);
      h.memoryClient.reconcileAgentSkills = http.client.reconcileAgentSkills;
      let allowed = true;
      const savePermission = (scanPermission: string) => writeFileSync(h.configPath, JSON.stringify({ memmyMemory: { agentAccess: {
        autoScanKnownAgents: false, autoInjectSkill: true, watchFileChanges: false, scanPermission
      } } }));
      savePermission("scan_and_write_skill");
      vi.spyOn(h.target, "isInstalledHookCurrent").mockResolvedValue(false);
      const original = h.memory.agentSkillConnectionEvent(h.sourceId)!;
      const install = h.target.installPlugin!.bind(h.target);
      vi.spyOn(h.target, "installPlugin").mockImplementationOnce(async id => {
        await install(id); allowed = false; savePermission("none");
      });
      const remove = h.target.uninstallPlugin!.bind(h.target);
      let intervened = false;
      vi.spyOn(h.target, "uninstallPlugin").mockImplementationOnce(async id => {
        intervened = true;
        const remote = (method: "POST" | "DELETE") => cleanupSide === "App"
          ? h.executor.mutateConnection(h.sourceId, "plugin", method)
          : method === "POST" ? h.connect() : h.disconnect();
        if (action === "reconnect") await remote("POST");
        else if (action === "skill") {
          if (cleanupSide === "App") await h.executor.mutateConnection(h.sourceId, "skill", "POST");
          else await h.service.installSkill(h.sourceId);
        }
        else if (action === "disconnect") await remote("DELETE");
        else if (action === "failed_connect") {
          vi.spyOn(h.target, "installPlugin").mockImplementationOnce(async () => { throw new Error("fixture remote installation failed"); });
          await expect(remote("POST")).rejects.toThrow("installation failed");
        }
        await remove(id);
      });
      try {
        if (cleanupSide === "App") {
          await expect(h.service.installPlugin(h.sourceId, { installType: "auto_inject" }, () => {
            if (!allowed) throw new Error("fixture permission revoked");
          })).rejects.toThrow("installed files removed");
        } else {
          h.executor.startAutomation();
          await vi.waitFor(() => expect(intervened).toBe(true));
          await h.executor.dispose();
        }
        expect(intervened).toBe(true);
        expect(await h.target.isInstalled(h.sourceId)).toBe(action === "reconnect" || action === "skill");
        if (action === "skill") expect(await h.target.isPluginInstalled!()).toBe(false);
        expect(h.memory.agentSkillConnectionState(h.sourceId)).toBe(action === "disconnect" ? "disconnected" : "connected");
        const latest = h.memory.agentSkillConnectionEvent(h.sourceId)!;
        if (action === "reconnect" || action === "skill" || action === "disconnect") {
          expect(latest.id).not.toBe(original.id);
          expect(latest).toMatchObject({ kind: action === "skill" ? "skill" : "plugin", state: action === "disconnect" ? "disconnected" : "connected" });
        } else expect(latest).toEqual(original);
        expect(JSON.parse(readFileSync(h.configPath, "utf8")).memmyMemory.agentAccess.scanPermission).toBe("none");
      } finally { await http.close(); }
    });

  it.each(["App", "Memory"].flatMap(cleanupSide => [false, true].map(restoreFails => ({ cleanupSide, restoreFails }))))("rechecks a later explicit disconnect while $cleanupSide repairs files already removed, restoreFails=$restoreFails", async ({ cleanupSide, restoreFails }) => {
    const h = createConnectionHarness("plugin", "opencode");
    await h.connect();
    const http = await useRealConnectionHttpClient(h);
    h.memoryClient.reconcileAgentSkills = http.client.reconcileAgentSkills;
    let allowed = true;
    const savePermission = (scanPermission: string) => writeFileSync(h.configPath, JSON.stringify({ memmyMemory: { agentAccess: {
      autoScanKnownAgents: false, autoInjectSkill: true, watchFileChanges: false, scanPermission
    } } }));
    savePermission("scan_and_write_skill");
    vi.spyOn(h.target, "isInstalledHookCurrent").mockResolvedValue(false);
    const install = h.target.installPlugin!.bind(h.target);
    vi.spyOn(h.target, "installPlugin").mockImplementationOnce(async id => {
      await install(id); allowed = false; savePermission("none");
    });
    const remote = (method: "POST" | "DELETE") => cleanupSide === "App"
      ? h.executor.mutateConnection(h.sourceId, "plugin", method)
      : method === "POST" ? h.connect() : h.disconnect();
    const remove = h.target.uninstallPlugin!.bind(h.target);
    let repaired = false;
    vi.spyOn(h.target, "uninstallPlugin").mockImplementationOnce(async id => {
      await remote("POST");
      await remove(id);
      vi.spyOn(h.target, "installPlugin").mockImplementationOnce(async nextId => {
        repaired = true;
        await remote("DELETE");
        // The old restoration resumes writing after the later disconnect.
        await install(nextId);
        if (restoreFails) throw new Error("fixture partial restoration failed");
      });
    });
    try {
      if (cleanupSide === "App") await expect(h.service.installPlugin(h.sourceId, { installType: "auto_inject" }, () => {
        if (!allowed) throw new Error("fixture permission revoked");
      })).rejects.toThrow("installed files removed");
      else {
        h.executor.startAutomation();
        await vi.waitFor(() => expect(repaired).toBe(true));
        await h.executor.dispose();
      }
      expect(repaired).toBe(true);
      expect(await h.target.isInstalled(h.sourceId)).toBe(false);
      expect(h.memory.agentSkillConnectionState(h.sourceId)).toBe("disconnected");
      expect(h.memory.agentSkillConnectionEvent(h.sourceId)).toMatchObject({ state: "disconnected", kind: "plugin" });
    } finally { await http.close(); }
  });
});


it.each(["App", "Memory"])("allows a later remote reconnect after %s's failed local disconnect during compensation", async cleanupSide => {
  const h = createConnectionHarness("plugin", "opencode");
  await h.connect();
  const http = await useRealConnectionHttpClient(h);
  h.memoryClient.reconcileAgentSkills = http.client.reconcileAgentSkills;
  let allowed = true;
  const savePermission = (scanPermission: string) => writeFileSync(h.configPath, JSON.stringify({ memmyMemory: { agentAccess: {
    autoScanKnownAgents: false, autoInjectSkill: true, watchFileChanges: false, scanPermission
  } } }));
  savePermission("scan_and_write_skill");
  vi.spyOn(h.target, "isInstalledHookCurrent").mockResolvedValue(false);
  const install = h.target.installPlugin!.bind(h.target);
  vi.spyOn(h.target, "installPlugin").mockImplementationOnce(async id => {
    await install(id); allowed = false; savePermission("none");
  });
  const remove = h.target.uninstallPlugin!.bind(h.target);
  let intervened = false;
  vi.spyOn(h.target, "uninstallPlugin").mockImplementationOnce(async id => {
    intervened = true;
    vi.spyOn(h.memory, "reconcileAgentSkills").mockImplementationOnce(() => { throw new Error("fixture local notification failed"); });
    if (cleanupSide === "App") {
      await expect(h.disconnect()).rejects.toThrow();
      await h.executor.mutateConnection(h.sourceId, "plugin", "POST");
    } else {
      await expect(h.executor.mutateConnection(h.sourceId, "plugin", "DELETE")).rejects.toThrow();
      await h.connect();
    }
    await remove(id);
  });
  try {
    if (cleanupSide === "App") await expect(h.service.installPlugin(h.sourceId, { installType: "auto_inject" }, () => {
      if (!allowed) throw new Error("fixture permission revoked");
    })).rejects.toThrow("installed files removed");
    else {
      h.executor.startAutomation();
      await vi.waitFor(() => expect(intervened).toBe(true));
      await h.executor.dispose();
    }
    expect(await h.target.isInstalled(h.sourceId)).toBe(true);
    expect(h.memory.agentSkillConnectionState(h.sourceId)).toBe("connected");
    if (cleanupSide === "App") expect(h.repository.isAutoInjectSuppressed(h.sourceId)).toBe(false);
    else expect(JSON.parse(readFileSync(h.statePath, "utf8")).sources[h.sourceId]).toMatchObject({ status: "plugin_installed" });
    await expect(h.service.isAutomaticConnectionAllowed(h.sourceId)).resolves.toBe(true);
  } finally { await http.close(); }
});


it.each(["App", "Memory"])("honors committed connection authorization despite App status-save failure during %s compensation", async cleanupSide => {
  const h = createConnectionHarness("plugin", "opencode");
  await h.connect();
  const before = h.memory.agentSkillConnectionEvent(h.sourceId)!;
  const http = await useRealConnectionHttpClient(h);
  h.memoryClient.reconcileAgentSkills = http.client.reconcileAgentSkills;
  let allowed = true;
  const savePermission = (scanPermission: string) => writeFileSync(h.configPath, JSON.stringify({ memmyMemory: { agentAccess: {
    autoScanKnownAgents: false, autoInjectSkill: true, watchFileChanges: false, scanPermission
  } } }));
  savePermission("scan_and_write_skill");
  vi.spyOn(h.target, "isInstalledHookCurrent").mockResolvedValue(false);
  const install = h.target.installPlugin!.bind(h.target);
  vi.spyOn(h.target, "installPlugin").mockImplementationOnce(async id => {
    await install(id); allowed = false; savePermission("none");
  });
  const remove = h.target.uninstallPlugin!.bind(h.target);
  let intervened = false;
  vi.spyOn(h.target, "uninstallPlugin").mockImplementationOnce(async id => {
    intervened = true;
    vi.spyOn(h.repository, "setConnectionState").mockImplementationOnce(() => { throw new Error("fixture final connection status save failed"); });
    await expect(h.connect()).rejects.toThrow("status save failed");
    await remove(id);
  });
  try {
    if (cleanupSide === "App") await expect(h.service.installPlugin(h.sourceId, { installType: "auto_inject" }, () => {
      if (!allowed) throw new Error("fixture permission revoked");
    })).rejects.toThrow("installed files removed");
    else {
      h.executor.startAutomation();
      await vi.waitFor(() => expect(intervened).toBe(true));
      await h.executor.dispose();
    }
    const committed = h.memory.agentSkillConnectionEvent(h.sourceId)!;
    expect(committed.id).not.toBe(before.id);
    expect(committed).toMatchObject({ state: "connected", kind: "plugin" });
    expect(await h.target.isInstalled(h.sourceId)).toBe(true);
    await expect(h.service.isAutomaticConnectionAllowed(h.sourceId)).resolves.toBe(true);
  } finally { await http.close(); }
});


it.each(["App", "Memory"])("retains an already observed newer connection when authority becomes unavailable during %s restoration", async cleanupSide => {
  const h = createConnectionHarness("plugin", "opencode");
  await h.connect();
  const http = await useRealConnectionHttpClient(h);
  h.memoryClient.reconcileAgentSkills = http.client.reconcileAgentSkills;
  let allowed = true;
  const savePermission = (scanPermission: string) => writeFileSync(h.configPath, JSON.stringify({ memmyMemory: { agentAccess: {
    autoScanKnownAgents: false, autoInjectSkill: true, watchFileChanges: false, scanPermission
  } } }));
  savePermission("scan_and_write_skill");
  vi.spyOn(h.target, "isInstalledHookCurrent").mockResolvedValue(false);
  const install = h.target.installPlugin!.bind(h.target);
  vi.spyOn(h.target, "installPlugin").mockImplementationOnce(async id => {
    await install(id); allowed = false; savePermission("none");
  });
  const remove = h.target.uninstallPlugin!.bind(h.target);
  let restored = false;
  let restoreAuthority: (() => void) | undefined;
  vi.spyOn(h.target, "uninstallPlugin").mockImplementationOnce(async id => {
    if (cleanupSide === "App") await h.executor.mutateConnection(h.sourceId, "plugin", "POST");
    else await h.connect();
    await remove(id);
    vi.spyOn(h.target, "installPlugin").mockImplementationOnce(async nextId => {
      await install(nextId); restored = true;
      if (cleanupSide === "App") {
        const spy = vi.spyOn(h.memoryClient.agentSources!, "connectionState").mockRejectedValue(new Error("fixture temporary authority outage"));
        restoreAuthority = () => spy.mockRestore();
      } else {
        const spy = vi.spyOn(h.memory, "agentSkillConnectionEvent").mockImplementation(() => { throw new Error("fixture temporary authority outage"); });
        restoreAuthority = () => spy.mockRestore();
      }
    });
  });
  try {
    if (cleanupSide === "App") await expect(h.service.installPlugin(h.sourceId, { installType: "auto_inject" }, () => {
      if (!allowed) throw new Error("fixture permission revoked");
    })).rejects.toThrow("installed files removed");
    else {
      h.executor.startAutomation();
      await vi.waitFor(() => expect(restored).toBe(true));
      await h.executor.dispose();
    }
    expect(restored).toBe(true);
    expect(await h.target.isInstalled(h.sourceId)).toBe(true);
    restoreAuthority?.();
    expect(h.memory.agentSkillConnectionEvent(h.sourceId)).toMatchObject({ state: "connected", kind: "plugin" });
    await expect(h.service.isAutomaticConnectionAllowed(h.sourceId)).resolves.toBe(true);
  } finally { restoreAuthority?.(); await http.close(); }
});

it.each(["App", "Memory"].flatMap(cleanupSide => [false, true].map(explicit => ({ cleanupSide, explicit }))))("reconciles a newer remote connection after an obsolete $cleanupSide removal state save rejects, explicit=$explicit", async ({ cleanupSide, explicit }) => {
  const h = createConnectionHarness("plugin", "opencode");
  await h.connect();
  const http = await useRealConnectionHttpClient(h);
  h.memoryClient.reconcileAgentSkills = http.client.reconcileAgentSkills;
  let allowed = !explicit;
  const savePermission = (scanPermission: string) => writeFileSync(h.configPath, JSON.stringify({ memmyMemory: { agentAccess: {
    autoScanKnownAgents: false, autoInjectSkill: true, watchFileChanges: false, scanPermission
  } } }));
  savePermission(explicit ? "none" : "scan_and_write_skill");
  vi.spyOn(h.target, "isInstalledHookCurrent").mockResolvedValue(false);
  const install = h.target.installPlugin!.bind(h.target);
  vi.spyOn(h.target, "installPlugin").mockImplementationOnce(async id => {
    await install(id); allowed = false; savePermission("none");
  });
  let intervened = false;
  if (cleanupSide === "App") {
    let newerConnection: Promise<unknown> | undefined;
    const readAuthority = h.memoryClient.agentSources!.connectionState;
    h.memoryClient.agentSources!.connectionState = async id => { await newerConnection; return readAuthority(id); };
    const save = h.repository.setConnectionState.bind(h.repository);
    vi.spyOn(h.repository, "setConnectionState").mockImplementation((id, status, suppressed) => {
      save(id, status, suppressed);
      if (!allowed && !intervened && status === "not_connected") {
        intervened = true;
        newerConnection = h.executor.mutateConnection(h.sourceId, "plugin", "POST");
        throw new Error("fixture obsolete compensation save failed");
      }
    });
  } else {
    const rename = fsPromises.rename;
    vi.spyOn(fsPromises, "rename").mockImplementation(async (from, to) => {
      if (!allowed && !intervened && to === h.statePath && JSON.parse(readFileSync(from, "utf8")).sources[h.sourceId].status === "not_connected") {
        intervened = true;
        await h.connect();
        await rename(from, to);
        throw new Error("fixture obsolete compensation save failed");
      }
      return rename(from, to);
    });
  }
  try {
    if (explicit) {
      if (cleanupSide === "App") await h.disconnect();
      else await h.executor.mutateConnection(h.sourceId, "plugin", "DELETE");
    } else if (cleanupSide === "App") await expect(h.service.installPlugin(h.sourceId, { installType: "auto_inject" }, () => {
      if (!allowed) throw new Error("fixture permission revoked");
    })).rejects.toThrow("installed files removed");
    else {
      h.executor.startAutomation();
      await vi.waitFor(() => expect(intervened).toBe(true));
      await h.executor.dispose();
    }
    expect(intervened).toBe(true);
    expect(await h.target.isInstalled(h.sourceId)).toBe(true);
    if (cleanupSide === "App") {
      expect(h.repository.listSources().find(source => source.sourceId === h.sourceId)?.status).toBe("plugin_installed");
      expect(h.repository.isAutoInjectSuppressed(h.sourceId)).toBe(false);
    } else expect(JSON.parse(readFileSync(h.statePath, "utf8")).sources[h.sourceId]).toMatchObject({ status: "plugin_installed" });
    await expect(h.service.isAutomaticConnectionAllowed(h.sourceId)).resolves.toBe(true);
  } finally { await http.close(); }
});

it.each(["App", "Memory"].flatMap(removingSide => ["local", "remote"].map(reconnectingSide => ({ removingSide, reconnectingSide }))))(
  "preserves a later $reconnectingSide reconnect while an explicit $removingSide removal is awaiting uninstall", async ({ removingSide, reconnectingSide }) => {
    const h = createConnectionHarness("plugin", "opencode");
    await h.connect();
    const http = await useRealConnectionHttpClient(h);
    h.memoryClient.reconcileAgentSkills = http.client.reconcileAgentSkills;
    const remove = h.target.uninstallPlugin!.bind(h.target);
    let disconnectRevision = 0;
    vi.spyOn(h.target, "uninstallPlugin").mockImplementationOnce(async id => {
      disconnectRevision = h.memory.agentSkillConnectionEvent(id)!.revision!;
      expect(h.memory.agentSkillConnectionEvent(id)?.state).toBe("disconnected");
      const connectViaApp = removingSide === "App" ? reconnectingSide === "local" : reconnectingSide === "remote";
      if (connectViaApp) await h.connect();
      else await h.executor.mutateConnection(id, "plugin", "POST");
      await remove(id);
    });
    try {
      if (removingSide === "App") await h.disconnect();
      else await h.executor.mutateConnection(h.sourceId, "plugin", "DELETE");
      expect(await h.target.isInstalled(h.sourceId)).toBe(true);
      const event = h.memory.agentSkillConnectionEvent(h.sourceId)!;
      expect(event).toMatchObject({ state: "connected", kind: "plugin" });
      expect(event.revision).toBeGreaterThan(disconnectRevision);
      if (removingSide === "App") {
        expect(h.repository.isAutoInjectSuppressed(h.sourceId)).toBe(false);
        expect(h.repository.listSources().find(source => source.sourceId === h.sourceId)?.status).toBe("plugin_installed");
      } else expect(JSON.parse(readFileSync(h.statePath, "utf8")).sources[h.sourceId]).toMatchObject({ status: "plugin_installed" });
      await expect(h.service.isAutomaticConnectionAllowed(h.sourceId)).resolves.toBe(true);
    } finally { await http.close(); }
  });

it.each(["skill", "plugin"] as const)("honors a newer committed $kind reconnect across restart when App local status save fails after a failed disconnect", async kind => {
  const h = createConnectionHarness(kind, kind === "plugin" ? "opencode" : undefined);
  await h.connect();
  const http = await useRealConnectionHttpClient(h);
  h.memoryClient.reconcileAgentSkills = http.client.reconcileAgentSkills;
  try {
    vi.spyOn(h.target, kind === "plugin" ? "uninstallPlugin" : "uninstall")
      .mockRejectedValueOnce(new Error("fixture uninstall failed"));
    await expect(h.disconnect()).rejects.toThrow("Integration cleanup failed");
    expect(h.repository.isAutoInjectSuppressed(h.sourceId)).toBe(true);
    await expect(h.service.isAutomaticConnectionAllowed(h.sourceId)).resolves.toBe(false);

    vi.spyOn(h.repository, "setConnectionState").mockImplementationOnce(() => {
      throw new Error("fixture post-commit status save failed");
    });
    await expect(h.connect()).rejects.toThrow("fixture post-commit status save failed");

    expect(await h.target.isInstalled(h.sourceId)).toBe(true);
    expect(h.memory.agentSkillConnectionEvent(h.sourceId)).toMatchObject({ state: "connected", kind });
    await expect(h.service.isAutomaticConnectionAllowed(h.sourceId)).resolves.toBe(true);
    const restarted = h.restartService();
    await expect(restarted.isAutomaticConnectionAllowed(h.sourceId)).resolves.toBe(true);
  } finally {
    await http.close();
  }
});

it("resolves cross-runtime pending removals in both directions using revision watermarks", async () => {
  // Direction 1 (1B): Viewer failed DELETE -> App uninstallPlugin clears zombie status -> App installPlugin honors connected
  const h1 = createConnectionHarness("plugin", "opencode");
  await h1.executor.mutateConnection(h1.sourceId, "plugin", "POST");
  const http1 = await useRealConnectionHttpClient(h1);
  h1.memoryClient.reconcileAgentSkills = http1.client.reconcileAgentSkills;
  try {
    const realUninstall = h1.target.uninstallPlugin!.bind(h1.target);
    vi.spyOn(h1.target, "uninstallPlugin").mockRejectedValueOnce(new Error("fixture viewer delete failed"));
    await expect(h1.executor.mutateConnection(h1.sourceId, "plugin", "DELETE")).rejects.toThrow("Integration cleanup failed");
    expect((await h1.service.list()).find(s => s.sourceId === h1.sourceId)?.status).toBe("plugin_installed");

    vi.mocked(h1.target.uninstallPlugin!).mockImplementation(realUninstall);
    await h1.service.uninstallPlugin(h1.sourceId);
    expect((await h1.executor.list()).sources.find(s => s.sourceId === h1.sourceId)?.status).toBe("not_connected");
    expect((await h1.service.list()).find(s => s.sourceId === h1.sourceId)?.status).toBe("not_connected");

    await h1.service.installPlugin(h1.sourceId);
    await expect(http1.client.agentSources!.connectionState(h1.sourceId)).resolves.toMatchObject({ connectionState: "connected" });
    await expect(h1.service.isAutomaticConnectionAllowed(h1.sourceId)).resolves.toBe(true);
  } finally {
    await http1.close();
  }

  // Direction 2 (1C): App failed uninstallPlugin -> Viewer POST reconnect restores automatic connection across App restart
  const h2 = createConnectionHarness("plugin", "opencode");
  await h2.connect();
  const http2 = await useRealConnectionHttpClient(h2);
  h2.memoryClient.reconcileAgentSkills = http2.client.reconcileAgentSkills;
  try {
    vi.spyOn(h2.target, "uninstallPlugin").mockRejectedValueOnce(new Error("fixture app uninstall failed"));
    await expect(h2.disconnect()).rejects.toThrow("Integration cleanup failed");
    await expect(h2.service.isAutomaticConnectionAllowed(h2.sourceId)).resolves.toBe(false);

    await h2.executor.mutateConnection(h2.sourceId, "plugin", "POST");
    await expect(h2.service.isAutomaticConnectionAllowed(h2.sourceId)).resolves.toBe(true);
    const restarted = h2.restartService();
    await expect(restarted.isAutomaticConnectionAllowed(h2.sourceId)).resolves.toBe(true);
  } finally {
    await http2.close();
  }
});
