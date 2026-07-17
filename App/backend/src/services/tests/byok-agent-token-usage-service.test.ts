import { describe, expect, it, vi } from "vitest";
import type { ByokTokenUsageEvent } from "@memmy/local-api-contracts";
import { createByokTokenUsageService } from "../byok-token-usage-service.js";

describe("ByokTokenUsageService", () => {
  it("validates and records BYOK token usage events", async () => {
    const repository = {
      recordEvent: vi.fn((_event: ByokTokenUsageEvent) => undefined),
      getSummary: vi.fn(),
    };
    const service = createByokTokenUsageService({ repository });

    await service.recordEvent(eventFixture());

    expect(repository.recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      id: "event-1",
      kind: "agent_chat",
      source: "agent",
      operationId: "turn-1",
      totalTokens: 30,
    }));
  });

  it("rejects invalid events before calling the repository", async () => {
    const repository = {
      recordEvent: vi.fn(),
      getSummary: vi.fn(),
    };
    const service = createByokTokenUsageService({ repository });

    await expect(service.recordEvent({ ...eventFixture(), inputTokens: -1 })).rejects.toThrow();

    expect(repository.recordEvent).not.toHaveBeenCalled();
  });

  it("validates repository summaries before returning them", async () => {
    const repository = {
      recordEvent: vi.fn(),
      getSummary: vi.fn(() => ({
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
          updatedAt: "2026-06-11T10:00:00.000Z",
        }],
      })),
    };
    const service = createByokTokenUsageService({ repository });

    await expect(service.getSummary()).resolves.toMatchObject({
      inputTokens: 10,
      byKind: [{ kind: "agent_chat" }],
    });
  });
});

function eventFixture(): ByokTokenUsageEvent {
  return {
    id: "event-1",
    kind: "agent_chat",
    source: "agent",
    operationId: "turn-1",
    inputTokens: 10,
    outputTokens: 20,
    totalTokens: 30,
    cachedInputTokens: 5,
    cacheCreationInputTokens: 2,
    metadata: {
      sessionKey: "cli:direct",
      provider: "openai",
      modelId: "gpt-4.1-mini",
    },
    rawUsage: { prompt_tokens: 10, completion_tokens: 20 },
    createdAt: "2026-06-11T10:00:00.000Z",
  };
}
