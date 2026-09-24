import { describe, expect, it } from "vitest";
import { localCalendarDate } from "@memmy/agent-source-core";
import {
  MEMORY_BYOK_BUDGET_KV_KEY,
  MemoryTokenBudgetLedger
} from "../../src/service/memory-token-budget-ledger.js";

describe("MemoryTokenBudgetLedger", () => {
  it("counts only budgeted usage and resets the daily total on a new local date", () => {
    const store = new Map<string, unknown>();
    let now = new Date(2026, 8, 18, 23, 50);
    const ledger = new MemoryTokenBudgetLedger(
      {
        getKv(key) {
          return store.has(key) ? { value: store.get(key) } : undefined;
        },
        setKv(key, value) {
          store.set(key, value);
        }
      },
      () => now,
      { dailyLimitM: 10, totalLimitM: 500 }
    );

    expect(ledger.addIfBudgeted({
      kind: "embedding",
      operation: "embedding.query",
      totalTokens: 1_677_000
    }).dailyUsed).toBe(0);
    expect(ledger.addIfBudgeted({
      kind: "memory_summary",
      operation: "episode_title.final",
      totalTokens: 500_000
    })).toMatchObject({ dailyUsed: 500_000, lifetimeUsed: 500_000, paused: false });

    now = new Date(2026, 8, 19, 0, 1);
    expect(ledger.snapshot()).toMatchObject({
      dailyUsed: 0,
      lifetimeUsed: 500_000,
      paused: false
    });
    expect(localCalendarDate(now)).toBe("2026-09-19");
    expect(store.get(MEMORY_BYOK_BUDGET_KV_KEY)).toMatchObject({
      dailyUsed: 500_000,
      dailyDate: "2026-09-18"
    });
  });

  it("keeps the larger of local and remote totals when reconciling", () => {
    const store = new Map<string, unknown>();
    const ledger = new MemoryTokenBudgetLedger(
      {
        getKv(key) {
          return store.has(key) ? { value: store.get(key) } : undefined;
        },
        setKv(key, value) {
          store.set(key, value);
        }
      },
      () => new Date(2026, 8, 18, 12),
      { dailyLimitM: 10, totalLimitM: 500 }
    );
    ledger.addIfBudgeted({
      kind: "memory_evolution",
      operation: "l3_world_model.project_contract",
      totalTokens: 2_000_000
    });

    expect(ledger.reconcile({ dailyUsed: 3_000_000, lifetimeUsed: 1_000_000 })).toMatchObject({
      dailyUsed: 3_000_000,
      lifetimeUsed: 2_000_000
    });

    expect(ledger.addIfBudgeted({
      kind: "memory_summary",
      operation: "episode_title.final",
      totalTokens: 300
    })).toMatchObject({
      dailyUsed: 3_000_300,
      lifetimeUsed: 2_000_300
    });
    expect(ledger.reconcile({ dailyUsed: 3_000_000, lifetimeUsed: 2_000_000 })).toMatchObject({
      dailyUsed: 3_000_300,
      lifetimeUsed: 2_000_300
    });
  });
});
