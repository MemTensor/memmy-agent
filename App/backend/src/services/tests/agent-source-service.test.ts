/** Agent source service tests. */
import { DatabaseSync } from "node:sqlite";
import { MANAGED_AGENT_DISCOVERY_PENDING_DATA_PATH } from "@memmy/local-api-contracts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  db?.close();
  db = undefined;
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
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

  it("imports scanned Agent skills with immutable source provenance", async () => {
    const added: Parameters<MemoryClient["addMemory"]>[0][] = [];
    const memoryClient = createMockMemoryClient();
    const service = createService({
      adapters: [createFakeAdapter("cursor", createCompleteMemoryMessages("cursor", 1, "2026-05-28T10:00:00.000Z"))],
      memoryClient: {
        ...memoryClient,
        async addMemory(input, context) {
          added.push(input);
          return memoryClient.addMemory(input, context);
        }
      },
      skillDistributionService: {
        async listSkills() {
          return [{
            sourceAgentId: "cursor",
            sourceSkillId: "review-code",
            sourceSkillPath: "/tmp/cursor/skills/review-code/SKILL.md",
            sourceSkillVersion: "v2",
            sourceContentHash: "hash-v2",
            title: "review-code",
            content: "Review changed code.",
            updatedAt: "2026-05-28T09:00:00.000Z"
          }];
        },
        async install() {},
        async uninstall() {},
        async installPlugin() {},
        async uninstallPlugin() {}
      }
    });

    await service.scanOne("cursor");

    expect(added).toEqual([
      expect.objectContaining({
        layer: "Skill",
        sourceAgentId: "cursor",
        sourceSkillId: "review-code",
        sourceSkillPath: "/tmp/cursor/skills/review-code/SKILL.md",
        sourceSkillVersion: "v2",
        sourceContentHash: "hash-v2",
        tags: ["agent-source", "cross-agent-skill", "cursor"]
      })
    ]);
  });

  it("completes the scan and advances checkpoints when every memory is skipped", async () => {
    const repository = createRepository();
    const messages = createCompleteMemoryMessages("cursor", 1, "2026-05-28T10:00:00.000Z");
    const service = createService({
      repository,
      adapters: [createFakeAdapter("cursor", messages)],
      ingestionService: {
        async ingest(input) {
          const collected: ConversationMessage[] = [];
          for await (const message of input) {
            collected.push(message);
          }
          return {
            attempted: collected.length,
            written: 0,
            deduped: collected.length,
            failed: 0,
            writtenMemories: 0,
            dedupedMemories: 0,
            failedMemories: 0,
            memoryIds: [],
            conversations: 1,
            completedConversationIds: ["cursor-conv-1"],
            incompleteConversationIds: [],
            failedConversationIds: [],
            errors: []
          };
        }
      }
    });

    const result = await service.scanOne("cursor");

    expect(result).toEqual({
      sourceId: "cursor",
      discoveredConversations: 1,
      emittedMessages: 2,
      skipped: 2,
      memoryIds: [],
      errors: []
    });
    expect(repository.getConversationCheckpoint("cursor", "cursor-conv-1")).not.toBeNull();
    expect(repository.getScanWatermark("cursor")).not.toBeNull();
    expect(repository.listSources()[0]?.messageCount).toBe(0);
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

  it("excludes units whose first or last message violates the complete-turn boundary", async () => {
    const valid = createCompleteMemoryMessages("cursor", 1, "2026-05-01T00:00:00.000Z", {
      includeTool: true
    });
    const invalid = [
      {
        ...createMessage("cursor", 20),
        messageId: "invalid-user",
        conversationId: "invalid-user-tool",
        role: "user" as const,
        content: "query"
      },
      {
        ...createMessage("cursor", 21),
        messageId: "invalid-tool",
        conversationId: "invalid-user-tool",
        role: "tool" as const,
        content: "tool output"
      },
      {
        ...createMessage("cursor", 22),
        messageId: "orphan-assistant",
        conversationId: "orphan-assistant",
        role: "assistant" as const,
        content: "answer without query"
      },
      {
        ...createMessage("cursor", 23),
        messageId: "trailing-user",
        conversationId: "assistant-then-user",
        role: "user" as const,
        content: "query"
      },
      {
        ...createMessage("cursor", 24),
        messageId: "middle-assistant",
        conversationId: "assistant-then-user",
        role: "assistant" as const,
        content: "answer"
      },
      {
        ...createMessage("cursor", 25),
        messageId: "trailing-tool",
        conversationId: "assistant-then-user",
        role: "tool" as const,
        content: "late tool"
      }
    ];
    const service = createService({
      adapters: [createFakeAdapter("cursor", [...invalid, ...valid])]
    });

    const collected = await service.collectOne("cursor", { mode: "initial_subset" });

    expectMemoryCount(collected.messages, 1);
    expect(collected.messages.map((message) => message.messageId)).toEqual(
      valid.map((message) => message.messageId)
    );
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

  it("enqueues and drains scanned memories as a targeted cohort", async () => {
    const baseMemoryClient = createMockMemoryClient();
    const enqueueCalls: string[][] = [];
    const workerCalls: Array<{
      targetMemoryIds?: string[];
      priorityCohortOnly?: boolean;
    }> = [];
    const service = createService({
      adapters: [
        createFakeAdapter("cursor", [createMessage("cursor", 1)]),
        createFakeAdapter("custom", [createMessage("custom", 1)])
      ],
      ingestionService: {
        async ingest(messages, ctx) {
          for await (const _message of messages) {
            // Consume the source stream before returning its durable memory id.
          }
          return {
            attempted: 1,
            written: 1,
            deduped: 0,
            failed: 0,
            writtenMemories: 1,
            dedupedMemories: 0,
            failedMemories: 0,
            memoryIds: [`memory-${ctx.sourceId}`],
            conversations: 1,
            completedConversationIds: [],
            incompleteConversationIds: [],
            failedConversationIds: [],
            errors: []
          };
        }
      },
      memoryClient: {
        ...baseMemoryClient,
        async enqueueImportSummaries(memoryIds) {
          enqueueCalls.push([...(memoryIds ?? [])]);
          return {
            enqueued: memoryIds?.length ?? 0,
            memoryIds: memoryIds ?? [],
            serverTime: "2026-05-28T10:00:00.000Z"
          };
        },
        async runWorker(input) {
          workerCalls.push(input);
          return baseMemoryClient.runWorker(input);
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
      }
    });

    await service.scanAll();

    expect(enqueueCalls).toEqual([["memory-cursor", "memory-custom"]]);
    expect(workerCalls).toEqual([
      expect.objectContaining({
        limit: 1,
        targetMemoryIds: ["memory-cursor", "memory-custom"],
        priorityCohortOnly: true,
        timeoutMs: 2_400_000
      })
    ]);
  });

  it("reconciles summary progress when another worker finishes the scan memories", async () => {
    const baseMemoryClient = createMockMemoryClient();
    const workerTargets: string[][] = [];
    const workerLimits: number[] = [];
    const workerPriorityCohorts: Array<boolean | undefined> = [];
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
        workerLimits.push(input.limit);
        workerPriorityCohorts.push(input.priorityCohortOnly);
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
    expect(workerLimits).toEqual([1]);
    expect(workerPriorityCohorts).toEqual([true]);
    expect(progress).toEqual([
      { current: 0, total: 2 },
      { current: 2, total: 2 }
    ]);
  });

  it("emits persisted summary progress while the worker call remains pending", async () => {
    const baseMemoryClient = createMockMemoryClient();
    let releaseWorker = () => undefined;
    let workerSettled = false;
    const workerGate = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });
    const service = createService({
      memoryClient: {
        ...baseMemoryClient,
        async enqueueImportSummaries(memoryIds) {
          return { enqueued: memoryIds?.length ?? 0, memoryIds: memoryIds ?? [], serverTime: "2026-05-28T10:00:00.000Z" };
        },
        async runWorker(input) {
          await workerGate;
          workerSettled = true;
          return baseMemoryClient.runWorker(input);
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
      }
    });
    const progress: number[] = [];
    const processing = service.processImportSummaries(["memory-a"], {
      onProgress(event) {
        if (event.phase === "summarize") progress.push(event.current);
      }
    });

    try {
      await vi.waitFor(() => expect(progress).toContain(1), { timeout: 1_000, interval: 25 });
      expect(workerSettled).toBe(false);
    } finally {
      releaseWorker();
      await processing;
    }
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

    expect(enqueued).toEqual([]);
    expect(workerCalls).toBe(0);
    expect(progress).toEqual([{ current: 0, total: 0 }]);
  });

  it("bounds full-scan processing and status requests to 100-memory cohorts", async () => {
    const baseMemoryClient = createMockMemoryClient();
    const enqueueCalls: string[][] = [];
    const statusCalls: string[][] = [];
    const workerTargets: string[][] = [];
    const memoryIds = Array.from({ length: 205 }, (_item, index) => `memory-${index}`);
    const service = createService({
      memoryClient: {
        ...baseMemoryClient,
        async enqueueImportSummaries(ids) {
          enqueueCalls.push([...(ids ?? [])]);
          return { enqueued: ids?.length ?? 0, memoryIds: ids ?? [], serverTime: "2026-05-28T10:00:00.000Z" };
        },
        async runWorker(input) {
          workerTargets.push([...(input.targetMemoryIds ?? [])]);
          return baseMemoryClient.runWorker(input);
        },
        async getMemoryProcessingStatus(ids) {
          statusCalls.push([...ids]);
          return {
            items: ids.map((memoryId) => ({
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
      }
    });

    await expect(service.processImportSummaries(memoryIds)).resolves.toEqual([]);

    expect(enqueueCalls.map((ids) => ids.length)).toEqual([100, 100, 5]);
    expect(statusCalls.map((ids) => ids.length)).toEqual([100, 100, 5]);
    expect(workerTargets).toEqual(statusCalls);
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
    const replayedConversationIds: string[][] = [];
    const ingestionService = createFakeIngestionService();
    const service = createService({
      repository,
      ingestionService: {
        async ingest(input, context) {
          replayedConversationIds.push([...(context.replaySeenConversationIds ?? [])]);
          return ingestionService.ingest(input, context);
        }
      },
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

    messages = [
      ...messages,
      {
        ...messages[0]!,
        messageId: "cursor-turn-2-user",
        content: "follow-up question",
        createdAt: "2026-05-28T10:01:00.000Z"
      },
      {
        ...messages[1]!,
        messageId: "cursor-turn-2-assistant",
        content: "follow-up answer",
        createdAt: "2026-05-28T10:01:01.000Z"
      }
    ];
    await service.ingestCollected([await service.collectOne("cursor")]);
    expect(replayedConversationIds).toEqual([[], ["cursor-conv-1"], []]);
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
      success: true,
    });
    expect(analytics.events[1]?.params).toMatchObject({
      source_id: "cursor",
      status_after: "not_connected",
      success: true,
    });
    expect(analytics.events[2]?.params).toMatchObject({
      source_id: "openclaw",
      source_kind: "native_plugin",
      permission: "scan_and_write_skill",
      installed_plugin_id: "memory-core",
    });
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
        success: true,
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
        success: false,
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
    getScanPermission?: () => Promise<import("@memmy/local-api-contracts").ScanPermission>;
  } = {}
): AgentSourceService {
  return createAgentSourceService({
    sourceRegistry: createSourceRegistry(options.adapters ?? [createFakeAdapter("cursor")]),
    agentSourceRepository: options.repository ?? createRepository(),
    ingestionService: options.ingestionService ?? createFakeIngestionService(),
    memoryClient: options.memoryClient ?? createMockMemoryClient(),
    agentSourceAnalytics: options.agentSourceAnalytics,
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
