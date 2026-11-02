import type { ByokTokenUsageByModel, ByokTokenUsageKind, ByokTokenUsageSummary, MemoryTokenBudgetDto } from "@memmy/local-api-contracts";

const LIMITS_KEY = "memmy.modelUsagePreview.limits";

/** Only used by the explicit credits preview; never writes real model settings. */
export function modelUsagePreview(now = new Date()): { usage: ByokTokenUsageSummary; budget: MemoryTokenBudgetDto } {
  const updatedAt = now.toISOString();
  const row = (provider: string, model: string, capability: ByokTokenUsageByModel["capability"], inputTokens: number, outputTokens: number, cachedInputTokens: number, eventCount: number): ByokTokenUsageByModel => ({
    presetId: `preview-${provider}`, provider, model, capability, inputTokens, outputTokens,
    totalTokens: inputTokens + outputTokens, cachedInputTokens, cacheCreationInputTokens: 0, eventCount, updatedAt
  });
  const byModel = [
    row("openai", "gpt-5.6-sol", "agent", 1_800_000, 300_000, 600_000, 32),
    row("deepseek", "deepseek-v4.1-flash", "agent", 900_000, 150_000, 300_000, 24),
    row("dashscope", "qwen3.8-flash", "memory_summary", 2_400_000, 120_000, 800_000, 86),
    row("dashscope", "qwen3.7-plus", "memory_evolution", 1_200_000, 240_000, 200_000, 18),
    row("custom", "bge-m3", "embedding", 600_000, 0, 0, 120)
  ];
  const sum = (rows: ByokTokenUsageByModel[]) => ({
    inputTokens: rows.reduce((n, r) => n + r.inputTokens, 0),
    outputTokens: rows.reduce((n, r) => n + r.outputTokens, 0),
    totalTokens: rows.reduce((n, r) => n + r.totalTokens, 0),
    cachedInputTokens: rows.reduce((n, r) => n + r.cachedInputTokens, 0),
    cacheCreationInputTokens: 0,
    eventCount: rows.reduce((n, r) => n + r.eventCount, 0), updatedAt
  });
  const byKind = (["agent_chat", "memory_summary", "memory_evolution", "embedding"] as ByokTokenUsageKind[])
    .map(kind => ({ kind, ...sum(byModel.filter(r => r.capability === (kind === "agent_chat" ? "agent" : kind))) }));
  let dailyLimitM = 10;
  let totalLimitM = 20;
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(LIMITS_KEY) ?? "null");
    const valid = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 99_999;
    if (valid(saved?.dailyLimitM)) dailyLimitM = saved.dailyLimitM;
    if (valid(saved?.totalLimitM)) totalLimitM = saved.totalLimitM;
  } catch { /* Use the initial sample limits. */ }
  const dailyUsed = 1_360_000;
  const lifetimeUsed = sum(byModel.filter(r => r.capability !== "agent")).totalTokens;
  const trigger = totalLimitM > 0 && lifetimeUsed >= totalLimitM * 1_000_000 ? "total"
    : dailyLimitM > 0 && dailyUsed >= dailyLimitM * 1_000_000 ? "daily" : null;
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return {
    usage: { ...sum(byModel), byModel, byKind, byProvider: [] },
    budget: { dailyLimitM, totalLimitM, dailyUsed, lifetimeUsed, paused: trigger !== null, trigger, nextLocalMidnightAt: midnight.toISOString() }
  };
}

export function saveModelUsagePreviewLimits(dailyLimitM: number, totalLimitM: number) {
  window.sessionStorage.setItem(LIMITS_KEY, JSON.stringify({ dailyLimitM, totalLimitM }));
}
