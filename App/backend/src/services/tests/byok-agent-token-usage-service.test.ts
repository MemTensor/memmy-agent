import { describe, expect, it, vi } from "vitest";
import type { ByokTokenUsageEvent, MemoryTokenBudgetDto } from "@memmy/local-api-contracts";
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

  it("keeps Memory's larger pending usage when App has not persisted it and Memory drops", async () => {
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
      trigger: "daily",
      stale: true
    });
    expect(repository.getMemoryPipelineUsage).toHaveBeenCalledTimes(2);
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
      dailyUsed: 11_000_000,
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

    const budget = await service.getMemoryBudget();
    expect(budget).toMatchObject({
      dailyLimitM: 10,
      totalLimitM: 500,
      dailyUsed: 10_000_000,
      lifetimeUsed: 23_000_000,
      paused: true,
      trigger: "daily"
    });
    expect(budget.stale).toBeUndefined();
    expect(repository.getMemoryPipelineUsage).toHaveBeenCalledWith(new Date(2026, 8, 18).toISOString());
  });

  it("includes a newly recorded History summary event before Memory reconciles it", async () => {
    const usage = { dailyUsed: 9_999_970, lifetimeUsed: 25_000_000 };
    const repository = {
      recordEvent: vi.fn((event: ByokTokenUsageEvent) => {
        usage.dailyUsed += event.totalTokens;
        usage.lifetimeUsed += event.totalTokens;
      }),
      getSummary: vi.fn(),
      getMemoryPipelineUsage: vi.fn(() => ({ ...usage }))
    };
    const service = createByokTokenUsageService({
      repository,
      bootstrapRepository: { getAppSettings: () => ({ memoryByokDailyLimitM: 10, memoryByokTotalLimitM: 500 } as never) },
      memoryClient: { getMemoryTokenBudget: vi.fn(async () => memoryBudgetFixture({
        dailyUsed: 9_999_970,
        lifetimeUsed: 25_000_000
      })) },
      now: () => new Date(2026, 8, 18, 12)
    });

    await expect(service.getMemoryBudget()).resolves.toMatchObject({ paused: false, trigger: null });
    await service.recordEvent({
      ...eventFixture(),
      kind: "memory_summary",
      capability: "memory_summary",
      operationId: "history-segment-1",
      metadata: { operation: "history.summary" },
      createdAt: new Date(2026, 8, 18, 12).toISOString()
    });
    await expect(service.getMemoryBudget()).resolves.toMatchObject({
      dailyUsed: 10_000_000,
      lifetimeUsed: 25_000_030,
      paused: true,
      trigger: "daily"
    });
  });

  it.each([
    { dailyUsed: 10_000_000, lifetimeUsed: 20_000_000, trigger: "daily" },
    { dailyUsed: 100, lifetimeUsed: 500_000_000, trigger: "total" },
    { dailyUsed: 10_000_000, lifetimeUsed: 500_000_000, trigger: "total" }
  ])("re-evaluates the merged budget when App events reach $trigger limits", async ({ dailyUsed, lifetimeUsed, trigger }) => {
    const service = createByokTokenUsageService({
      repository: {
        recordEvent: vi.fn(), getSummary: vi.fn(),
        getMemoryPipelineUsage: vi.fn(() => ({ dailyUsed, lifetimeUsed }))
      },
      bootstrapRepository: { getAppSettings: () => ({ memoryByokDailyLimitM: 10, memoryByokTotalLimitM: 500 } as never) },
      memoryClient: { getMemoryTokenBudget: vi.fn(async () => memoryBudgetFixture()) },
      now: () => new Date(2026, 8, 18, 12)
    });

    await expect(service.getMemoryBudget()).resolves.toMatchObject({ dailyUsed, lifetimeUsed, paused: true, trigger });
  });

  it("uses the latest runtime limits and permits unlimited zero limits after merging usage", async () => {
    const service = createByokTokenUsageService({
      repository: {
        recordEvent: vi.fn(), getSummary: vi.fn(),
        getMemoryPipelineUsage: vi.fn(() => ({ dailyUsed: 12_000_000, lifetimeUsed: 600_000_000 }))
      },
      bootstrapRepository: { getAppSettings: () => ({ memoryByokDailyLimitM: 10, memoryByokTotalLimitM: 500 } as never) },
      memoryClient: { getMemoryTokenBudget: vi.fn()
        .mockResolvedValueOnce(memoryBudgetFixture())
        .mockResolvedValueOnce(memoryBudgetFixture({ dailyLimitM: 0, totalLimitM: 0 })) },
      now: () => new Date(2026, 8, 18, 12)
    });

    await expect(service.getMemoryBudget()).resolves.toMatchObject({ paused: true, trigger: "total" });
    await expect(service.getMemoryBudget()).resolves.toMatchObject({
      dailyLimitM: 0, totalLimitM: 0, dailyUsed: 12_000_000, lifetimeUsed: 600_000_000,
      paused: false, trigger: null
    });
  });

  it("does not add overlapping persisted totals to Memory's larger pending ledger", async () => {
    const service = createByokTokenUsageService({
      repository: {
        recordEvent: vi.fn(), getSummary: vi.fn(),
        getMemoryPipelineUsage: vi.fn(() => ({ dailyUsed: 6_000_000, lifetimeUsed: 300_000_000 }))
      },
      bootstrapRepository: { getAppSettings: () => ({ memoryByokDailyLimitM: 10, memoryByokTotalLimitM: 500 } as never) },
      memoryClient: { getMemoryTokenBudget: vi.fn(async () => memoryBudgetFixture({
        dailyUsed: 7_000_000, lifetimeUsed: 400_000_000
      })) },
      now: () => new Date(2026, 8, 18, 12)
    });

    await expect(service.getMemoryBudget()).resolves.toMatchObject({
      dailyUsed: 7_000_000, lifetimeUsed: 400_000_000, paused: false, trigger: null
    });
  });

  it("merges new App events into a cached same-day snapshot while Memory is unavailable", async () => {
    let dailyUsed = 500;
    const service = createByokTokenUsageService({
      repository: {
        recordEvent: vi.fn(), getSummary: vi.fn(),
        getMemoryPipelineUsage: vi.fn(() => ({ dailyUsed, lifetimeUsed: dailyUsed }))
      },
      bootstrapRepository: { getAppSettings: () => ({ memoryByokDailyLimitM: 10, memoryByokTotalLimitM: 500 } as never) },
      memoryClient: { getMemoryTokenBudget: vi.fn()
        .mockResolvedValueOnce(memoryBudgetFixture({ dailyUsed: 500, lifetimeUsed: 500 }))
        .mockRejectedValueOnce(new Error("memory unavailable")) },
      now: () => new Date(2026, 8, 18, 12)
    });

    await expect(service.getMemoryBudget()).resolves.toMatchObject({ paused: false });
    dailyUsed = 10_000_000;
    await expect(service.getMemoryBudget()).resolves.toMatchObject({
      dailyUsed, lifetimeUsed: dailyUsed, paused: true, trigger: "daily", stale: true
    });
  });

  it("marks an initial Memory failure stale and clears it after Memory recovers", async () => {
    const service = createByokTokenUsageService({
      repository: {
        recordEvent: vi.fn(), getSummary: vi.fn(),
        getMemoryPipelineUsage: vi.fn(() => ({ dailyUsed: 500, lifetimeUsed: 5_000 }))
      },
      bootstrapRepository: { getAppSettings: () => ({ memoryByokDailyLimitM: 20, memoryByokTotalLimitM: 0 } as never) },
      memoryClient: { getMemoryTokenBudget: vi.fn()
        .mockRejectedValueOnce(new Error("memory unavailable"))
        .mockResolvedValueOnce(memoryBudgetFixture({ dailyUsed: 1_000, lifetimeUsed: 10_000 })) },
      now: () => new Date(2026, 8, 18, 12)
    });

    await expect(service.getMemoryBudget()).resolves.toMatchObject({
      dailyLimitM: 20, totalLimitM: 0, dailyUsed: 500, lifetimeUsed: 5_000,
      paused: false, trigger: null, stale: true
    });
    const recovered = await service.getMemoryBudget();
    expect(recovered).toMatchObject({
      dailyLimitM: 10, totalLimitM: 500, dailyUsed: 1_000, lifetimeUsed: 10_000,
      paused: false, trigger: null
    });
    expect(recovered.stale).toBeUndefined();
  });

  it("retains Memory's active pause and stale marker when merging smaller App usage", async () => {
    const service = createByokTokenUsageService({
      repository: {
        recordEvent: vi.fn(), getSummary: vi.fn(),
        getMemoryPipelineUsage: vi.fn(() => ({ dailyUsed: 100, lifetimeUsed: 100 }))
      },
      bootstrapRepository: { getAppSettings: () => ({ memoryByokDailyLimitM: 10, memoryByokTotalLimitM: 500 } as never) },
      memoryClient: { getMemoryTokenBudget: vi.fn(async () => memoryBudgetFixture({
        dailyUsed: 100, lifetimeUsed: 100, paused: true, trigger: "daily", stale: true
      })) },
      now: () => new Date(2026, 8, 18, 12)
    });

    await expect(service.getMemoryBudget()).resolves.toMatchObject({
      dailyUsed: 100, lifetimeUsed: 100, paused: true, trigger: "daily", stale: true
    });
  });

  it.each([
    { totalLimitM: 500, paused: false, trigger: null },
    { totalLimitM: 20, paused: true, trigger: "total" }
  ])("rolls cached daily usage at local midnight while retaining lifetime usage ($trigger)", async ({ totalLimitM, paused, trigger }) => {
    let current = new Date(2026, 8, 18, 23, 59);
    const repository = {
      recordEvent: vi.fn(), getSummary: vi.fn(),
      getMemoryPipelineUsage: vi.fn(() => ({ dailyUsed: 0, lifetimeUsed: 21_000_000 }))
    };
    const service = createByokTokenUsageService({
      repository,
      bootstrapRepository: { getAppSettings: () => ({ memoryByokDailyLimitM: 10, memoryByokTotalLimitM: 500 } as never) },
      memoryClient: { getMemoryTokenBudget: vi.fn()
        .mockResolvedValueOnce(memoryBudgetFixture({
          totalLimitM, dailyUsed: 10_000_000, lifetimeUsed: 23_000_000, paused: true,
          trigger: totalLimitM === 20 ? "total" : "daily"
        }))
        .mockRejectedValueOnce(new Error("memory unavailable")) },
      now: () => current
    });

    await service.getMemoryBudget();
    current = new Date(2026, 8, 19, 0, 1);
    await expect(service.getMemoryBudget()).resolves.toMatchObject({
      dailyUsed: 0, lifetimeUsed: 23_000_000, paused, trigger, stale: true,
      nextLocalMidnightAt: new Date(2026, 8, 20).toISOString()
    });
    expect(repository.getMemoryPipelineUsage).toHaveBeenLastCalledWith(new Date(2026, 8, 19).toISOString());
  });
});

function memoryBudgetFixture(overrides: Partial<MemoryTokenBudgetDto> = {}): MemoryTokenBudgetDto {
  return {
    dailyLimitM: 10,
    totalLimitM: 500,
    dailyUsed: 0,
    lifetimeUsed: 0,
    paused: false,
    trigger: null,
    nextLocalMidnightAt: new Date(2026, 8, 19).toISOString(),
    ...overrides
  };
}

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
