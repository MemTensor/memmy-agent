/** Plan benefits and the authenticated upgrade questionnaire. */
import { useState, type ReactNode } from "react";
import { BookOpen, Brain, HardDrive, RefreshCw, Sparkles, Users } from "lucide-react";
import { Button } from "../components/button.js";
import { useTranslation } from "../i18n/use-translation.js";
import { CREDIT_GRANTS, creditCycleWindow, describeCreditPool } from "../app/credits-preview-quota.js";
import { CreditApplicationModal } from "./credit-application-modal.js";
import { useCreditAccount } from "../app/use-credit-account.js";
import { formatCreditAmount } from "../app/credit-display.js";
import { isCreditsPreviewMode } from "../app/credits-preview-mode.js";
import { useCreditDemo } from "../app/use-credit-demo.js";
import { useAppState } from "../state/app-state.js";
import { appActions } from "../state/app-actions.js";
import { CreditsSettingsShell } from "./credits-in-app.js";
import { CreditInfo } from "./credits-info.js";
import { CreditsRedeemForm } from "./credits-redeem-form.js";
import styles from "./settings-token-usage.module.css";

const PLAN_KNOWLEDGE_BENEFITS = {
  free: { bases: 10, storageGiB: 10, membersPerBase: 5 },
  pro: { bases: 50, storageGiB: 50, membersPerBase: 10 },
};

function Benefit(props: { icon: ReactNode; children: ReactNode }) {
  return <li><span className={styles.benefitIcon}>{props.icon}</span><span>{props.children}</span></li>;
}

