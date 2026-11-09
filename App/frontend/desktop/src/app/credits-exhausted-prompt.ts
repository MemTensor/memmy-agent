import { useEffect, useState } from "react";
import type { MemmyAgentModelError } from "../api/memmy-agent-client.js";

/** Shared signal for actual credit failures and explicit previews. */
export const CREDITS_EXHAUSTED_PROMPT_EVENT = "memmy:credits-exhausted-prompt";

export function requestCreditsExhaustedPrompt(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(CREDITS_EXHAUSTED_PROMPT_EVENT));
  }
}

/** URL-only preview trigger; never opens the dialog in the ordinary product. */
export function hasCreditsExhaustedPreview(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.get("credits-preview") === "1" && params.has("credits-exhausted");
}

/** Platform credits and a provider's own quota are separate balances. */
export function isAgentCreditsError(content: string, error?: MemmyAgentModelError | null): boolean {
  if (error?.source === "byok") return false;
  return /\bCREDIT_INSUFFICIENT\b/i.test(`${content}\n${error?.detail ?? ""}`)
    || (error?.category === "quota_exhausted"
      && (error.source === "account" || error.failedProvider === "memmy_account" || error.provider === "memmy_account"));
}


export function useCreditsExhaustedPrompt(input: {
  enabled: boolean; userId: string | null; balance?: string; spendable?: string; preview: boolean;
}) {
  const scope = input.enabled ? input.userId ?? (input.preview ? "preview" : null) : null;
  const [shownFor, setShownFor] = useState<string | null>(() => input.preview ? scope : null);
  useEffect(() => {
    if (!scope) { setShownFor(null); return; }
    // Settlement may reach zero while a successful call is still finishing its tools.
    // Only a denied call opens the dialog; refreshed spendable funding can dismiss it.
    if (Number(input.balance) > 0 && Number(input.spendable ?? input.balance) > 0) setShownFor(null);
  }, [scope, input.balance, input.spendable]);
  useEffect(() => {
    if (!scope) return;
    const show = () => setShownFor(scope);
    window.addEventListener(CREDITS_EXHAUSTED_PROMPT_EVENT, show);
    return () => window.removeEventListener(CREDITS_EXHAUSTED_PROMPT_EVENT, show);
  }, [scope]);
  return { open: scope !== null && shownFor === scope, dismiss: () => setShownFor(null) };
}
