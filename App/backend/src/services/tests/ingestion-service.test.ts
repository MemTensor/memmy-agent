/** Ingestion service tests. */
import { describe, expect, it, vi } from "vitest";
import type { MemoryClient } from "../../adapters/outbound/memory-client/index.js";
import { createMockMemoryClient } from "../../tests/support/mock-memory-client.js";
import {
  createIngestionService,
  IngestionAssertionError,
  MEMORY_ADD_REQUEST_MAX_BYTES,
  type IngestionService,
  type IngestionWarning
} from "../ingestion-service.js";
import type { AgentSourceRepository } from "../../infrastructure/agent-source-store/index.js";
import type { ConversationMessage } from "../../adapters/outbound/agent-source/types.js";

describe("ingestion service", () => {
  it("imports each contiguous conversation as turn memories through memory add", async () => {
    const added: Array<Record<string, unknown>> = [];
    const service = createService({
      async addMemory(input) {
        added.push(input as Record<string, unknown>);
        return {
          id: `memory-${added.length}`,
          kind: "trace",
          memoryLayer: input.layer ?? "L1",
          status: "activated",
          title: input.title ?? "Imported conversation",
          summary: input.content,
          tags: input.tags ?? [],
          createdAt: now(),
          serverTime: now()
        };
      }
    });

    const stats = await service.ingest(
      toAsyncIterable([
        createMessage("conv-a", 1),
        createMessage("conv-a", 2),
        createMessage("conv-a", 3),
        createMessage("conv-b", 4),
        createMessage("conv-b", 5),
        createMessage("conv-b", 6)
      ]),
      { sourceId: "cursor" }
    );

    expect(added).toEqual([
      expect.objectContaining({
        adapterId: "agent-source:cursor",
        content: "## user\n\nmessage 1\n\n## assistant\n\nmessage 2",
        layer: "L1",
        title: "message 1",
        source: "cursor",
        tags: ["agent-source", "cursor"],
        createdAt: "2026-05-28T10:00:01.000Z"
      }),
      expect.objectContaining({
        adapterId: "agent-source:cursor",
        content: "## user\n\nmessage 5\n\n## assistant\n\nmessage 6",
        layer: "L1",
        title: "message 5",
        source: "cursor",
        tags: ["agent-source", "cursor"],
        createdAt: "2026-05-28T10:00:05.000Z"
      })
    ]);
    expect(added.every((input) => typeof input.requestId === "string" && input.requestId.length > 0)).toBe(true);
    expect(added.map((input) => input.turnId)).toEqual([
      expect.stringMatching(/^cursor:[a-f0-9]{24}$/),
      expect.stringMatching(/^cursor:[a-f0-9]{24}$/)
    ]);
    expect(stats).toEqual({
      attempted: 6,
      written: 4,
      deduped: 2,
      failed: 0,
      writtenMemories: 2,
      dedupedMemories: 0,
      failedMemories: 0,
      memoryIds: ["memory-1", "memory-2"],
      conversations: 2,
      completedConversationIds: ["conv-b"],
      incompleteConversationIds: ["conv-a"],
      failedConversationIds: [],
      errors: []
    });
  });

  it("marks scan imports for deferred summary processing when requested", async () => {
    const added: Array<Record<string, unknown>> = [];
    const service = createService({
      async addMemory(input) {
        added.push(input as Record<string, unknown>);
        return {
          id: `memory-${added.length}`,
          kind: "trace",
          memoryLayer: input.layer ?? "L1",
          status: "activated",
          title: input.title ?? "Imported conversation",
          summary: input.content,
          tags: input.tags ?? [],
          createdAt: now(),
          serverTime: now()
        };
      }
    });

    await service.ingest(
      toAsyncIterable([
        createMessage("conv-a", 1),
        createMessage("conv-a", 2)
      ]),
      { sourceId: "cursor", deferProcessing: true }
    );

    expect(added[0]).toEqual(expect.objectContaining({
      adapterId: "agent-source:cursor",
      deferProcessing: true
    }));
  });

  it("uses the user-entered Agent name as the L1 memory source when supplied", async () => {
    const added: Array<Record<string, unknown>> = [];
    const service = createService({
      async addMemory(input) {
        added.push(input as Record<string, unknown>);
        return {
          id: "memory-aider",
          kind: "trace",
          memoryLayer: "L1",
          status: "activated",
          title: input.title ?? "Imported conversation",
          summary: input.content,
          tags: input.tags ?? [],
          createdAt: now(),
          serverTime: now()
        };
      }
    });

    await service.ingest(
      toAsyncIterable([createMessage("conv-a", 1), createMessage("conv-a", 2)]),
      { sourceId: "manual-id-1", memorySource: "Aider" }
    );

    expect(added[0]).toEqual(expect.objectContaining({
      adapterId: "agent-source:manual-id-1",
      source: "Aider",
      tags: ["agent-source", "Aider"]
    }));
  });

  it("keeps the trace identity stable while changing the idempotency key for explicitly revised content", async () => {
    const added: Array<{ requestId?: string; turnId?: string }> = [];
    const service = createService({
      async addMemory(input) {
        added.push({ requestId: input.requestId, turnId: input.turnId });
        return {
          id: "memory-stable-turn",
          kind: "trace",
          memoryLayer: "L1",
          status: "activated",
          title: "Stable turn",
          summary: input.content,
          tags: [],
          createdAt: now(),
          serverTime: now()
        };
      }
    });
    const first = [createMessage("conv-a", 1), createMessage("conv-a", 2)];
    const revised = [first[0]!, { ...first[1]!, content: "revised assistant response" }];

    await service.ingest(toAsyncIterable(first), { sourceId: "cursor" });
    await service.ingest(toAsyncIterable(revised), {
      sourceId: "cursor",
      replaySeenConversationIds: new Set(["conv-a"])
    });

    expect(added[0]?.turnId).toBe(added[1]?.turnId);
    expect(added[0]?.requestId).not.toBe(added[1]?.requestId);
  });

  it("skips seen turns while importing a newly appended turn in the same conversation", async () => {
    const memoryClient = createMockMemoryClient({ now });
    const addMemory = vi.fn(memoryClient.addMemory);
    const service = createService({ addMemory });

    await service.ingest(
      toAsyncIterable([createMessage("conv-a", 1), createMessage("conv-a", 2)]),
      { sourceId: "cursor" }
    );
    const stats = await service.ingest(
      toAsyncIterable([
        createMessage("conv-a", 1),
        createMessage("conv-a", 2),
        createMessage("conv-a", 3),
        createMessage("conv-a", 4)
      ]),
      { sourceId: "cursor" }
    );

    expect(addMemory).toHaveBeenCalledTimes(2);
    expect(addMemory.mock.calls[1]?.[0].content).toBe("## user\n\nmessage 3\n\n## assistant\n\nmessage 4");
    expect(stats).toMatchObject({
      written: 2,
      deduped: 2,
      failed: 0,
      writtenMemories: 1,
      dedupedMemories: 1,
      failedMemories: 0,
      completedConversationIds: ["conv-a"],
      errors: []
    });
  });

  it("counts add failures and continues with later conversations", async () => {
    const addedConversationIds: string[] = [];
    let addCount = 0;
    const service = createService({
      async addMemory(input) {
        addCount += 1;
        addedConversationIds.push(input.turnId ?? "");
        if (addCount === 1) {
          throw new Error("memory unavailable");
        }

        return {
          id: "memory-1",
          kind: "trace",
          memoryLayer: input.layer ?? "L1",
          status: "activated",
          title: input.title ?? "Imported conversation",
          summary: input.content,
          tags: input.tags ?? [],
          createdAt: now(),
          serverTime: now()
        };
      }
    });

    const stats = await service.ingest(
      toAsyncIterable([
        createMessage("conv-a", 1),
        createMessage("conv-a", 2),
        createMessage("conv-a", 3),
        createMessage("conv-b", 4),
        createMessage("conv-b", 5),
        createMessage("conv-b", 6)
      ]),
      { sourceId: "cursor" }
    );

    expect(addedConversationIds).toEqual([
      expect.stringMatching(/^cursor:[a-f0-9]{24}$/),
      expect.stringMatching(/^cursor:[a-f0-9]{24}$/)
    ]);
    expect(stats).toMatchObject({
      attempted: 6,
      written: 2,
      deduped: 2,
      failed: 2,
      conversations: 2,
      completedConversationIds: ["conv-b"],
      incompleteConversationIds: [],
      failedConversationIds: ["conv-a"],
      errors: [{ conversationId: "conv-a", reason: "memory unavailable" }]
    });
  });

  it("warns and skips an oversized turn while importing later turns", async () => {
    const added: Array<Record<string, unknown>> = [];
    const warnings: IngestionWarning[] = [];
    const hasSeen = vi.fn(() => false);
    const markSeen = vi.fn(() => true);
    const service = createService(
      {
        async addMemory(input) {
          added.push(input as Record<string, unknown>);
          return {
            id: "memory-1",
            kind: "trace",
            memoryLayer: input.layer ?? "L1",
            status: "activated",
            title: input.title ?? "Imported conversation",
            summary: input.content,
            tags: input.tags ?? [],
            createdAt: now(),
            serverTime: now()
          };
        }
      },
      { hasSeen, markSeen },
      (warning) => warnings.push(warning)
    );

    const stats = await service.ingest(
      toAsyncIterable([
        { ...createMessage("conv-a", 1), content: "x".repeat(MEMORY_ADD_REQUEST_MAX_BYTES) },
        createMessage("conv-a", 2),
        createMessage("conv-b", 3),
        createMessage("conv-b", 4)
      ]),
      { sourceId: "cursor" }
    );

    expect(added).toHaveLength(1);
    expect(hasSeen).toHaveBeenCalledTimes(1);
    expect(markSeen).toHaveBeenCalledTimes(2);
    expect(warnings).toEqual([
      expect.objectContaining({
        code: "memory_add_request_too_large",
        sourceId: "cursor",
        conversationId: "conv-a",
        turnId: expect.stringMatching(/^cursor:[a-f0-9]{24}$/),
        bodyBytes: expect.any(Number),
        limitBytes: MEMORY_ADD_REQUEST_MAX_BYTES
      })
    ]);
    expect(warnings[0]!.bodyBytes).toBeGreaterThan(MEMORY_ADD_REQUEST_MAX_BYTES);
    expect(stats).toEqual({
      attempted: 4,
      written: 2,
      deduped: 2,
      failed: 0,
      writtenMemories: 1,
      dedupedMemories: 0,
      failedMemories: 0,
      memoryIds: ["memory-1"],
      conversations: 2,
      completedConversationIds: ["conv-a", "conv-b"],
      incompleteConversationIds: [],
      failedConversationIds: [],
      errors: []
    });
  });

  it("completes successfully with zero added memories when every turn is oversized", async () => {
    const addMemory = vi.fn();
    const hasSeen = vi.fn(() => false);
    const markSeen = vi.fn(() => true);
    const warnings: IngestionWarning[] = [];
    const service = createService(
      { addMemory },
      { hasSeen, markSeen },
      (warning) => warnings.push(warning)
    );

    const stats = await service.ingest(
      toAsyncIterable([
        { ...createMessage("conv-a", 1), content: "界".repeat(MEMORY_ADD_REQUEST_MAX_BYTES) },
        createMessage("conv-a", 2)
      ]),
      { sourceId: "cursor" }
    );

    expect(addMemory).not.toHaveBeenCalled();
    expect(hasSeen).not.toHaveBeenCalled();
    expect(markSeen).not.toHaveBeenCalled();
    expect(warnings).toHaveLength(1);
    expect(stats).toEqual({
      attempted: 2,
      written: 0,
      deduped: 2,
      failed: 0,
      writtenMemories: 0,
      dedupedMemories: 0,
      failedMemories: 0,
      memoryIds: [],
      conversations: 1,
      completedConversationIds: ["conv-a"],
      incompleteConversationIds: [],
      failedConversationIds: [],
      errors: []
    });
  });

  it("stops before opening the next conversation when the abort signal is set", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const service = createService({
      async addMemory(input) {
        calls.push(`add:${input.turnId}`);
        return {
          id: "memory-1",
          kind: "trace",
          memoryLayer: input.layer ?? "L1",
          status: "activated",
          title: input.title ?? "Imported conversation",
          summary: input.content,
          tags: input.tags ?? [],
          createdAt: now(),
          serverTime: now()
        };
      }
    });

    const stats = await service.ingest(toAbortAfterFirstConversation(controller), {
      sourceId: "cursor",
      signal: controller.signal
    });

    expect(calls).toEqual([expect.stringMatching(/^add:cursor:[a-f0-9]{24}$/)]);
    expect(stats).toMatchObject({
      attempted: 4,
      written: 2,
      deduped: 1,
      conversations: 1,
      incompleteConversationIds: ["conv-a"]
    });
  });

  it("skips an already-seen turn before memory.add so request-shape changes cannot conflict", async () => {
    const addMemory = vi.fn(async () => {
      throw new Error("already-seen turns must not call memory.add");
    });
    const markSeen = vi.fn(() => false);
    const service = createService(
      { addMemory },
      {
        hasSeen: () => true,
        markSeen
      }
    );

    const stats = await service.ingest(
      toAsyncIterable([createMessage("conv-a", 1), createMessage("conv-a", 2)]),
      { sourceId: "cursor" }
    );

    expect(addMemory).not.toHaveBeenCalled();
    expect(markSeen).not.toHaveBeenCalled();
    expect(stats).toEqual({
      attempted: 2,
      written: 0,
      deduped: 2,
      failed: 0,
      writtenMemories: 0,
      dedupedMemories: 1,
      failedMemories: 0,
      memoryIds: [],
      conversations: 1,
      completedConversationIds: ["conv-a"],
      incompleteConversationIds: [],
      failedConversationIds: [],
      errors: []
    });
  });

  it("does not import user-only or assistant-only turns as memories", async () => {
    const calls: string[] = [];
    const service = createService({
      async addMemory(input) {
        calls.push(input.turnId ?? "");
        return {
          id: "memory-1",
          kind: "trace",
          memoryLayer: input.layer ?? "L1",
          status: "activated",
          title: input.title ?? "Imported conversation",
          summary: input.content,
          tags: input.tags ?? [],
          createdAt: now(),
          serverTime: now()
        };
      }
    });

    const stats = await service.ingest(
      toAsyncIterable([
        { ...createMessage("conv-a", 1), role: "user" },
        { ...createMessage("conv-b", 2), role: "assistant" }
      ]),
      { sourceId: "cursor" }
    );

    expect(calls).toEqual([]);
    expect(stats).toMatchObject({
      attempted: 2,
      written: 0,
      deduped: 2,
      writtenMemories: 0
    });
  });

  it("imports only turns that start with user and end with a non-empty assistant response", async () => {
    const added: string[] = [];
    const service = createService({
      async addMemory(input) {
        added.push(input.content);
        return {
          id: `memory-${added.length}`,
          kind: "trace",
          memoryLayer: input.layer ?? "L1",
          status: "activated",
          title: input.title ?? "Imported conversation",
          summary: input.content,
          tags: input.tags ?? [],
          createdAt: now(),
          serverTime: now()
        };
      }
    });
    const message = (
      conversationId: string,
      messageId: string,
      role: ConversationMessage["role"],
      content = messageId
    ): ConversationMessage => ({
      ...createMessage(conversationId, 1),
      conversationId,
      messageId,
      role,
      content
    });

    const stats = await service.ingest(
      toAsyncIterable([
        message("user-tools", "ut-user", "user"),
        message("user-tools", "ut-tool", "tool"),
        message("assistant-only", "ao-assistant", "assistant"),
        message("tools-assistant", "ta-tool", "tool"),
        message("tools-assistant", "ta-assistant", "assistant"),
        message("abandoned-then-complete", "ac-user-abandoned", "user"),
        message("abandoned-then-complete", "ac-tool-abandoned", "tool"),
        message("abandoned-then-complete", "ac-user-complete", "user"),
        message("abandoned-then-complete", "ac-tool-complete", "tool"),
        message("abandoned-then-complete", "ac-assistant-complete", "assistant"),
        message("empty-assistant", "ea-user", "user"),
        message("empty-assistant", "ea-assistant", "assistant", "   "),
        message("complete", "complete-user", "user"),
        message("complete", "complete-tool", "tool"),
        message("complete", "complete-assistant", "assistant")
      ]),
      { sourceId: "cursor" }
    );

    expect(added).toEqual([
      [
        "## user\n\nac-user-complete",
        "## tool\n\nac-tool-complete",
        "## assistant\n\nac-assistant-complete"
      ].join("\n\n"),
      [
        "## user\n\ncomplete-user",
        "## tool\n\ncomplete-tool",
        "## assistant\n\ncomplete-assistant"
      ].join("\n\n")
    ]);
    expect(stats.incompleteConversationIds).toEqual(["user-tools", "empty-assistant"]);
    expect(stats.completedConversationIds).toEqual([
      "assistant-only",
      "tools-assistant",
      "abandoned-then-complete",
      "complete"
    ]);
    expect(stats.writtenMemories).toBe(2);
  });

  it("throws IngestionAssertionError when a conversationId is not contiguous", async () => {
    const service = createService({});

    await expect(
      service.ingest(
        toAsyncIterable([
          createMessage("conv-a", 1),
          createMessage("conv-b", 2),
          createMessage("conv-a", 3)
        ]),
        { sourceId: "cursor" }
      )
    ).rejects.toBeInstanceOf(IngestionAssertionError);
  });

  it("emits memory_desktop add analytics for each new addMemory call", async () => {
    const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
    const service = createService(
      {},
      {},
      undefined,
      {
        trackAddStarted(input) {
          events.push({ name: "started", payload: { ...input } });
        },
        trackAddSucceeded(input) {
          events.push({ name: "succeeded", payload: { ...input } });
        },
        trackAddFailed(input) {
          events.push({ name: "failed", payload: { ...input } });
        }
      }
    );

    await service.ingest(
      toAsyncIterable([
        createMessage("conv-a", 1),
        createMessage("conv-a", 2),
        createMessage("conv-b", 3),
        createMessage("conv-b", 4)
      ]),
      { sourceId: "cursor", scanMode: "initial_subset" }
    );

    expect(events.map((event) => event.name)).toEqual(["started", "succeeded", "started", "succeeded"]);
    expect(events[0]?.payload).toMatchObject({
      adapterId: "agent-source:cursor",
      conversationId: "conv-a",
      scanMode: "initial_subset"
    });
    expect(events[1]?.payload).toMatchObject({
      adapterId: "agent-source:cursor",
      conversationId: "conv-a",
      scanMode: "initial_subset",
      storedCount: 1
    });
    expect(typeof events[0]?.payload.turnId).toBe("string");
    expect(typeof events[1]?.payload.durationMs).toBe("number");
  });

  it("forwards scanMode into add analytics payloads", async () => {
    const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
    const service = createService(
      {},
      {},
      undefined,
      {
        trackAddStarted(input) {
          events.push({ name: "started", payload: { ...input } });
        },
        trackAddSucceeded(input) {
          events.push({ name: "succeeded", payload: { ...input } });
        },
        trackAddFailed(input) {
          events.push({ name: "failed", payload: { ...input } });
        }
      }
    );

    await service.ingest(
      toAsyncIterable([createMessage("conv-a", 1), createMessage("conv-a", 2)]),
      { sourceId: "cursor", scanMode: "full" }
    );

    expect(events).toHaveLength(2);
    expect(events[0]?.payload).toMatchObject({
      adapterId: "agent-source:cursor",
      scanMode: "full"
    });
    expect(events[1]?.payload).toMatchObject({
      scanMode: "full",
      storedCount: 1
    });
  });

  it("does not call memory.add or emit add analytics for already-seen turns", async () => {
    const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
    const addMemory = vi.fn(async () => {
      throw new Error("already-seen turns must not call memory.add");
    });
    const service = createService(
      { addMemory },
      {
        hasSeen: () => true
      },
      undefined,
      {
        trackAddStarted(input) {
          events.push({ name: "started", payload: { ...input } });
        },
        trackAddSucceeded(input) {
          events.push({ name: "succeeded", payload: { ...input } });
        },
        trackAddFailed(input) {
          events.push({ name: "failed", payload: { ...input } });
        }
      }
    );

    const stats = await service.ingest(
      toAsyncIterable([createMessage("conv-a", 1), createMessage("conv-a", 2)]),
      { sourceId: "cursor" }
    );

    expect(addMemory).not.toHaveBeenCalled();
    expect(stats.dedupedMemories).toBe(1);
    expect(events).toEqual([]);
  });

  it("emits add_failed analytics when addMemory throws", async () => {
    const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
    const service = createService(
      {
        async addMemory() {
          throw new Error("write failed");
        }
      },
      {},
      undefined,
      {
        trackAddStarted(input) {
          events.push({ name: "started", payload: { ...input } });
        },
        trackAddSucceeded(input) {
          events.push({ name: "succeeded", payload: { ...input } });
        },
        trackAddFailed(input) {
          events.push({ name: "failed", payload: { ...input } });
        }
      }
    );

    const stats = await service.ingest(
      toAsyncIterable([createMessage("conv-a", 1), createMessage("conv-a", 2)]),
      { sourceId: "cursor", scanMode: "incremental" }
    );

    expect(stats.failedMemories).toBe(1);
    expect(events.map((event) => event.name)).toEqual(["started", "failed"]);
    expect(events[1]?.payload).toMatchObject({
      adapterId: "agent-source:cursor",
      conversationId: "conv-a",
      scanMode: "incremental"
    });
    expect(events[1]?.payload.error).toBeInstanceOf(Error);
  });
});

