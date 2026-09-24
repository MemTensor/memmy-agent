import { describe, expect, it, vi } from "vitest";
import type { ByokTokenUsageEvent } from "@memmy/local-api-contracts";
import { createByokTokenUsageService } from "../byok-token-usage-service.js";

describe("ByokTokenUsageService", () => {
  it("validates and records BYOK token usage events", async () => {
    const repository = {
      recordEvent: vi.fn((_event: ByokTokenUsageEvent) => undefined),
      getSummary: vi.fn(),
      getMemoryPipelineUsage: vi.fn()
    };
    const service = createByokTokenUsageService({
      repository,
      bootstrapRepository: { getAppSettings: () => ({ memoryByokDailyLimitM: 10, memoryByokTotalLimitM: 500 } as never) }
    });

    await service.recordEvent(eventFixture());

    expect(repository.recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      id: "event-1",
      kind: "agent_chat",
      source: "agent",
      operationId: "turn-1",
      presetId: "byok-agent",
      provider: "openai",
      model: "gpt-4.1-mini",
      capability: "agent",
      totalTokens: 30,
    }));
  });

  it("rejects invalid events before calling the repository", async () => {
    const repository = {
      recordEvent: vi.fn(),
      getSummary: vi.fn(),
      getMemoryPipelineUsage: vi.fn()
    };
    const service = createByokTokenUsageService({
      repository,
      bootstrapRepository: { getAppSettings: () => ({ memoryByokDailyLimitM: 10, memoryByokTotalLimitM: 500 } as never) }
    });

    await expect(service.recordEvent({ ...eventFixture(), inputTokens: -1 })).rejects.toThrow();

    expect(repository.recordEvent).not.toHaveBeenCalled();
  });

  it("validates repository summaries before returning them", async () => {
    const repository = {
      recordEvent: vi.fn(),
      getMemoryPipelineUsage: vi.fn(),
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
        byModel: [{
          presetId: "byok-agent",
          provider: "openai",
          model: "gpt-4.1-mini",
          capability: "agent",
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
    const service = createByokTokenUsageService({
      repository,
      bootstrapRepository: { getAppSettings: () => ({ memoryByokDailyLimitM: 10, memoryByokTotalLimitM: 500 } as never) }
    });

    await expect(service.getSummary()).resolves.toMatchObject({
      inputTokens: 10,
      byKind: [{ kind: "agent_chat" }],
      byModel: [{ presetId: "byok-agent", provider: "openai", model: "gpt-4.1-mini" }],
    });
  });

  it("returns events-only pipeline usage without a pause flag", async () => {
    const repository = {
      recordEvent: vi.fn(),
      getSummary: vi.fn(),
      getMemoryPipelineUsage: vi.fn(() => ({
        dailyUsed: 20_000_000,
        lifetimeUsed: 600_000_000
      }))
    };
    const service = createByokTokenUsageService({
      repository,
      bootstrapRepository: { getAppSettings: () => ({ memoryByokDailyLimitM: 10, memoryByokTotalLimitM: 500 } as never) },
      now: () => new Date(2026, 8, 18, 12)
    });

    await expect(service.getMemoryPipelineUsage()).resolves.toEqual({
      dailyLimitM: 10,
      totalLimitM: 500,
      dailyUsed: 20_000_000,
      lifetimeUsed: 600_000_000,
      nextLocalMidnightAt: new Date(2026, 8, 19).toISOString()
    });
  });

  it("prefers Memory usage for the UI budget and keeps the last snapshot if Memory drops", async () => {
    const repository = {
      recordEvent: vi.fn(),
      getSummary: vi.fn(),
      getMemoryPipelineUsage: vi.fn(() => ({
        dailyUsed: 0,
        lifetimeUsed: 0
      }))
    };
    const memoryClient = {
      getMemoryTokenBudget: vi.fn()
        .mockResolvedValueOnce({
          dailyLimitM: 10,
          totalLimitM: 500,
          dailyUsed: 10_001_000,
          lifetimeUsed: 10_001_000,
          paused: true,
          trigger: "daily",
          nextLocalMidnightAt: new Date(2026, 8, 19).toISOString()
        })
        .mockRejectedValueOnce(new Error("memory unavailable"))
    };
    const service = createByokTokenUsageService({
      repository,
      bootstrapRepository: { getAppSettings: () => ({ memoryByokDailyLimitM: 10, memoryByokTotalLimitM: 500 } as never) },
      memoryClient,
      now: () => new Date(2026, 8, 18, 12)
    });

    await expect(service.getMemoryBudget()).resolves.toMatchObject({
      dailyUsed: 10_001_000,
      lifetimeUsed: 10_001_000,
      paused: true,
      trigger: "daily"
    });
    await expect(service.getMemoryBudget()).resolves.toMatchObject({
      dailyUsed: 10_001_000,
      lifetimeUsed: 10_001_000,
      paused: true,
      trigger: "daily"
    });
    expect(repository.getMemoryPipelineUsage).not.toHaveBeenCalled();
  });

  it("keeps Memory runtime limits and pause when App settings have already changed", async () => {
    const repository = {
      recordEvent: vi.fn(),
      getSummary: vi.fn(),
      getMemoryPipelineUsage: vi.fn(() => ({ dailyUsed: 0, lifetimeUsed: 0 }))
    };
    const service = createByokTokenUsageService({
      repository,
      bootstrapRepository: { getAppSettings: () => ({ memoryByokDailyLimitM: 20, memoryByokTotalLimitM: 0 } as never) },
      memoryClient: {
        async getMemoryTokenBudget() {
          return {
            dailyLimitM: 10,
            totalLimitM: 500,
            dailyUsed: 10_000_000,
            lifetimeUsed: 10_000_000,
            paused: true,
            trigger: "daily",
            nextLocalMidnightAt: new Date(2026, 8, 19).toISOString()
          };
        }
      },
      now: () => new Date(2026, 8, 18, 12)
    });

    await expect(service.getMemoryBudget()).resolves.toMatchObject({
      dailyLimitM: 10,
      totalLimitM: 500,
      dailyUsed: 10_000_000,
      lifetimeUsed: 10_000_000,
      paused: true,
      trigger: "daily"
    });
  });

  it("does not treat yesterday's daily usage as today's after midnight", async () => {
    let current = new Date(2026, 8, 18, 23, 59);
    const repository = {
      recordEvent: vi.fn(),
      getSummary: vi.fn(),
      getMemoryPipelineUsage: vi.fn(() => ({
        dailyUsed: 11_000_000,
        lifetimeUsed: 21_000_000
      }))
    };
    const memoryClient = {
      getMemoryTokenBudget: vi.fn()
        .mockResolvedValueOnce({
          dailyLimitM: 10,
          totalLimitM: 500,
          dailyUsed: 10_000_000,
          lifetimeUsed: 23_000_000,
          paused: true,
          trigger: "daily",
          nextLocalMidnightAt: new Date(2026, 8, 19).toISOString()
        })
        .mockRejectedValue(new Error("memory unavailable"))
    };
    const service = createByokTokenUsageService({
      repository,
      bootstrapRepository: { getAppSettings: () => ({ memoryByokDailyLimitM: 20, memoryByokTotalLimitM: 0 } as never) },
      memoryClient,
      now: () => current
    });

    await expect(service.getMemoryBudget()).resolves.toMatchObject({
      dailyUsed: 10_000_000,
      lifetimeUsed: 23_000_000,
      paused: true,
      trigger: "daily"
    });

    current = new Date(2026, 8, 19, 0, 1);
    await expect(service.getMemoryBudget()).resolves.toMatchObject({
      dailyLimitM: 10,
      totalLimitM: 500,
      dailyUsed: 11_000_000,
      lifetimeUsed: 23_000_000,
      paused: true,
      trigger: "daily",
      stale: true
    });
  });

  it("evaluates the memory pipeline budget from settings and whitelist usage", async () => {
    const repository = {
      recordEvent: vi.fn(),
      getSummary: vi.fn(),
      getMemoryPipelineUsage: vi.fn(() => ({
        dailyUsed: 10_000_000,
        lifetimeUsed: 23_000_000
      }))
    };
    const service = createByokTokenUsageService({
      repository,
      bootstrapRepository: { getAppSettings: () => ({ memoryByokDailyLimitM: 10, memoryByokTotalLimitM: 500 } as never) },
      now: () => new Date(2026, 8, 18, 12)
    });

    await expect(service.getMemoryBudget()).resolves.toMatchObject({
      dailyLimitM: 10,
      totalLimitM: 500,
      dailyUsed: 10_000_000,
      lifetimeUsed: 23_000_000,
      paused: true,
      trigger: "daily"
    });
    expect(repository.getMemoryPipelineUsage).toHaveBeenCalledWith(new Date(2026, 8, 18).toISOString());
  });
});

function eventFixture(): ByokTokenUsageEvent {
  return {
    id: "event-1",
    kind: "agent_chat",
    source: "agent",
    operationId: "turn-1",
    presetId: "byok-agent",
    provider: "openai",
    model: "gpt-4.1-mini",
    capability: "agent",
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
