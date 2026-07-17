/** Agent runtime services tests. */
import { describe, expect, it } from "vitest";
import { MemoryLayerError, type MemoryClient } from "../../adapters/outbound/memory-client/index.js";
import { createMockMemoryClient } from "../../tests/support/mock-memory-client.js";
import type { IdempotencyHit, IdempotencyStore, SaveIdempotencyInput } from "../../infrastructure/idempotency-store/index.js";
import { createMemoryDetailService } from "../memory-detail-service.js";
import { createPanelService } from "../panel-service.js";
import { createSearchService } from "../search-service.js";
import { createSessionService } from "../session-service.js";
import { createTurnService } from "../turn-service.js";

describe("agent runtime services", () => {
  it("wraps session writes in idempotency", async () => {
    const service = createSessionService({
      memoryClient: createClient(),
      idempotencyStore: createFakeStore()
    });
    const input = { sessionId: "host-session-1", source: "codex" };

    const first = await service.open(input, runtimeCtx());
    const second = await service.open(input, runtimeCtx());

    expect(first.kind).toBe("executed");
    expect(second.kind).toBe("duplicate");
  });

  it("forwards turn start without idempotency wrapping", async () => {
    const service = createTurnService({
      memoryClient: createClient(),
      idempotencyStore: createFakeStore()
    });
    const input = { sessionId: "session-1", query: "question", source: "codex" };

    const output = await service.start(input, runtimeCtx());

	    expect(output).toMatchObject({
	      sessionId: "session-1",
	      status: []
	    });
  });

  it("forwards final read and memory mutation services", async () => {
    const memoryClient = createClient();

    await createSearchService({ memoryClient }).search({ query: "retry", source: "codex" }, runtimeCtx());
    await createMemoryDetailService({ memoryClient }).add({ content: "remember this", source: "codex" }, runtimeCtx());
    await createMemoryDetailService({ memoryClient }).getById("memory-1", runtimeCtx());
    await createMemoryDetailService({ memoryClient }).delete("memory-1", { source: "codex" }, runtimeCtx());
    const panelService = createPanelService({ memoryClient });
    await panelService.overview(runtimeCtx());
    await panelService.analysis(runtimeCtx());
    await panelService.items({ layer: "L1" }, runtimeCtx());
    await panelService.memoryApiLogs({ limit: 20, offset: 0 }, runtimeCtx());
  });

  it("treats old memory runtimes that route logs as memory id as empty logs", async () => {
    const memoryClient = {
      ...createClient(),
      async memoryApiLogs() {
        throw new MemoryLayerError("not_found", 404, "memory not found: logs");
      }
    };

    await expect(createPanelService({ memoryClient }).memoryApiLogs({ limit: 20, offset: 0 }, runtimeCtx()))
      .resolves.toMatchObject({
        logs: [],
        total: 0,
        limit: 20,
        offset: 0
      });
  });

  it("wraps turn completion in idempotency and rejects duplicate body mismatches", async () => {
    const service = createTurnService({
      memoryClient: createClient(),
      idempotencyStore: createFakeStore()
    });
    const input = { sessionId: "session-1", query: "question", answer: "answer", source: "codex" };

    const first = await service.complete("turn-1", input, runtimeCtx());
    const second = await service.complete("turn-1", input, runtimeCtx());

    expect(first.kind).toBe("executed");
    expect(second.kind).toBe("duplicate");
    await expect(service.complete("turn-1", { ...input, answer: "different" }, runtimeCtx())).rejects.toMatchObject({
      code: "idempotency_body_mismatch"
    });
  });
});

function runtimeCtx() {
  return { adapterId: "cursor/main", requestId: "req-1" };
}

function createClient(): MemoryClient {
  return createMockMemoryClient({ now: () => "2026-05-29T10:00:00.000Z" });
}

function createFakeStore(): IdempotencyStore {
  const rows = new Map<string, IdempotencyHit>();

  return {
    lookup(adapterId, requestId) {
      return rows.get(`${adapterId}:${requestId}`) ?? null;
    },
    save(input: SaveIdempotencyInput) {
      const key = `${input.adapterId}:${input.requestId}`;
      if (rows.has(key)) {
        throw new Error("unique constraint failed");
      }

      rows.set(key, {
        bodyHash: input.bodyHash,
        responseJson: input.responseJson,
        statusCode: input.statusCode,
        createdAt: "2026-05-29T10:00:00.000Z"
      });
    },
    purgeBefore() {
      return 0;
    }
  };
}
