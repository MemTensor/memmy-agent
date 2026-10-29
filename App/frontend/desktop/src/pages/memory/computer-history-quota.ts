import { useEffect } from "react";
import type { AppBootstrapResponse, TokenUsageDto } from "@memmy/local-api-contracts";
import type { ConfigClient } from "../../api/config-client.js";

/** History uses the Agent model; other memory budgets cannot fund its requests. */
export function isComputerHistoryQuotaExhausted(bootstrap: AppBootstrapResponse | null | undefined): boolean {
  if (bootstrap?.app.userMode !== "account" || bootstrap.tokenUsage.lastSyncedAt == null) return false;
  const usage = bootstrap.tokenUsage;
  const remaining = usage.sceneUsages.find((item) => item.scene === "agent_chat")?.remainingTokens ?? usage.remainingTokens;
  return remaining <= 0;
}

/** Refresh account quota independently of the local history feed. */
export function useComputerHistoryQuotaRefresh(input: {
  enabled: boolean;
  client: Pick<ConfigClient, "getTokenUsage"> | null;
  onUpdate: (usage: TokenUsageDto) => void;
}): void {
  const { enabled, client, onUpdate } = input;
  useEffect(() => {
    if (!enabled || !client) return;
    let cancelled = false;
    let pending = false;
    const refresh = async () => {
      if (pending || document.visibilityState === "hidden") return;
      pending = true;
      try {
        const usage = await client.getTokenUsage();
        if (!cancelled) onUpdate(usage);
      } catch {
        // Keep the last confirmed quota and the history feed on transient errors.
      } finally { pending = false; }
    };
    const onFocus = () => { void refresh(); };
    void refresh();
    const timer = window.setInterval(onFocus, 30_000);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [enabled, client, onUpdate]);
}
