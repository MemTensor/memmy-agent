import {
  ByokTokenUsageEventSchema,
  ByokTokenUsageSummarySchema,
  MemoryPipelineUsageDtoSchema,
  MemoryTokenBudgetDtoSchema,
  type ByokTokenUsageEvent,
  type ByokTokenUsageSummary,
  type MemoryPipelineUsageDto,
  type MemoryTokenBudgetDto
} from "@memmy/local-api-contracts";
import {
  evaluateMemoryTokenBudget,
  localCalendarDate,
  nextLocalMidnightMs,
  startOfLocalDayIso
} from "@memmy/agent-source-core";
import type { ByokTokenUsageRepository } from "../infrastructure/app-state-store/repositories/byok-token-usage-repo.js";
import type { BootstrapRepository } from "../infrastructure/app-state-store/repositories/bootstrap-repo.js";
import type { MemoryClient } from "../adapters/outbound/memory-client/types.js";

export interface ByokTokenUsageService {
  recordEvent(input: unknown): Promise<void>;
  getSummary(): Promise<ByokTokenUsageSummary>;
  getMemoryPipelineUsage(): Promise<MemoryPipelineUsageDto>;
  getMemoryBudget(): Promise<MemoryTokenBudgetDto>;
}

export interface CreateByokTokenUsageServiceOptions {
  repository: ByokTokenUsageRepository;
  bootstrapRepository: Pick<BootstrapRepository, "getAppSettings">;
  memoryClient?: Pick<MemoryClient, "getMemoryTokenBudget">;
  now?: () => Date;
}

export function createByokTokenUsageService(
  options: CreateByokTokenUsageServiceOptions
): ByokTokenUsageService {
  const now = options.now ?? (() => new Date());
  let lastMemoryBudget: { snapshot: MemoryTokenBudgetDto; dailyDate: string } | undefined;

  function eventsUsage(current: Date) {
    return options.repository.getMemoryPipelineUsage(startOfLocalDayIso(current));
  }

  function budgetFromUsage(
    current: Date,
    usage: { dailyUsed: number; lifetimeUsed: number }
  ): MemoryTokenBudgetDto {
    const settings = options.bootstrapRepository.getAppSettings();
    const snapshot = evaluateMemoryTokenBudget({
      dailyLimitM: settings.memoryByokDailyLimitM,
      totalLimitM: settings.memoryByokTotalLimitM,
      dailyUsed: usage.dailyUsed,
      lifetimeUsed: usage.lifetimeUsed
    });
    return MemoryTokenBudgetDtoSchema.parse({
      ...snapshot,
      nextLocalMidnightAt: new Date(nextLocalMidnightMs(current)).toISOString()
    });
  }

  function budgetFromMemorySnapshot(
    current: Date,
    snapshot: MemoryTokenBudgetDto
  ): MemoryTokenBudgetDto {
    return MemoryTokenBudgetDtoSchema.parse({
      dailyLimitM: snapshot.dailyLimitM,
      totalLimitM: snapshot.totalLimitM,
      dailyUsed: snapshot.dailyUsed,
      lifetimeUsed: snapshot.lifetimeUsed,
      paused: snapshot.paused,
      trigger: snapshot.trigger,
      nextLocalMidnightAt: snapshot.nextLocalMidnightAt || new Date(nextLocalMidnightMs(current)).toISOString()
    });
  }

  function staleSafeMemoryBudget(current: Date): MemoryTokenBudgetDto | undefined {
    if (!lastMemoryBudget) {
      return undefined;
    }
    const today = localCalendarDate(current);
    if (lastMemoryBudget.dailyDate === today) {
      return budgetFromMemorySnapshot(current, lastMemoryBudget.snapshot);
    }
    const events = eventsUsage(current);
    const rolled = evaluateMemoryTokenBudget({
      dailyLimitM: lastMemoryBudget.snapshot.dailyLimitM,
      totalLimitM: lastMemoryBudget.snapshot.totalLimitM,
      dailyUsed: events.dailyUsed,
      lifetimeUsed: Math.max(lastMemoryBudget.snapshot.lifetimeUsed, events.lifetimeUsed)
    });
    return MemoryTokenBudgetDtoSchema.parse({
      ...rolled,
      stale: true,
      nextLocalMidnightAt: new Date(nextLocalMidnightMs(current)).toISOString()
    });
  }

  async function readMemoryBudget(current: Date): Promise<MemoryTokenBudgetDto | undefined> {
    if (!options.memoryClient) {
      return staleSafeMemoryBudget(current);
    }
    try {
      const snapshot = await options.memoryClient.getMemoryTokenBudget();
      const parsed = budgetFromMemorySnapshot(current, snapshot);
      lastMemoryBudget = {
        snapshot: parsed,
        dailyDate: localCalendarDate(current)
      };
      return parsed;
    } catch {
      return staleSafeMemoryBudget(current);
    }
  }

  return {
    async recordEvent(input) {
      const event: ByokTokenUsageEvent = ByokTokenUsageEventSchema.parse(input);
      options.repository.recordEvent(event);
    },

    async getSummary() {
      return ByokTokenUsageSummarySchema.parse(options.repository.getSummary());
    },

    async getMemoryPipelineUsage() {
      const current = now();
      const settings = options.bootstrapRepository.getAppSettings();
      const usage = eventsUsage(current);
      return MemoryPipelineUsageDtoSchema.parse({
        dailyLimitM: settings.memoryByokDailyLimitM,
        totalLimitM: settings.memoryByokTotalLimitM,
        dailyUsed: usage.dailyUsed,
        lifetimeUsed: usage.lifetimeUsed,
        nextLocalMidnightAt: new Date(nextLocalMidnightMs(current)).toISOString()
      });
    },

    async getMemoryBudget() {
      const current = now();
      return await readMemoryBudget(current) ?? budgetFromUsage(current, eventsUsage(current));
    }
  };
}
