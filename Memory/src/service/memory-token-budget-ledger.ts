import {
  DEFAULT_MEMORY_BYOK_DAILY_LIMIT_M,
  DEFAULT_MEMORY_BYOK_TOTAL_LIMIT_M,
  evaluateMemoryTokenBudget,
  isBudgetedMemoryUsage,
  localCalendarDate,
  nextLocalMidnightMs,
  normalizeMemoryByokLimitM,
  type MemoryTokenBudgetSnapshot
} from "@memmy/agent-source-core";

export const MEMORY_BYOK_BUDGET_KV_KEY = "memory_byok_budget_v1";

export interface MemoryTokenBudgetLimits {
  dailyLimitM: number;
  totalLimitM: number;
}

interface StoredBudgetState {
  dailyUsed: number;
  lifetimeUsed: number;
  dailyDate: string;
  updatedAt?: string;
}

export interface MemoryTokenBudgetKv {
  getKv(key: string): { value: unknown } | undefined;
  setKv(key: string, value: unknown, at?: string): void;
}

export class MemoryTokenBudgetLedger {
  private limits: MemoryTokenBudgetLimits;

  constructor(
    private readonly kv: MemoryTokenBudgetKv,
    private readonly now: () => Date = () => new Date(),
    limits?: Partial<MemoryTokenBudgetLimits>
  ) {
    this.limits = {
      dailyLimitM: normalizeMemoryByokLimitM(limits?.dailyLimitM, DEFAULT_MEMORY_BYOK_DAILY_LIMIT_M),
      totalLimitM: normalizeMemoryByokLimitM(limits?.totalLimitM, DEFAULT_MEMORY_BYOK_TOTAL_LIMIT_M)
    };
  }

  setLimits(limits: Partial<MemoryTokenBudgetLimits>): MemoryTokenBudgetSnapshot {
    this.limits = {
      dailyLimitM: normalizeMemoryByokLimitM(limits.dailyLimitM, this.limits.dailyLimitM),
      totalLimitM: normalizeMemoryByokLimitM(limits.totalLimitM, this.limits.totalLimitM)
    };
    return this.snapshot();
  }

  snapshot(): MemoryTokenBudgetSnapshot {
    return evaluateMemoryTokenBudget({
      ...this.limits,
      ...this.readUsage()
    });
  }

  addIfBudgeted(input: { kind?: string | null; operation?: string | null; totalTokens?: number }): MemoryTokenBudgetSnapshot {
    if (!isBudgetedMemoryUsage(input)) {
      return this.snapshot();
    }
    const tokens = Math.max(0, Math.trunc(input.totalTokens ?? 0));
    if (tokens <= 0) {
      return this.snapshot();
    }
    const usage = this.readUsage();
    return this.writeUsage({
      dailyUsed: usage.dailyUsed + tokens,
      lifetimeUsed: usage.lifetimeUsed + tokens,
      dailyDate: localCalendarDate(this.now())
    });
  }

  reconcile(remote: { dailyUsed?: number; lifetimeUsed?: number }): MemoryTokenBudgetSnapshot {
    const local = this.readUsage();
    return this.writeUsage({
      dailyUsed: Math.max(local.dailyUsed, Math.max(0, Math.trunc(remote.dailyUsed ?? 0))),
      lifetimeUsed: Math.max(local.lifetimeUsed, Math.max(0, Math.trunc(remote.lifetimeUsed ?? 0))),
      dailyDate: localCalendarDate(this.now())
    });
  }

  nextWakeAtMs(): number {
    return nextLocalMidnightMs(this.now());
  }

  private readUsage(): StoredBudgetState {
    const today = localCalendarDate(this.now());
    const stored = asStoredState(this.kv.getKv(MEMORY_BYOK_BUDGET_KV_KEY)?.value);
    if (!stored) {
      return { dailyUsed: 0, lifetimeUsed: 0, dailyDate: today };
    }
    if (stored.dailyDate !== today) {
      return { dailyUsed: 0, lifetimeUsed: stored.lifetimeUsed, dailyDate: today };
    }
    return stored;
  }

  private writeUsage(state: StoredBudgetState): MemoryTokenBudgetSnapshot {
    this.kv.setKv(MEMORY_BYOK_BUDGET_KV_KEY, {
      ...state,
      updatedAt: this.now().toISOString()
    });
    return evaluateMemoryTokenBudget({
      ...this.limits,
      dailyUsed: state.dailyUsed,
      lifetimeUsed: state.lifetimeUsed
    });
  }
}

function asStoredState(value: unknown): StoredBudgetState | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.dailyDate !== "string" || !record.dailyDate.trim()) {
    return null;
  }
  return {
    dailyUsed: Math.max(0, Math.trunc(Number(record.dailyUsed) || 0)),
    lifetimeUsed: Math.max(0, Math.trunc(Number(record.lifetimeUsed) || 0)),
    dailyDate: record.dailyDate
  };
}
