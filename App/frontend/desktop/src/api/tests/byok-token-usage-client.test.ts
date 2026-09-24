import type { RuntimeConfig } from "@memmy/local-api-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpByokTokenUsageClient } from "../byok-token-usage-client.js";

const config: RuntimeConfig = {
  baseUrl: "http://127.0.0.1:18100",
  localToken: "token"
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("byok-token-usage-client", () => {
  it("reads BYOK token usage summary with runtime token", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input.toString()).toBe("http://127.0.0.1:18100/api/app/byok-token-usage/summary");
      expect(init?.method).toBe("GET");
      expect(init?.headers).toMatchObject({
        "x-memmy-local-token": "token"
      });

      return new Response(JSON.stringify({
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
        cachedInputTokens: 5,
        cacheCreationInputTokens: 2,
        updatedAt: "2026-06-11T10:00:00.000Z",
        byKind: [{
          kind: "agent_chat",
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30,
          cachedInputTokens: 5,
          cacheCreationInputTokens: 2,
          eventCount: 1,
          updatedAt: "2026-06-11T10:00:00.000Z"
        }]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(createHttpByokTokenUsageClient(config).getSummary()).resolves.toMatchObject({
      totalTokens: 30,
      byKind: [{ kind: "agent_chat" }]
    });
  });

  it("reads memory token budget with runtime token", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input.toString()).toBe("http://127.0.0.1:18100/api/app/byok-token-usage/memory-budget");
      expect(init?.method).toBe("GET");
      expect(init?.headers).toMatchObject({
        "x-memmy-local-token": "token"
      });
      return new Response(JSON.stringify({
        dailyLimitM: 10,
        totalLimitM: 500,
        dailyUsed: 1_700_000,
        lifetimeUsed: 23_000_000,
        paused: false,
        trigger: null,
        nextLocalMidnightAt: "2026-09-18T16:00:00.000Z"
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(createHttpByokTokenUsageClient(config).getMemoryBudget()).resolves.toMatchObject({
      dailyLimitM: 10,
      paused: false
    });
  });
});