export function CreditsPlansPage() {
  const { t, language } = useTranslation();
  const { state, dispatch } = useAppState();
  const account = useCreditAccount();
  const summary = account.summary;
  const { demo, now, reload } = useCreditDemo(!account.live);
  const planCode = account.live ? summary?.plan.code.toLowerCase() : demo.plan;
  const [applicationOwner, setApplicationOwner] = useState<string | null>(null);
  const [applicationSuccess, setApplicationSuccess] = useState<string | null>(null);
  const [refreshed, setRefreshed] = useState(false);
  const intl = import.meta.env.MEMMY_APP_EDITION === "intl";
  const formType = `${intl ? "INTL" : "CN"}_${language === "en-US" ? "EN" : "ZH"}` as const;
  const currentPrice = intl ? "$0" : "¥0";
  const originalPrice = intl ? "$8.99" : "¥50";
  const pool = describeCreditPool(demo, now);
  const nextGrant = (summary ? new Date(summary.plan.cycleEnd) : creditCycleWindow(demo, now).end).toLocaleString(language, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

  return <CreditsSettingsShell><div className={`${styles.detailContent} ${styles.commercePage}`}>
    <header className={styles.commerceHeader} aria-busy={account.live && !summary && account.loading}>
      <h1>{t("credits.plans.title")}</h1>
      {planCode && <div className={styles.planStatus}>
        <p>{t("credits.plans.currentLabel", { plan: t(planCode === "pro" ? "plan.pro.name" : "plan.free.name") })}</p>
        <button type="button" className={styles.balanceRefresh} aria-label={t("credits.application.refresh")} title={t("credits.application.refresh")} onClick={() => { if (account.live) account.reload(); else reload(); setRefreshed(true); }}><RefreshCw size={15} aria-hidden="true" /></button>
        <span className={styles.balanceLive} role="status">{applicationSuccess && applicationSuccess === state.account.userId ? (language === "zh-CN" ? "已成功升级进阶版" : "Your Pro plan is active") : refreshed ? t("credits.application.refreshed") : ""}</span>
      </div>}
      {account.live && !summary && <div className={styles.planStatus}>
        <p role={account.error && !account.loading ? "alert" : "status"} title={account.error ? t(account.error === "auth" ? "credits.live.auth" : "credits.live.error") : undefined}>
          {t(account.loading ? "credits.plans.currentLoading" : "credits.plans.currentUnavailable")}
        </p>
        <button type="button" className={styles.balanceRefresh} aria-label={t("credits.balance.retry")} title={t("credits.balance.retry")} disabled={account.loading} onClick={account.reload}>
          <RefreshCw size={15} className={account.loading ? styles.creditsRefreshSpin : undefined} aria-hidden="true" />
        </button>
      </div>}
    </header>
    <div className={styles.entitlementGrid} aria-label={t("credits.plans.title")}>
      {(["free", "pro"] as const).map(plan => {
        const pro = plan === "pro";
        const benefits = PLAN_KNOWLEDGE_BENEFITS[plan];
        const monthlyCredits = CREDIT_GRANTS[plan].toLocaleString(language, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        return <article key={plan} className={`${styles.entitlementCard} ${planCode === plan ? styles.entitlementSelected : ""}`}>
          <div className={styles.applicationPlanHeading}>
            <h2 className={styles.planName}>{t(pro ? "plan.pro.name" : "plan.free.name")}</h2>
            {planCode === plan && <span className={styles.applicationCurrent}>{t("credits.plans.current")}</span>}
          </div>
          <p className={styles.planSummary}>{t(pro ? "credits.plan.proSummary" : "credits.plan.freeSummary")}</p>
          <div className={styles.planPriceRow}>
            <span className={styles.planPrice}><strong>{currentPrice}</strong><span>{t("credits.plan.pricePeriod")}</span></span>
            {pro && <s className={styles.planOriginalPrice}>{t("credits.plan.originalPrice", { price: originalPrice })}</s>}
          </div>
          {pro && (planCode === "free" || (account.live && !summary && !!account.error))
            ? <Button className={styles.planAction} onClick={() => { setApplicationSuccess(null); setApplicationOwner(state.account.userId ?? "preview"); }}>{t("credits.application.open")}</Button>
            : !pro && planCode === "free" && <Button className={styles.planAction} variant="secondary" onClick={() => dispatch(appActions.navigate("/main"))}>{t("credits.plan.useNow")}</Button>}

          <ul className={styles.benefitList}>
            <Benefit icon={<Sparkles size={16} />}>{t("credits.plan.monthlyCredits", { count: monthlyCredits })}<span className={styles.benefitValidity}>{t("credits.plan.validityMonth")}</span></Benefit>
            <Benefit icon={<Brain size={16} />}>{t("credits.plans.allModels")}</Benefit>
            <Benefit icon={<BookOpen size={16} />}>{t("credits.plan.bases", { count: benefits.bases })}</Benefit>
            <Benefit icon={<HardDrive size={16} />}>{t("credits.plan.storage", { count: benefits.storageGiB })}</Benefit>
            <Benefit icon={<Users size={16} />}>{t("credits.plan.people", { count: benefits.membersPerBase })}</Benefit>
          </ul>
        </article>;
      })}
    </div>
    {planCode === "pro" && <section className={styles.applicationPanel} aria-label={t("credits.balance.managePlan")}>
      <dl className={styles.applicationFacts}>
        <div><dt>{t("credits.application.planBalance")}</dt><dd>{summary ? formatCreditAmount(summary.balanceBySource.plan, language) : pool.planRemaining.toLocaleString(language, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</dd></div>
        <div><dt>{t("credits.application.nextGrant")}</dt><dd>{nextGrant}</dd></div>
      </dl>
    </section>}
    {applicationOwner === (state.account.userId ?? "preview") && <CreditApplicationModal key={`${applicationOwner}:${formType}`} formType={formType} live={account.live}
      onClose={() => setApplicationOwner(null)} onSuccess={() => { setApplicationOwner(null); setApplicationSuccess(state.account.userId); account.reload(); }} />}
  </div></CreditsSettingsShell>;
}

export function CreditsRedeemPage() {
  const { state } = useAppState();
  const live = !isCreditsPreviewMode() && state.bootstrap?.app.userMode === "account";
  const { t } = useTranslation();
  return <CreditsSettingsShell><div className={`${styles.detailContent} ${styles.commercePage}`}>
    <header className={styles.commerceHeader}><h1>{t("credits.redeem.title")}</h1><CreditInfo label={t("credits.info.redeemLabel")} content={t("credits.redeem.lead")} /></header>
    <CreditsRedeemForm available={!live} />
  </div></CreditsSettingsShell>;
}
