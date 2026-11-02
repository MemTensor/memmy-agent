/** Plan benefits and the external upgrade application, behind the credits preview flag. */
import { useState, type MouseEvent, type ReactNode } from "react";
import { BookOpen, Brain, HardDrive, RefreshCw, Sparkles, Users } from "lucide-react";
import { Button } from "../components/button.js";
import { useTranslation } from "../i18n/use-translation.js";
import { CREDIT_GRANTS, creditCycleWindow, describeCreditPool } from "../app/credits-preview-quota.js";
import { getCreditUpgradeFormUrl } from "../app/credit-upgrade.js";
import { useCreditDemo } from "../app/use-credit-demo.js";
import { useAppState } from "../state/app-state.js";
import { appActions } from "../state/app-actions.js";
import { CreditsSettingsShell } from "./credits-in-app.js";
import { CreditInfo } from "./credits-info.js";
import { CreditsRedeemForm } from "./credits-redeem-form.js";
import styles from "./settings-token-usage.module.css";

function Benefit(props: { icon: ReactNode; children: ReactNode }) {
  return <li><span className={styles.benefitIcon}>{props.icon}</span><span>{props.children}</span></li>;
}

export function CreditsPlansPage() {
  const { t, language } = useTranslation();
  const { dispatch } = useAppState();
  const { demo, now, reload } = useCreditDemo();
  const [openError, setOpenError] = useState(false);
  const [refreshed, setRefreshed] = useState(false);
  const intl = import.meta.env.MEMMY_APP_EDITION === "intl";
  const formUrl = getCreditUpgradeFormUrl(import.meta.env.MEMMY_APP_EDITION, language);
  const currentPrice = intl ? "$0" : "¥0";
  const originalPrice = intl ? "$8.99" : "¥50";
  const pool = describeCreditPool(demo, now);
  const nextGrant = creditCycleWindow(demo, now).end.toLocaleString(language, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

  async function openForm(event: MouseEvent<HTMLAnchorElement>) {
    setOpenError(false);
    if (typeof window.memmy?.openExternal !== "function") return; // Native link in a browser.
    event.preventDefault();
    try { await window.memmy.openExternal(formUrl); }
    catch { setOpenError(true); }
  }

  return <CreditsSettingsShell><div className={`${styles.detailContent} ${styles.commercePage}`}>
    <header className={styles.commerceHeader}>
      <h1>{t("credits.plans.title")}</h1>
      <div className={styles.planStatus}>
        <p>{t("credits.plans.currentLabel", { plan: t(demo.plan === "pro" ? "plan.pro.name" : "plan.free.name") })}</p>
        <button type="button" className={styles.balanceRefresh} aria-label={t("credits.application.refresh")} title={t("credits.application.refresh")} onClick={() => { reload(); setRefreshed(true); }}><RefreshCw size={15} aria-hidden="true" /></button>
        <span className={styles.balanceLive} role="status">{refreshed ? t("credits.application.refreshed") : ""}</span>
      </div>
    </header>
    <div className={styles.entitlementGrid} aria-label={t("credits.plans.title")}>
      {(["free", "pro"] as const).map(plan => {
        const pro = plan === "pro";
        return <article key={plan} className={`${styles.entitlementCard} ${demo.plan === plan ? styles.entitlementSelected : ""}`}>
          <div className={styles.applicationPlanHeading}>
            <h2 className={styles.planName}>{t(pro ? "plan.pro.name" : "plan.free.name")}</h2>
            {demo.plan === plan && <span className={styles.applicationCurrent}>{t("credits.plans.current")}</span>}
          </div>
          <p className={styles.planSummary}>{t(pro ? "credits.plan.proSummary" : "credits.plan.freeSummary")}</p>
          <div className={styles.planPriceRow}>
            <span className={styles.planPrice}><strong>{currentPrice}</strong><span>{t("credits.plan.pricePeriod")}</span></span>
            {pro && <s className={styles.planOriginalPrice}>{t("credits.plan.originalPrice", { price: originalPrice })}</s>}
          </div>
          {pro
            ? demo.plan === "free" && <a className={`button button-primary button-md ${styles.planAction}`} href={formUrl} target="_blank" rel="noopener noreferrer" onClick={event => void openForm(event)}>{t("credits.application.open")}</a>
            : demo.plan === "free" && <Button className={styles.planAction} variant="secondary" onClick={() => dispatch(appActions.navigate("/main"))}>{t("credits.plan.useNow")}</Button>}
          {pro && openError && <p className={styles.planOpenError} role="alert">{t("credits.application.openError")}</p>}
          <ul className={styles.benefitList}>
            <Benefit icon={<Sparkles size={16} />}>{t("credits.plan.monthlyCredits", { count: CREDIT_GRANTS[plan].toLocaleString(language) })}<span className={styles.benefitValidity}>{t("credits.plan.validityMonth")}</span></Benefit>
            <Benefit icon={<Brain size={16} />}>{t("credits.plans.allModels")}</Benefit>
            <Benefit icon={<BookOpen size={16} />}>{t("credits.plan.bases", { count: pro ? 50 : 10 })}</Benefit>
            <Benefit icon={<HardDrive size={16} />}>{t("credits.plan.storage", { count: pro ? 50 : 10 })}</Benefit>
            <Benefit icon={<Users size={16} />}>{t("credits.plan.people", { count: pro ? 10 : 5 })}</Benefit>
          </ul>
        </article>;
      })}
    </div>
    {demo.plan === "pro" && <section className={styles.applicationPanel} aria-label={t("credits.balance.managePlan")}>
      <dl className={styles.applicationFacts}>
        <div><dt>{t("credits.application.planBalance")}</dt><dd>{pool.planRemaining.toLocaleString(language, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</dd></div>
        <div><dt>{t("credits.application.nextGrant")}</dt><dd>{nextGrant}</dd></div>
      </dl>
    </section>}
  </div></CreditsSettingsShell>;
}

export function CreditsRedeemPage() {
  const { t } = useTranslation();
  return <CreditsSettingsShell><div className={`${styles.detailContent} ${styles.commercePage}`}>
    <header className={styles.commerceHeader}><h1>{t("credits.redeem.title")}</h1><CreditInfo label={t("credits.info.redeemLabel")} content={t("credits.redeem.lead")} /></header>
    <CreditsRedeemForm />
  </div></CreditsSettingsShell>;
}
