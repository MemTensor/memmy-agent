// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AppBootstrapResponse, TokenUsageDto } from "@memmy/local-api-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isComputerHistoryQuotaExhausted, useComputerHistoryQuotaRefresh } from "../memory/computer-history-quota.js";

const usage = (remainingTokens: number, lastSyncedAt: string | null = "2026-09-16T00:00:00Z"): TokenUsageDto => ({
  remainingTokens, totalTokens: 100, usedTokens: 100 - remainingTokens, planName: "trial", lastSyncedAt, expiresAt: null, sceneUsages: [],
});
function bootstrap(userMode: "account" | "byok", tokenUsage: TokenUsageDto) {
  return { app: { userMode }, tokenUsage } as AppBootstrapResponse;
}
describe("Computer History account quota", () => {
  it.each([0, -10])("reports exhausted account quota with remaining=%s", (remaining) => {
    expect(isComputerHistoryQuotaExhausted(bootstrap("account", usage(remaining)))).toBe(true);
  });
  it("does not apply account quota to BYOK, unknown quota, or a positive balance", () => {
    expect(isComputerHistoryQuotaExhausted(bootstrap("byok", usage(0)))).toBe(false);
    expect(isComputerHistoryQuotaExhausted(bootstrap("account", usage(0, null)))).toBe(false);
    expect(isComputerHistoryQuotaExhausted(bootstrap("account", usage(1)))).toBe(false);
    expect(isComputerHistoryQuotaExhausted(null)).toBe(false);
  });
  it("uses the Agent budget independently from other memory scene budgets", () => {
    const total = usage(100);
    total.sceneUsages = [{ scene: "agent_chat", remainingTokens: 0, usedTokens: 100, totalTokens: 100 }];
    expect(isComputerHistoryQuotaExhausted(bootstrap("account", total))).toBe(true);
    total.remainingTokens = 0;
    total.sceneUsages[0]!.remainingTokens = 10;
    expect(isComputerHistoryQuotaExhausted(bootstrap("account", total))).toBe(false);
  });
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
beforeEach(() => { vi.useFakeTimers(); const host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); document.body.replaceChildren(); vi.useRealTimers(); });
function Harness(props: Parameters<typeof useComputerHistoryQuotaRefresh>[0]) { useComputerHistoryQuotaRefresh(props); return <p>Saved history stays visible</p>; }
describe("independent quota refresh", () => {
  it("refreshes on entry, every 30 seconds, and on focus, including replenished quota", async () => {
    const client = { getTokenUsage: vi.fn().mockResolvedValueOnce(usage(10)).mockResolvedValueOnce(usage(0)).mockResolvedValue(usage(20)) };
    const onUpdate = vi.fn();
    await act(async () => root.render(<Harness enabled client={client} onUpdate={onUpdate}/>));
    expect(onUpdate).toHaveBeenLastCalledWith(usage(10));
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(onUpdate).toHaveBeenLastCalledWith(usage(0));
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(onUpdate).toHaveBeenLastCalledWith(usage(20));
  });
  it("does not fetch for BYOK or an inactive history page", async () => {
    const client = { getTokenUsage: vi.fn() }; const onUpdate = vi.fn();
    await act(async () => root.render(<Harness enabled={false} client={client} onUpdate={onUpdate}/>));
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(client.getTokenUsage).not.toHaveBeenCalled();
  });
  it("retains the last known status and local content on a network failure", async () => {
    const client = { getTokenUsage: vi.fn().mockRejectedValue(new Error("offline")) }; const onUpdate = vi.fn();
    await act(async () => root.render(<Harness enabled client={client} onUpdate={onUpdate}/>));
    expect(onUpdate).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Saved history stays visible");
  });
  it("ignores late responses after disabling polling and avoids overlapping requests", async () => {
    let finish!: (usage: TokenUsageDto) => void;
    const client = { getTokenUsage: vi.fn(() => new Promise<TokenUsageDto>((resolve) => { finish = resolve; })) }; const onUpdate = vi.fn();
    await act(async () => root.render(<Harness enabled client={client} onUpdate={onUpdate}/>));
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(client.getTokenUsage).toHaveBeenCalledOnce();
    await act(async () => root.render(<Harness enabled={false} client={client} onUpdate={onUpdate}/>));
    await act(async () => finish(usage(0)));
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
