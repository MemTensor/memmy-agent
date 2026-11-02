import { useState } from "react";
import { Button } from "../components/button.js";
import { useTranslation } from "../i18n/use-translation.js";
import styles from "./settings-token-usage.module.css";

export function CreditsRedeemForm() {
  const { t } = useTranslation();
  const [code, setCode] = useState("");
  const [submitted, setSubmitted] = useState(false);

  return <form className={styles.redeemInline} onSubmit={event => { event.preventDefault(); if (code.trim()) setSubmitted(true); }}>
    <label htmlFor="credit-redemption-code">{t("credits.redeem.label")}</label>
    <input id="credit-redemption-code" value={code} onChange={event => { setCode(event.target.value); setSubmitted(false); }} placeholder={t("credits.redeem.placeholder")} autoComplete="off" />
    <Button type="submit" size="sm" variant="primary" disabled={!code.trim()}>{t("credits.redeem.action")}</Button>
    <p className={styles.redeemNote}>{t("credits.redeem.lead")}</p>
    {submitted && <p role="status" className={styles.redeemPending}>{t("credits.redeem.pending")}</p>}
  </form>;
}
