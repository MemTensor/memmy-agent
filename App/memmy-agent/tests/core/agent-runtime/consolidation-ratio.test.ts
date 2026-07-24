import { describe, expect, it, vi } from "vitest";
import { Consolidator, MemoryStore } from "../../../src/core/agent-runtime/memory.js";
import { AgentDefaults } from "../../../src/config/schema.js";
import { CONTEXT_SAFETY_BUFFER_TOKENS } from "../../../src/token-budget.js";

function makeSession(turns: number): any {
  const messages: Record<string, any>[] = [];
  for (let i = 0; i < turns; i += 1) {
    messages.push({ role: "user", content: `u${i}`, timestamp: `2026-01-01T00:00:${String(i).padStart(2, "0")}` });
    messages.push({ role: "assistant", content: `a${i}`, timestamp: `2026-01-01T00:01:${String(i).padStart(2, "0")}` });
  }
  return { key: "cli:test", messages, lastConsolidated: 0, metadata: {} };
}

function makeConsolidator({
  contextWindowTokens = 200,
  consolidationRatio = 0.5,
}: {
  contextWindowTokens?: number;
  consolidationRatio?: number;
} = {}): Consolidator {
  const session = makeSession(10);
  return new Consolidator({
    store: new MemoryStore("/tmp/memmy-consolidation-ratio"),
    provider: { generation: { maxTokens: 0 } },
    model: "m",
    sessions: {
      getOrCreate: () => session,
      save: vi.fn(),
    },
    contextWindowTokens,
    consolidationRatio,
  });
}

describe("Consolidator ratio", () => {
  it("derives the input token budget from context window, completion reserve, and safety buffer", () => {
    const consolidator = new Consolidator({
      store: new MemoryStore("/tmp/memmy-consolidation-ratio"),
      provider: { generation: { maxTokens: 1000 } },
      model: "m",
      sessions: null as any,
      contextWindowTokens: 10_000,
      consolidationRatio: 0.25,
    });

    expect(consolidator.safetyBuffer).toBe(CONTEXT_SAFETY_BUFFER_TOKENS);
    expect(consolidator.inputTokenBudget).toBe(10_000 - 1000 - 4_096);
    expect(consolidator.consolidationRatio).toBe(0.25);
  });

  it("uses consolidationRatio to control the target token budget", async () => {
    const cases = [
      { ratio: 0.5, contextWindowTokens: 200, estimates: [250, 90], expectedArchives: 1 },
      { ratio: 0.1, contextWindowTokens: 1000, estimates: [1200, 800, 400, 50], expectedArchives: 2 },
      { ratio: 0.9, contextWindowTokens: 200, estimates: [300, 175], expectedArchives: 1 },
    ];

    for (const item of cases) {
      const session = makeSession(10);
      const consolidator = new Consolidator({
        store: new MemoryStore(`/tmp/memmy-consolidation-ratio-${item.ratio}`),
        provider: { generation: { maxTokens: 0 } },
        model: "m",
        sessions: {
          getOrCreate: () => session,
          save: vi.fn(),
        },
        contextWindowTokens: item.contextWindowTokens,
        consolidationRatio: item.ratio,
      });
      consolidator.safetyBuffer = 0;
      const remaining = [...item.estimates];
      const boundariesLeft = { value: item.expectedArchives };
      const boundaryTokens: number[] = [];
      consolidator.estimateSessionPromptTokens = vi.fn(
        (): [number, string] => [remaining.shift() ?? 0, "test"],
      );
      consolidator.pickConsolidationBoundary = vi.fn((freshSession: any, tokensToRemove: number): [number, number] | null => {
        boundaryTokens.push(tokensToRemove);
        if (boundariesLeft.value <= 0) return null;
        boundariesLeft.value -= 1;
        return [Math.min(freshSession.messages.length, (freshSession.lastConsolidated ?? 0) + 2), tokensToRemove];
      });
      consolidator.archive = vi.fn(async () => "summary");

      await consolidator.maybeConsolidateByTokens(session);

      expect(consolidator.archive).toHaveBeenCalledTimes(item.expectedArchives);
      expect(boundaryTokens[0]).toBe(item.estimates[0] - Math.floor(item.contextWindowTokens * item.ratio));
    }
  });

  it("propagates consolidationRatio through AgentDefaults", () => {
    const defaults = new AgentDefaults();
    expect(defaults.consolidationRatio).toBe(0.5);

    const configured = AgentDefaults.fromObject({ consolidationRatio: 0.3 });

    expect(configured.consolidationRatio).toBe(0.3);
    expect(configured.toObject().consolidationRatio).toBe(0.3);
  });

  it("rejects consolidation ratios outside the configured range", () => {
    expect(() => new AgentDefaults({ consolidationRatio: 0.05 })).toThrow(
      "consolidationRatio must be between 0.1 and 0.95",
    );
    expect(() => new AgentDefaults({ consolidationRatio: 1.0 })).toThrow(
      "consolidationRatio must be between 0.1 and 0.95",
    );
  });
});
