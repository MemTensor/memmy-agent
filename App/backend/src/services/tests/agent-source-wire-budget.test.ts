import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { legacyTurnId, legacyTurnRequestId, renderTurnClipped, type ConversationMessage } from "@memmy/agent-source-core";
import { createHttpMemoryClient } from "../../adapters/outbound/memory-client/http-memory-client.js";
import { createMemoryHttpServer, closeMemoryHttpServer } from "../../../../../Memory/src/server/http.js";
import type { MemoryService } from "../../../../../Memory/src/service/memory-service.js";
import type { AgentSourceExecutor } from "../../../../../Memory/src/agent-source/runtime.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeMemoryHttpServer(server)));
});

describe("scanned turn HTTP request budget", () => {
  it.each([
    ["quoted JSON tool output", '{"value":"quoted \\ path"}\n'.repeat(30_000)],
    ["JSON-escaped control characters", "\u0001".repeat(400_000)],
  ])("stores %s as one memory through the actual Memory HTTP body limit", async (_label, toolContent) => {
    const stored: Array<{ content: string }> = [];
    const server = createMemoryHttpServer({
      service: {
        idempotent(_operation: unknown, _input: unknown, _audit: unknown, run: () => unknown) { return run(); },
        addMemory(input: { content: string }) {
          stored.push(input);
          return { id: "wire-fixture", kind: "trace", memoryLayer: "L1", status: "activated", title: "one turn", summary: "stored", tags: [], createdAt: "2026-09-08T00:00:00.000Z", serverTime: "2026-09-08T00:00:00.000Z" };
        },
      } as unknown as MemoryService,
      auth: { localServiceToken: "fixture-token" },
      agentSourceExecutor: { dispose() {} } as unknown as AgentSourceExecutor,
      pluginRuntimeAnalytics: { track() {}, async trackAwait() {}, async flush() {} },
      workerStartupFallbackMs: 60_000,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP address");
    const bodies: string[] = [];
    const client = createHttpMemoryClient({ baseUrl: `http://127.0.0.1:${address.port}`, token: "fixture-token", timeoutMs: 5_000, maxRetries: 0 }, {
      fetchImpl: async (url, init) => { bodies.push(String(init?.body)); return fetch(url, init); },
    });
    const message = (messageId: string, role: ConversationMessage["role"], content: string): ConversationMessage => ({
      messageId, sourceId: "fixture", conversationId: "conversation", role, content,
      createdAt: "2026-09-08T00:00:00.000Z", workspacePath: null, gitRoot: null, rawMeta: {},
    });
    const turn = { sourceId: "fixture", conversationId: "conversation", turnIndex: 0, messages: [
      message("u", "user", "one turn"), message("t", "tool", toolContent), message("a", "assistant", "finished"),
    ] };
    const content = renderTurnClipped(turn.messages);

    await expect(client.addMemory({
      requestId: legacyTurnRequestId(turn), adapterId: "agent-source:fixture", content,
      layer: "L1", title: "one turn", tags: ["agent-source", "fixture"], source: "fixture",
      turnId: legacyTurnId(turn), createdAt: turn.messages[0]!.createdAt, deferProcessing: true,
    })).resolves.toMatchObject({ id: "wire-fixture" });

    expect(bodies).toHaveLength(1);
    expect(Buffer.byteLength(bodies[0]!)).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.content).toBe(content);
  });
});
