/** Ingestion service tests. */
import { describe, expect, it } from "vitest";
import type { MemoryClient } from "../../adapters/outbound/memory-client/index.js";
import { createMockMemoryClient } from "../../tests/support/mock-memory-client.js";
import { createIngestionService, IngestionAssertionError, type IngestionService } from "../ingestion-service.js";
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
        turnId: "cursor:conv-a:0",
        createdAt: "2026-05-28T10:00:01.000Z"
      }),
      expect.objectContaining({
        adapterId: "agent-source:cursor",
        content: "## user\n\nmessage 5\n\n## assistant\n\nmessage 6",
        layer: "L1",
        title: "message 5",
        source: "cursor",
        tags: ["agent-source", "cursor"],
        turnId: "cursor:conv-b:1",
        createdAt: "2026-05-28T10:00:05.000Z"
      })
    ]);
    expect(added.every((input) => typeof input.requestId === "string" && input.requestId.length > 0)).toBe(true);
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

  it("counts add failures and continues with later conversations", async () => {
    const addedConversationIds: string[] = [];
    const service = createService({
      async addMemory(input) {
        addedConversationIds.push(input.turnId ?? "");
        if (input.turnId === "cursor:conv-a:0") {
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

    expect(addedConversationIds).toEqual(["cursor:conv-a:0", "cursor:conv-b:1"]);
    expect(stats).toMatchObject({
      attempted: 6,
      written: 2,
      deduped: 2,
      failed: 2,
      conversations: 2,
      errors: [{ conversationId: "conv-a", reason: "memory unavailable" }]
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

    expect(calls).toEqual(["add:cursor:conv-a:0"]);
    expect(stats).toMatchObject({ attempted: 4, written: 2, deduped: 1, conversations: 1 });
  });

  it("skips a conversation when all dedup keys are already seen", async () => {
    const calls: string[] = [];
    const service = createService(
      {
        async addMemory() {
          calls.push("add");
          throw new Error("should not write deduped conversation");
        }
      },
      {
        hasSeen: () => true
      }
    );

    const stats = await service.ingest(
      toAsyncIterable([createMessage("conv-a", 1), createMessage("conv-a", 2), createMessage("conv-a", 3)]),
      { sourceId: "cursor" }
    );

    expect(calls).toEqual([]);
    expect(stats).toMatchObject({ attempted: 3, written: 0, deduped: 3, failed: 0, conversations: 1 });
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
});

function createService(
  memoryClientPatch: Partial<MemoryClient>,
  repositoryPatch: Partial<AgentSourceRepository> = {}
): IngestionService {
  return createIngestionService({
    memoryClient: {
      ...createMockMemoryClient({ now }),
      ...memoryClientPatch
    },
    agentSourceRepository: {
      ...createRepository(),
      ...repositoryPatch
    }
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
