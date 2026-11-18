/** Plan benefits and the authenticated upgrade questionnaire. */
import { useState, type ReactNode } from "react";
import { BookOpen, Brain, HardDrive, RefreshCw, Sparkles, Users } from "lucide-react";
import { Button } from "../components/button.js";
import { useTranslation } from "../i18n/use-translation.js";
import { CREDIT_GRANTS, creditCycleWindow, describeCreditPool } from "../app/credits-preview-quota.js";
import { CreditApplicationModal } from "./credit-application-modal.js";
import { useCreditPlans } from "../app/use-credit-plans.js";
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

function Benefit(props: { icon: ReactNode; children: ReactNode }) {
  return <li><span className={styles.benefitIcon}>{props.icon}</span><span>{props.children}</span></li>;
}

export function CreditsPlansPage() {
  const { t, language } = useTranslation();
  const { state, dispatch } = useAppState();
  const account = useCreditAccount();
  const { demo, now, reload } = useCreditDemo(!account.live);
  const catalog = useCreditPlans(account.live, language);
  const planCode = account.live ? catalog.plans?.currentPlan.toLowerCase() : demo.plan;
  const [applicationOwner, setApplicationOwner] = useState<string | null>(null);
  const [applicationSuccess, setApplicationSuccess] = useState<string | null>(null);
  const [refreshed, setRefreshed] = useState(false);
  const intl = import.meta.env.MEMMY_APP_EDITION === "intl";
  const formType = catalog.plans?.application.formType ?? `${intl ? "INTL" : "CN"}_${language === "en-US" ? "EN" : "ZH"}` as const;
  const canApply = !account.live || Boolean(catalog.plans?.application.eligible);
  const currentPrice = intl ? "$0" : "¥0";
  const originalPrice = intl ? "$8.99" : "¥50";
  const pool = describeCreditPool(demo, now);
  const nextGrant = (account.summary ? new Date(account.summary.plan.cycleEnd) : creditCycleWindow(demo, now).end).toLocaleString(language, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

  if (account.live && (!account.summary || !catalog.plans)) return <CreditsSettingsShell><p role={account.error || catalog.error ? "alert" : "status"}>{t(account.error === "auth" ? "credits.live.auth" : account.error || catalog.error ? "credits.live.error" : "credits.live.loading")}</p>{(account.error || catalog.error) && <Button onClick={account.reload}>{t("credits.live.retry")}</Button>}</CreditsSettingsShell>;
  return <CreditsSettingsShell><div className={`${styles.detailContent} ${styles.commercePage}`}>
    <header className={styles.commerceHeader}>
      <h1>{t("credits.plans.title")}</h1>
      <div className={styles.planStatus}>
        <p>{t("credits.plans.currentLabel", { plan: t(planCode === "pro" ? "plan.pro.name" : "plan.free.name") })}</p>
        <button type="button" className={styles.balanceRefresh} aria-label={t("credits.application.refresh")} title={t("credits.application.refresh")} onClick={() => { if (account.live) account.reload(); else reload(); setRefreshed(true); }}><RefreshCw size={15} aria-hidden="true" /></button>
        <span className={styles.balanceLive} role="status">{applicationSuccess && applicationSuccess === state.account.userId ? (language === "zh-CN" ? "已成功升级进阶版" : "Your Pro plan is active") : refreshed ? t("credits.application.refreshed") : ""}</span>
      </div>
    </header>
    <div className={styles.entitlementGrid} aria-label={t("credits.plans.title")}>
      {(["free", "pro"] as const).map(plan => {
        const pro = plan === "pro";
        const definition = catalog.plans?.plans.find(value => value.code.toLowerCase() === plan);
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
          {pro
            ? planCode === "free" && <Button className={styles.planAction} disabled={!canApply} onClick={() => { setApplicationSuccess(null); setApplicationOwner(state.account.userId ?? "preview"); }}>{t("credits.application.open")}</Button>
            : planCode === "free" && <Button className={styles.planAction} variant="secondary" onClick={() => dispatch(appActions.navigate("/main"))}>{t("credits.plan.useNow")}</Button>}

          <ul className={styles.benefitList}>
            <Benefit icon={<Sparkles size={16} />}>{t("credits.plan.monthlyCredits", { count: definition ? formatCreditAmount(definition.cycleGrant, language) : CREDIT_GRANTS[plan].toLocaleString(language) })}<span className={styles.benefitValidity}>{t("credits.plan.validityMonth")}</span></Benefit>
            <Benefit icon={<Brain size={16} />}>{t("credits.plans.allModels")}</Benefit>
            <Benefit icon={<BookOpen size={16} />}>{t("credits.plan.bases", { count: definition?.knowledgeEntitlement.baseLimit ?? (pro ? 50 : 10) })}</Benefit>
            <Benefit icon={<HardDrive size={16} />}>{t("credits.plan.storage", { count: definition ? definition.knowledgeEntitlement.storageBytes / 1024 ** 3 : (pro ? 50 : 10) })}</Benefit>
            <Benefit icon={<Users size={16} />}>{t("credits.plan.people", { count: definition?.knowledgeEntitlement.membersPerBase ?? (pro ? 10 : 5) })}</Benefit>
          </ul>
        </article>;
      })}
    </div>
    {planCode === "pro" && <section className={styles.applicationPanel} aria-label={t("credits.balance.managePlan")}>
      <dl className={styles.applicationFacts}>
        <div><dt>{t("credits.application.planBalance")}</dt><dd>{account.summary ? formatCreditAmount(account.summary.balanceBySource.plan, language) : pool.planRemaining.toLocaleString(language, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</dd></div>
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