function createService(
  memoryClientPatch: Partial<MemoryClient>,
  repositoryPatch: Partial<AgentSourceRepository> = {},
  warn?: (warning: IngestionWarning) => void,
  memoryAddAnalytics?: {
    trackAddStarted: (input: Record<string, unknown>) => void;
    trackAddSucceeded: (input: Record<string, unknown>) => void;
    trackAddFailed: (input: Record<string, unknown>) => void;
  }
): IngestionService {
  return createIngestionService({
    memoryClient: {
      ...createMockMemoryClient({ now }),
      ...memoryClientPatch
    },
    agentSourceRepository: {
      ...createRepository(),
      ...repositoryPatch
    },
    memoryAddAnalytics: memoryAddAnalytics as never,
    warn
  });
}

function createRepository(): Pick<AgentSourceRepository, "hasSeen" | "markSeen"> {
  const seen = new Set<string>();
  return {
    hasSeen(dedupKey) {
      return seen.has(dedupKey);
    },
    markSeen(dedupKey) {
      const existed = seen.has(dedupKey);
      seen.add(dedupKey);
      return !existed;
    }
  };
}

async function* toAsyncIterable(messages: readonly ConversationMessage[]): AsyncIterable<ConversationMessage> {
  for (const message of messages) {
    yield message;
  }
}

async function* toAbortAfterFirstConversation(controller: AbortController): AsyncIterable<ConversationMessage> {
  yield createMessage("conv-a", 1);
  yield createMessage("conv-a", 2);
  yield createMessage("conv-a", 3);
  controller.abort();
  yield createMessage("conv-b", 4);
  yield createMessage("conv-b", 5);
}

function createMessage(conversationId: string, index: number): ConversationMessage {
  return {
    messageId: `msg-${index}`,
    sourceId: "cursor",
    conversationId,
    role: index % 2 === 0 ? "assistant" : "user",
    content: `message ${index}`,
    createdAt: `2026-05-28T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
    workspacePath: null,
    gitRoot: null,
    rawMeta: Object.freeze({})
  };
}

function now(): string {
  return "2026-05-29T10:00:00.000Z";
}
