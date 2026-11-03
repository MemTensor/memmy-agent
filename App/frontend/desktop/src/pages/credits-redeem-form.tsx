import { useRef, useState } from "react";
import { Button } from "../components/button.js";
import { useTranslation } from "../i18n/use-translation.js";
import { useOptionalApiClients } from "../app/providers.js";
import { useCreditAccount } from "../app/use-credit-account.js";
import { useAppState } from "../state/app-state.js";
import styles from "./settings-token-usage.module.css";

export function CreditsRedeemForm({ available = true }: { available?: boolean }) {
  const { state } = useAppState();
  return <RedeemForm key={state.account.userId ?? "preview"} available={available} />;
}
function RedeemForm({ available }: { available: boolean }) {
  const { t } = useTranslation();
  const { clients } = useOptionalApiClients();
  const { state } = useAppState();
  const account = useCreditAccount();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const pending = useRef<{ code: string; id: string } | null>(null);
  async function submit() {
    if (!available || !code.trim() || busy) return;
    if (!account.live) { setMessage(t("credits.redeem.pending")); return; }
    if (!clients?.credits) return;
    if (pending.current?.code !== code) pending.current = { code, id: crypto.randomUUID() };
    setBusy(true); setMessage(null); setFailed(false);
    try {
      const result = await clients.credits.redeem(pending.current.id, code);
      setCode(""); pending.current = null;
      setMessage(`${result.activityName} +${result.grant.amount}`);
      window.dispatchEvent(new CustomEvent("credits.changed", { detail: { userId: state.account.userId, accountVersion: result.accountVersion } }));
      account.reload();
    } catch (error) { setFailed(true); setMessage(error instanceof Error ? error.message : t("credits.live.error")); }
    finally { setBusy(false); }
  }
  return <form className={styles.redeemInline} onSubmit={event => { event.preventDefault(); void submit(); }}>
    <label htmlFor="credit-redemption-code">{t("credits.redeem.label")}</label>
    <input id="credit-redemption-code" value={code} disabled={busy} onChange={event => { setCode(event.target.value); setMessage(null); }} placeholder={t("credits.redeem.placeholder")} autoComplete="off" maxLength={128} />
    <Button type="submit" size="sm" variant="primary" disabled={!available || busy || !code.trim()}>{t("credits.redeem.action")}</Button>
    <p className={styles.redeemNote}>{t(available ? "credits.redeem.lead" : "credits.live.redeemUnavailable")}</p>
    {message && <p role={failed ? "alert" : "status"} className={styles.redeemPending}>{message}</p>}
  </form>;
}
