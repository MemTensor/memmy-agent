import { useCallback, useEffect, useState } from "react";
import type { CreditsGrant, CreditsSummary } from "@memmy/local-api-contracts";
import type { CreditsClient } from "../api/credits-client.js";
import { ApiRequestError } from "../api/http.js";
import { useOptionalApiClients } from "./providers.js";
import { useAppState } from "../state/app-state.js";
import { isCreditsPreviewMode } from "./credits-preview-mode.js";

export async function readCreditGrants(client: CreditsClient, cancelled = () => false): Promise<CreditsGrant[]> {
  const grants: CreditsGrant[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  // shortcut: the existing source UI needs totals and page counts; use server counts before accounts accumulate large grant histories.
  do {
    if (cancelled()) throw new Error("Credit request cancelled");
    const page = await client.grants({ limit: 100, ...(cursor ? { cursor } : {}) });
    grants.push(...page.items);
    if (!page.hasMore) return grants;
    if (!page.nextCursor || cursors.has(page.nextCursor)) throw new Error("Invalid credit pagination");
    cursor = page.nextCursor;
    cursors.add(cursor);
  } while (true);
}

/** Supplies server data to the existing credits UI; preview mode remains explicitly separate. */
export function useCreditAccount() {
  const { state } = useAppState();
  const { clients } = useOptionalApiClients();
  const live = !isCreditsPreviewMode() && state.bootstrap?.app.userMode === "account";
  const userId = state.account.userId;
  const client = clients?.credits;
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<{ userId: string | null; client: CreditsClient; summary: CreditsSummary; grants: CreditsGrant[] } | null>(null);
  const [failure, setFailure] = useState<{ userId: string | null; message: "auth" | "load" } | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(() => { window.dispatchEvent(new Event("memmy:credits-refresh")); }, []);
  useEffect(() => {
    if (!live) return;
    const refresh = () => setRevision(value => value + 1);
    window.addEventListener("memmy:credits-refresh", refresh);
    window.addEventListener("focus", refresh);
    return () => { window.removeEventListener("memmy:credits-refresh", refresh); window.removeEventListener("focus", refresh); };
  }, [live]);
  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    setLoading(true); setFailure(null);
    if (client) void Promise.all([client.summary(), readCreditGrants(client, () => cancelled)]).then(([summary, grants]) => {
      if (!cancelled) setSnapshot({ userId, client, summary, grants });
    }).catch(error => {
      if (!cancelled) setFailure({ userId, message: error instanceof ApiRequestError && error.status === 401 ? "auth" : "load" });
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [live, client, userId, revision]);
  const current = live && snapshot?.userId === userId && snapshot?.client === client ? snapshot : null;
  return { live, loading: live && (loading || (!current && !failure)),
    error: failure?.userId === userId ? failure?.message : null,
    summary: current?.summary ?? null, grants: current?.grants ?? [], reload };
}
