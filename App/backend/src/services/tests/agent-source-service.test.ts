/** Agent source service tests. */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createSourceRegistry } from "../../adapters/outbound/agent-source/source-registry.js";
import type {
  ConversationMessage,
  ScanOptions,
  SourceAdapter,
  SourceDescriptor
} from "../../adapters/outbound/agent-source/types.js";
import type { MemoryClient } from "../../adapters/outbound/memory-client/index.js";
import { createAgentSourceRepository, type AgentSourceRepository } from "../../infrastructure/agent-source-store/index.js";
import { createMockMemoryClient } from "../../tests/support/mock-memory-client.js";
import type { IngestionService } from "../ingestion-service.js";
import { createAgentSourceService, type AgentSourceService } from "../agent-source-service.js";
import type { SkillDistributionService } from "../skill-distribution-service.js";

let db: DatabaseSync | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

describe("agent source service", () => {
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

  it("scans one source and returns a ScanResult", async () => {
    const repository = createRepository();
    const service = createService({
      repository,
      adapters: [createFakeAdapter("cursor", createCompleteMemoryMessages("cursor", 1, "2026-05-28T10:00:00.000Z"))]
    });

    const result = await service.scanOne("cursor", { since: "2026-05-28T00:00:00.000Z" });

    expect(result).toEqual({
      sourceId: "cursor",
      discoveredConversations: 1,
      emittedMessages: 2,
      skipped: 0,
      memoryIds: [],
      errors: []
    });
    expect(repository.listSources()[0]).toMatchObject({
      sourceId: "cursor",
      lastScannedAt: "2026-05-28T10:00:00.000Z"
    });
  });

  it("forwards adapter scan progress through scan options", async () => {
    const phases: string[] = [];
    const service = createService({
      adapters: [
        createFakeAdapter("cursor", [createMessage("cursor", 1)], async function* (options) {
          options.onProgress?.({
            sourceId: "cursor",
            phase: "read",
            current: 1,
            total: 1,
            message: "adapter read"
          });
          yield createMessage("cursor", 1);
        })
      ]
    });

    await service.scanOne("cursor", {
      onProgress: (progress) => phases.push(`${progress.phase}:${progress.message ?? ""}`)
    });

    expect(phases).toContain("scan:adapter read");
  });

  it("returns source-scoped scan errors instead of throwing the whole scan job", async () => {
    const service = createService({
      adapters: [
        createFakeAdapter("cursor", [], async function* () {
          for (const message of createCompleteMemoryMessages("cursor", 1, "2026-05-28T10:00:00.000Z")) {
            yield message;
          }
          throw new Error("cursor database is corrupt");
        })
      ]
    });

    const result = await service.scanOne("cursor");

    expect(result).toEqual({
      sourceId: "cursor",
      discoveredConversations: 1,
      emittedMessages: 2,
      skipped: 0,
      memoryIds: [],
      errors: [{ conversationId: "scan", reason: "cursor database is corrupt" }]
    });
  });

  it("collects scanAll sources concurrently before ingestion", async () => {
    const started: string[] = [];
    const finished: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const createSequentialAdapter = (sourceId: string): SourceAdapter =>
      createFakeAdapter(sourceId, [createMessage(sourceId, 1)], async function* (options) {
        options.signal?.throwIfAborted();
        started.push(sourceId);
        if (sourceId === "cursor") {
          await firstGate;
        } else {
          releaseFirst();
        }
        yield createMessage(sourceId, 1);
        finished.push(sourceId);
      });
    const service = createService({
      adapters: [createSequentialAdapter("cursor"), createSequentialAdapter("custom")]
    });

    const results = await service.scanAll();

    expect(started).toEqual(["cursor", "custom"]);
    expect(finished.sort()).toEqual(["cursor", "custom"]);
    expect(results.map((result) => result.sourceId)).toEqual(["cursor", "custom"]);
  });

  it("skips unavailable sources during all-source scans", async () => {
    const scanned: string[] = [];
    const service = createService({
      adapters: [
        createFakeAdapter("cursor", [createMessage("cursor", 1)], async function* () {
          scanned.push("cursor");
          yield createMessage("cursor", 1);
        }),
        createFakeAdapter("claude_code", [createMessage("claude_code", 1)], async function* () {
          scanned.push("claude_code");
          yield createMessage("claude_code", 1);
        }, false)
      ]
    });

    const results = await service.scanAll();

    expect(scanned).toEqual(["cursor"]);
    expect(results.map((result) => result.sourceId)).toEqual(["cursor"]);
  });

  it("rejects single-source collection when the source is unavailable", async () => {
    const service = createService({
      adapters: [createFakeAdapter("claude_code", [], undefined, false)]
    });

    await expect(service.collectOne("claude_code")).rejects.toMatchObject({
      code: "agent_source_unavailable"
    });
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

  it("uses an initial bounded scan before switching a source to incremental scans", async () => {
    const repository = createRepository();
    const scanOptions: ScanOptions[] = [];
    const service = createService({
      repository,
      adapters: [
        createFakeAdapter("cursor", [], async function* (options) {
          scanOptions.push(options);
          for (const message of createCompleteMemoryMessages("cursor", 1, "2026-05-28T10:00:00.000Z")) {
            yield message;
          }
        })
      ]
    });

    await service.scanOne("cursor");
    await service.scanOne("cursor");

    expect(scanOptions[0]).toMatchObject({
      order: "recent_first",
      maxScanTargets: 1000,
      since: undefined
    });
    expect(scanOptions[0]?.maxMessages).toBeUndefined();
    expect(scanOptions[1]).toMatchObject({
      order: "source_default",
      since: "2026-05-28T10:00:02.000Z"
    });
    expect(repository.getScanWatermark("cursor")).toMatchObject({
      sourceId: "cursor",
      mode: "incremental",
      baselineAt: "2026-05-28T10:00:00.000Z",
      latestSeenCreatedAt: "2026-05-28T10:00:02.000Z"
    });
  });

  it("bounds first all-source scan to global recent complete memories plus absent source reserve", async () => {
    const service = createService({
      adapters: [
        createFakeAdapter("cursor", createCompleteMemoryMessages("cursor", 1000, "2026-06-01T00:00:00.000Z")),
        createFakeAdapter("claude_code", createCompleteMemoryMessages("claude_code", 300, "2026-05-01T00:00:00.000Z")),
        createFakeAdapter("codex", createCompleteMemoryMessages("codex", 300, "2026-04-01T00:00:00.000Z"))
      ]
    });

    const collected = await service.collectAll({ mode: "initial_subset" });

    expectMemoryCount(collected.find((source) => source.sourceId === "cursor")?.messages, 1000);
    expectMemoryCount(collected.find((source) => source.sourceId === "claude_code")?.messages, 200);
    expectMemoryCount(collected.find((source) => source.sourceId === "codex")?.messages, 200);
  });

  it("bounds one initial source by complete memory count instead of raw message count", async () => {
    const service = createService({
      adapters: [
        createFakeAdapter("cursor", createCompleteMemoryMessages("cursor", 1200, "2026-06-01T00:00:00.000Z", {
          includeTool: true
        }))
      ]
    });

    const collected = await service.collectOne("cursor", { mode: "initial_subset" });

    expectMemoryCount(collected.messages, 1000);
    expect(collected.messages).toHaveLength(3000);
  });

  it("skips incomplete turns when bounding initial memories", async () => {
    const completeMessages = createCompleteMemoryMessages("cursor", 10, "2026-05-01T00:00:00.000Z");
    const incompleteMessages = createIncompleteUserMessages("cursor", 5, "2026-06-01T00:00:00.000Z");
    const service = createService({
      adapters: [createFakeAdapter("cursor", [...incompleteMessages, ...completeMessages])]
    });

    const collected = await service.collectOne("cursor", { mode: "initial_subset" });

    expectMemoryCount(collected.messages, 10);
    expect(collected.messages.some((message) => message.messageId.includes("incomplete"))).toBe(false);
  });

  it("collects all source messages before ingesting any raw memories", async () => {
    const events: string[] = [];
    const createAdapter = (sourceId: string): SourceAdapter =>
      createFakeAdapter(sourceId, [createMessage(sourceId, 1)], async function* () {
        events.push(`scan:${sourceId}`);
        yield createMessage(sourceId, 1);
      });
    const service = createService({
      adapters: [createAdapter("cursor"), createAdapter("custom")],
      ingestionService: {
        async ingest(messages, ctx) {
          events.push(`ingest:${ctx.sourceId}`);
          let attempted = 0;
          for await (const _message of messages) {
            attempted += 1;
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
            conversations: 1,
            completedConversationIds: [],
            incompleteConversationIds: [],
            failedConversationIds: [],
            errors: []
          };
        }
      }
    });

    await service.scanAll();

    expect(events).toEqual(["scan:cursor", "scan:custom", "ingest:cursor", "ingest:custom"]);
  });

  it("reconciles summary progress when another worker finishes the scan memories", async () => {
    const baseMemoryClient = createMockMemoryClient();
    const workerTargets: string[][] = [];
    let enqueueCalls = 0;
    const memoryClient: MemoryClient = {
      ...baseMemoryClient,
      async enqueueImportSummaries() {
        enqueueCalls += 1;
        return {
          enqueued: enqueueCalls === 1 ? 2 : 0,
          memoryIds: ["memory-a", "memory-b"],
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
      },
      async runWorker(input) {
        workerTargets.push(input.targetMemoryIds ?? []);
        return baseMemoryClient.runWorker(input);
      }
    };
    const service = createService({ memoryClient });
    const progress: Array<{ current: number; total: number }> = [];

    await expect(service.processImportSummaries(["memory-a", "memory-b"], {
      progressSourceId: "hermes",
      onProgress(event) {
        if (event.phase === "summarize") {
          progress.push({ current: event.current, total: event.total });
        }
      }
    })).resolves.toEqual([]);

    expect(workerTargets).toEqual([["memory-a", "memory-b"]]);
    expect(progress).toEqual([
      { current: 0, total: 2 },
      { current: 2, total: 2 }
    ]);
  });

  it("finishes an empty owned-memory batch without starting the worker", async () => {
    const baseMemoryClient = createMockMemoryClient();
    const enqueued: string[][] = [];
    let workerCalls = 0;
    const service = createService({
      memoryClient: {
        ...baseMemoryClient,
        async enqueueImportSummaries(memoryIds) {
          enqueued.push([...memoryIds]);
          return { enqueued: 0, memoryIds: [], serverTime: "2026-05-28T10:00:00.000Z" };
        },
        async runWorker(input) {
          workerCalls += 1;
          return baseMemoryClient.runWorker(input);
        }
      }
    });
    const progress: Array<{ current: number; total: number }> = [];

    await expect(service.processImportSummaries([], {
      progressSourceId: "hermes",
      onProgress(event) {
        if (event.phase === "summarize") progress.push({ current: event.current, total: event.total });
      }
    })).resolves.toEqual([]);

    expect(enqueued).toEqual([[]]);
    expect(workerCalls).toBe(0);
    expect(progress).toEqual([{ current: 0, total: 0 }]);
  });

  it("treats a terminal processing failure as completed progress and reports its reason", async () => {
    const baseMemoryClient = createMockMemoryClient();
    const service = createService({
      memoryClient: {
        ...baseMemoryClient,
        async getMemoryProcessingStatus() {
          return {
            items: [{
              memoryId: "memory-failed",
              state: "failed" as const,
              stage: "embedding" as const,
              activeJobId: null,
              attemptCount: 6,
              manualRetryCount: 0,
              retryAction: "retry" as const,
              errorCode: "embedding_failed",
              errorMessage: "embedding provider unavailable",
              failedAt: "2026-05-28T10:00:00.000Z",
              updatedAt: "2026-05-28T10:00:00.000Z"
            }],
            serverTime: "2026-05-28T10:00:00.000Z"
          };
        }
      }
    });
    const progress: Array<{ current: number; total: number }> = [];

    await expect(service.processImportSummaries(["memory-failed"], {
      progressSourceId: "hermes",
      onProgress(event) {
        if (event.phase === "summarize") progress.push({ current: event.current, total: event.total });
      }
    })).resolves.toEqual([{
      memoryId: "memory-failed",
      reason: "embedding provider unavailable"
    }]);
    expect(progress).toEqual([
      { current: 0, total: 1 },
      { current: 1, total: 1 }
    ]);
  });

  it("checkpoints only completed conversations and does not advance the global cursor on partial failure", async () => {
    const repository = createRepository();
    repository.upsertSource({
      sourceId: "cursor",
      displayName: "Cursor",
      dataPath: "/tmp/cursor",
      builtin: true
    });
    const service = createService({
      repository,
      ingestionService: {
        async ingest() {
          return {
            attempted: 3,
            written: 1,
            deduped: 1,
            failed: 1,
            writtenMemories: 1,
            dedupedMemories: 0,
            failedMemories: 1,
            memoryIds: ["memory-complete"],
            conversations: 3,
            completedConversationIds: ["conversation-complete"],
            incompleteConversationIds: ["conversation-incomplete"],
            failedConversationIds: ["conversation-failed"],
            errors: [{ conversationId: "conversation-failed", reason: "write failed" }]
          };
        }
      }
    });
    const messages = [
      { ...createMessage("cursor", 1), conversationId: "conversation-complete", messageId: "complete-1" },
      { ...createMessage("cursor", 2), conversationId: "conversation-incomplete", messageId: "incomplete-1" },
      { ...createMessage("cursor", 3), conversationId: "conversation-failed", messageId: "failed-1" }
    ];

    const [result] = await service.ingestCollected([{
      sourceId: "cursor",
      scanMode: "incremental",
      scanStartedAt: "2026-05-28T09:00:00.000Z",
      conversationIds: messages.map((message) => message.conversationId),
      messages,
      errors: []
    }]);

    expect(result).toMatchObject({
      memoryIds: ["memory-complete"],
      errors: [{ conversationId: "conversation-failed", reason: "write failed" }]
    });
    expect(repository.getConversationCheckpoint("cursor", "conversation-complete")).toMatchObject({
      lastMessageId: "complete-1"
    });
    expect(repository.getConversationCheckpoint("cursor", "conversation-incomplete")).toBeNull();
    expect(repository.getConversationCheckpoint("cursor", "conversation-failed")).toBeNull();
    expect(repository.getScanWatermark("cursor")).toBeNull();
  });

  it("rescans a conversation when its content changes without changing the message cursor", async () => {
    const repository = createRepository();
    let messages = createCompleteMemoryMessages("cursor", 1, "2026-05-28T10:00:02.000Z");
    const service = createService({
      repository,
      adapters: [createFakeAdapter("cursor", [], async function* () {
        for (const message of messages) yield message;
      })]
    });

    await service.scanOne("cursor");
    messages = messages.map((message) => message.role === "assistant"
      ? { ...message, content: "revised answer with the same id and timestamp" }
      : message);

    const revised = await service.collectOne("cursor");
    expect(revised.messages.map((message) => message.content)).toContain(
      "revised answer with the same id and timestamp"
    );

    await service.ingestCollected([revised]);
    const unchanged = await service.collectOne("cursor");
    expect(unchanged.messages).toEqual([]);
  });

  it("groups messages by conversation before handing them to ingestion", async () => {
    const ingestedOrder: string[] = [];
    const repository = createRepository();
    repository.upsertSource({
      sourceId: "cursor",
      displayName: "Cursor",
      dataPath: "/tmp/cursor",
      builtin: true
    });
    const service = createService({
      repository,
      ingestionService: {
        async ingest(messages) {
          let attempted = 0;
          for await (const message of messages) {
            attempted += 1;
            ingestedOrder.push(`${message.conversationId}:${message.messageId}`);
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
            conversations: 2,
            completedConversationIds: [],
            incompleteConversationIds: [],
            failedConversationIds: [],
            errors: []
          };
        }
      }
    });

    await service.ingestCollected([
      {
        sourceId: "cursor",
        conversationIds: ["b", "a"],
        messages: [
          { ...createMessage("cursor", 1), conversationId: "b", messageId: "b-1", createdAt: "2026-05-28T10:00:01.000Z" },
          { ...createMessage("cursor", 2), conversationId: "a", messageId: "a-1", createdAt: "2026-05-28T10:00:02.000Z" },
          { ...createMessage("cursor", 3), conversationId: "b", messageId: "b-2", createdAt: "2026-05-28T10:00:03.000Z" },
          { ...createMessage("cursor", 4), conversationId: "a", messageId: "a-2", createdAt: "2026-05-28T10:00:04.000Z" }
        ],
        errors: []
      }
    ]);

    expect(ingestedOrder).toEqual(["a:a-1", "a:a-2", "b:b-1", "b:b-2"]);
  });

  it("adds and removes manual sources", async () => {
    const service = createService();

    const added = await service.addManual({
      displayName: "Manual Agent",
      dataPath: "/tmp/manual-agent"
    });
    await service.remove(added.sourceId);

    expect(added).toMatchObject({
      displayName: "Manual Agent",
      dataPath: "/tmp/manual-agent",
      builtin: false
    });
    await expect(service.list()).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ sourceId: added.sourceId })])
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
    await service.uninstallSkill("cursor");

    expect(calls).toEqual(["install:cursor", "uninstall:cursor"]);
    expect(repository.listSources()[0]?.status).toBe("not_connected");
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
    await service.uninstallPlugin("openclaw");

    expect(calls).toEqual(["plugin:openclaw", "unplugin:openclaw"]);
    expect(repository.listSources()[0]?.status).toBe("not_connected");
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
});

function createService(
  options: {
    repository?: AgentSourceRepository;
    adapters?: readonly SourceAdapter[];
    ingestionService?: IngestionService;
    skillDistributionService?: SkillDistributionService;
    memoryClient?: MemoryClient;
  } = {}
): AgentSourceService {
  return createAgentSourceService({
    sourceRegistry: createSourceRegistry(options.adapters ?? [createFakeAdapter("cursor")]),
    agentSourceRepository: options.repository ?? createRepository(),
    ingestionService: options.ingestionService ?? createFakeIngestionService(),
    memoryClient: options.memoryClient ?? createMockMemoryClient(),
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
      last_scanned_at TEXT,
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
