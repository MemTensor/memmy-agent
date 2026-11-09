import { useEffect, useState } from "react";
import type { CreditsPlans, CreditsApplication } from "@memmy/local-api-contracts";
import { useOptionalApiClients } from "./providers.js";
import { useAppState } from "../state/app-state.js";

export function useCreditPlans(live: boolean, language: "zh-CN" | "en-US") {
  const { state } = useAppState();
  const { clients } = useOptionalApiClients();
  const client = clients?.credits;
  const userId = state.account.userId;
  const region = import.meta.env.MEMMY_APP_EDITION === "intl" ? "INTL" : "CN";
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ userId: string | null; client: typeof client; language: string; plans: CreditsPlans; latest: CreditsApplication } | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!live) return;
    const refresh = () => setRevision(value => value + 1);
    window.addEventListener("memmy:credits-refresh", refresh);
    window.addEventListener("focus", refresh);
    return () => { window.removeEventListener("memmy:credits-refresh", refresh); window.removeEventListener("focus", refresh); };
  }, [live]);
  useEffect(() => {
    if (!live || !client) return;
    let cancelled = false;
    // Keep the current account snapshot during refresh so an open questionnaire is not unmounted.
    setError(false);
    void Promise.all([client.plans({ region, language }), client.latestApplication()]).then(([plans, latest]) => {
      if (!cancelled) setResult({ userId, client, language, plans, latest });
    }).catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [live, client, userId, region, language, revision]);
  const current = result?.userId === userId && result?.client === client && result?.language === language ? result : null;
  return { plans: current?.plans, latest: current?.latest, error };
}
