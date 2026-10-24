/** Agent source service tests. */
import { DatabaseSync } from "node:sqlite";
import { MANAGED_AGENT_DISCOVERY_PENDING_DATA_PATH } from "@memmy/local-api-contracts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import type { SkillDistributionService } from "../skill-distribution-service.js";

let db: DatabaseSync | undefined;
let tempDir: string | undefined;

afterEach(() => {
  vi.restoreAllMocks();
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

function createRepository(): AgentSourceRepository {
  db = new DatabaseSync(":memory:");
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
