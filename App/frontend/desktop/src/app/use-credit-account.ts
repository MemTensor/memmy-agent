import { createContext, useCallback, useContext, useRef } from "react";
import type { CreditsGrant, CreditsSummary } from "@memmy/local-api-contracts";
import type { CreditsClient } from "../api/credits-client.js";
import { useOptionalApiClients } from "./providers.js";
import { useAppState } from "../state/app-state.js";
import { isCreditsPreviewMode } from "./credits-preview-mode.js";
import { useCreditRefresh } from "./use-credit-refresh.js";

export async function readCreditGrants(client: CreditsClient, cancelled = () => false, signal?: AbortSignal): Promise<CreditsGrant[]> {
  const grants: CreditsGrant[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  // shortcut: original source UI needs totals/page counts; replace with server counts before grant histories become large.
  do {
    if (cancelled() || signal?.aborted) throw new Error("Credit request cancelled");
    const query = { limit: 100, ...(cursor ? { cursor } : {}) };
    const page = await (signal ? client.grants(query, signal) : client.grants(query));
    grants.push(...page.items);
    if (!page.hasMore) return grants;
    if (!page.nextCursor || cursors.has(page.nextCursor)) throw new Error("Invalid credit pagination");
    cursor = page.nextCursor; cursors.add(cursor);
  } while (true);
}

const accountVersion = (data: { summary: CreditsSummary }) => data.summary.account.version;

export const CreditAccountContext = createContext<ReturnType<typeof useCreditAccountState>>({
  live: false, loading: false, error: null, summary: null, grants: [], reload: () => {}
});

export function useCreditAccount() {
  return useContext(CreditAccountContext);
}

/** Keep one account snapshot across page changes and all balance consumers. */
export function useCreditAccountState() {
  const { state } = useAppState();
  const { clients } = useOptionalApiClients();
  const live = !isCreditsPreviewMode() && state.bootstrap?.app.userMode === "account";
  const userId = state.account.userId;
  const client = clients?.credits;
  const latest = useRef<{ userId: string | null; client: CreditsClient; summary: CreditsSummary } | null>(null);
  const load = useCallback(async (signal: AbortSignal) => {
    if (!client) throw new Error("Credits unavailable");
    const [summary, grants] = await Promise.all([client.summary(signal), readCreditGrants(client, () => signal.aborted, signal)]);
    if (signal.aborted) throw new Error("Credit request cancelled");
    if (latest.current?.userId === userId && latest.current.client === client && summary.account.version < latest.current.summary.account.version)
      throw new Error("Stale credit account version");
    latest.current = { userId, client, summary };
    return { summary, grants };
  }, [client, userId]);
  const version = latest.current?.userId === userId && latest.current.client === client ? latest.current.summary.account.version : -1;
  const result = useCreditRefresh(load, live && !!client, userId, version, accountVersion);
  const reload = useCallback(() => { window.dispatchEvent(new Event("memmy:credits-refresh")); }, []);
  return { live, loading: live && (result.loading || (!result.data && !result.error)), error: result.error,
    summary: result.data?.summary ?? null, grants: result.data?.grants ?? [], reload };
}
