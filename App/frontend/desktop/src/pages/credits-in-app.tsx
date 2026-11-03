/** Credits balance, plans, and check-in, using the settings usage visual language. */
import { useState, type ReactNode } from "react";
import { ArrowLeft, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, Coins, Gift, RefreshCw, X } from "lucide-react";
import { Button } from "../components/button.js";
import { useTranslation } from "../i18n/use-translation.js";
import { appActions } from "../state/app-actions.js";
import { useAppState } from "../state/app-state.js";
import {
  CHECKIN_DAILY,
  creditCycleWindow,
  type CreditBucket,
  type CreditSource,
  claimCheckin,
  creditCycleKey,
  describeCheckin,
  describeCreditPool,
  formatDayKey,
  isCreditLow,
} from "../app/credits-preview-quota.js";
import type { CreditsGrant } from "@memmy/local-api-contracts";
import { useCreditAccount } from "../app/use-credit-account.js";
import { creditDisplayBuckets, creditMinor, creditUsagePercent, formatCreditAmount, formatCreditMinor } from "../app/credit-display.js";
import { useCreditDemo } from "../app/use-credit-demo.js";
import { AppFrame } from "./app-frame.js";
import { writeSettingsTabHash, type SettingsTabId } from "./settings-nav.js";
import { CreditsUsageLedger } from "./credits-usage-ledger.js";
import { CreditsRedeemForm } from "./credits-redeem-form.js";
import type { AppRoutePath } from "../app/routes.js";
import usageStyles from "./settings-token-usage.module.css";

const LOW_DISMISS_KEY = "memmy.creditsPreview.lowDismissedCycle";


function formatCredits(value: number, language: string): string {
  return value.toLocaleString(language === "en-US" ? "en-US" : "zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function formatStamp(date: Date): string {
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function openSettingsTab(dispatch: ReturnType<typeof useAppState>["dispatch"], tab: SettingsTabId) {
  writeSettingsTabHash(tab);
  dispatch(appActions.navigate("/settings"));
}

export function CreditsSettingsShell(props: { children: ReactNode; backRoute?: AppRoutePath; backLabel?: string }) {
  const { dispatch } = useAppState();
  const { t } = useTranslation();
  return (
    <AppFrame
      title={t("settings.title")}
      settingsNav={{
        activeTab: "tokens",
        onSelectTab: (tab) => openSettingsTab(dispatch, tab)
      }}
    >
      <div className="settings-page h-full overflow-y-auto">
        <div className={`app-frame-page-content ${usageStyles.commerceShell}`}>
          <button
            type="button"
            onClick={() => props.backRoute ? dispatch(appActions.navigate(props.backRoute)) : openSettingsTab(dispatch, "tokens")}
            className="mb-6 inline-flex items-center gap-1 text-xs text-text-ink/55 hover:text-text-ink cursor-pointer"
          >
            <ArrowLeft size={14} aria-hidden="true" />
            {props.backLabel ?? t("credits.balance.title")}
          </button>
          {props.children}
        </div>
      </div>
    </AppFrame>
  );
}

function creditDate(value: string, language: string): string {
  return new Date(value).toLocaleString(language, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

/** Presentation groups keep the account's source totals and show individual grants on demand. */
export function CreditSourceDetails(props: { source: CreditSource; buckets: CreditBucket[]; grants?: CreditsGrant[]; pageSize: number; onPageSizeChange: (size: number) => void; nextGrant?: string; planName?: string; action?: ReactNode; showAll?: boolean; period?: "valid" | "expired" }) {
  const { t, language } = useTranslation();
  const [page, setPage] = useState(1);
  const expired = props.period === "expired";
  const buckets = creditDisplayBuckets(props.buckets, props.grants).sort((a, b) => {
    if (expired) return Date.parse(b.expiresAt!) - Date.parse(a.expiresAt!);
    const expiryA = a.expiresAt ? Date.parse(a.expiresAt) : Infinity;
    const expiryB = b.expiresAt ? Date.parse(b.expiresAt) : Infinity;
    return expiryA - expiryB || Date.parse(a.grantedAt) - Date.parse(b.grantedAt);
  });
  const remaining = buckets.reduce((sum, bucket) => sum + bucket.remaining, 0n);
  const pageSize = props.pageSize;
  const totalPages = Math.max(1, Math.ceil(buckets.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const visible = buckets.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const icon = props.source === "plan" ? <CalendarDays size={16} /> : <Gift size={16} />;
  return <article className={`${usageStyles.sourceCard} ${expired ? usageStyles.expiredSource : ""}`} aria-label={expired ? t("credits.detail.expired") : t(`credits.source.${props.source}`)}>
    <header className={usageStyles.sourceCardHeader}>
      <div className={usageStyles.sourceIdentity}>
        <span className={usageStyles.sourceIcon} aria-hidden="true">{icon}</span>
        <div><h3>{props.period ? t(expired ? "credits.detail.expired" : "credits.detail.valid") : t(`credits.source.${props.source}`)}{props.planName && <span className={usageStyles.sourcePlanTag}>{props.planName}</span>}</h3>
          {props.nextGrant && <p>{t("credits.detail.nextGrant", { time: creditDate(props.nextGrant, language) })}</p>}
        </div>
      </div>
      <div className={usageStyles.sourceHeaderEnd}>
        <div className={usageStyles.sourceRemaining}><span>{t(expired ? "credits.detail.expiredCredits" : "credits.detail.remaining")}</span><strong>{expired && buckets.some(bucket => !bucket.usageKnown) ? "—" : formatCreditMinor(remaining, language)}</strong></div>
        {props.action}
      </div>
    </header>
    {buckets.length === 0
      ? <p className={usageStyles.sourceEmpty}>{t(expired ? "credits.detail.noExpired" : props.source === "reward" ? "credits.detail.noRewards" : "credits.source.empty")}</p>
      : <ul className={usageStyles.sourceBatches}>{visible.map(bucket => {
        const used = bucket.granted - bucket.remaining;
        const usedPercent = bucket.usageKnown ? creditUsagePercent(used, bucket.granted) : 0;
        const label = bucket.id.startsWith("checkin:") ? t("credits.detail.checkinReward")
          : bucket.id.startsWith("invite:") ? t("credits.detail.inviteReward")
          : bucket.id.startsWith("redeem:") ? t("credits.detail.redeemReward")
          : bucket.id === "legacy-preview-reward" || bucket.id.startsWith("history:") ? t("credits.detail.historyReward")
          : t("credits.source.reward");
        return <li className={usageStyles.sourceBatch} key={bucket.id}>
          <div className={usageStyles.batchHeading}><strong>{bucket.label ?? label}</strong>{bucket.invitation && <span className={usageStyles.batchInviteTime}>{t("credits.detail.granted", {time:creditDate(bucket.grantedAt,language)})}</span>}</div>
          <div className={usageStyles.batchUsage}>
            <span>{bucket.expiresAt ? t("credits.detail.expiryTime", {time:creditDate(bucket.expiresAt,language)}) : t("credits.source.noExpiry")}</span>
            <span>{t("credits.detail.usedAmount", {used:bucket.usageKnown ? formatCreditMinor(used,language) : "—",total:formatCreditMinor(bucket.granted,language)})}</span>
          </div>
          <div className={usageStyles.sourceMeter} role="progressbar" aria-label={t("credits.detail.usedProgress")} aria-valuenow={bucket.usageKnown ? Math.round(usedPercent) : undefined} aria-valuetext={bucket.usageKnown ? undefined : "—"} aria-valuemin={0} aria-valuemax={100}>
            <span style={{width:`${usedPercent}%`}} />
          </div>
        </li>;
      })}</ul>}
    <nav className={usageStyles.creditPagination} aria-label={t("credits.detail.pagination")}>
      <div className={usageStyles.creditPaginationSummary}>
        <span>{t("credits.detail.recordCount", { count: buckets.length })}</span>
        <label>{t("credits.detail.pageSizeLabel")}
          <span className={usageStyles.creditPageSizeSelect}>
            <select value={pageSize} onChange={event => { setPage(1); props.onPageSizeChange(Number(event.target.value)); }}>
              {[10, 20, 50].map(size => <option key={size} value={size}>{size}</option>)}
            </select>
            <ChevronDown size={12} aria-hidden="true" />
          </span>
          {t("credits.detail.pageSizeUnit")}
        </label>
      </div>
      <div className={usageStyles.creditPaginationControls}>
        <Button type="button" size="sm" variant="secondary" aria-label={t("credits.detail.previousPage")} disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={14} /></Button>
        <span aria-live="polite">{currentPage} / {totalPages}</span>
        <Button type="button" size="sm" variant="secondary" aria-label={t("credits.detail.nextPage")} disabled={currentPage === totalPages} onClick={() => setPage(currentPage + 1)}><ChevronRight size={14} /></Button>
      </div>
    </nav>
  </article>;
}

function CreditSourceSummary(props: { source: CreditSource; buckets: CreditBucket[]; grants?: CreditsGrant[]; nextGrant: string }) {
  const { t, language } = useTranslation();
  const { dispatch } = useAppState();
  const buckets = creditDisplayBuckets(props.buckets, props.grants);
  const remaining = buckets.reduce((sum, b) => sum + b.remaining, 0n);
  const granted = buckets.reduce((sum, b) => sum + b.granted, 0n);
  const used = granted - remaining;
  const usedPercent = creditUsagePercent(used, granted);
  const expiring = buckets.filter(b => b.remaining > 0 && b.expiresAt).sort((a, b) => Date.parse(a.expiresAt!) - Date.parse(b.expiresAt!));
  const expiry = expiring[0]?.expiresAt;
  const note = props.source === "plan" ? t("credits.detail.nextRefresh", { time: creditDate(props.nextGrant, language) })
    : expiry ? t("credits.detail.nearestExpiry", { time: creditDate(expiry, language) })
    : remaining > 0 ? t("credits.source.noExpiry") : t("credits.detail.noRewards");
  return <article className={usageStyles.sourceSummary} aria-label={t(`credits.source.${props.source}`)}>
    <header className={usageStyles.sourceCardHeader}>
      <h3>{props.source === "plan" ? t("credits.source.plan") : <button type="button" className={usageStyles.sourceTitleLink} onClick={() => dispatch(appActions.navigate("/credit-reward-details"))}>
        {t(`credits.source.${props.source}`)}<ChevronRight size={16} aria-hidden="true" />
      </button>}</h3>
    </header>
    <div className={usageStyles.sourceSummaryInfo}>
      <span>{note}</span>
      <div className={usageStyles.sourceSummaryMetrics}><span>{t("credits.detail.usedOf", { used: formatCreditMinor(used, language), total: formatCreditMinor(granted, language) })}</span></div>
    </div>
    {granted > 0 && <div className={usageStyles.sourceMeter} role="progressbar" aria-label={t("credits.detail.usedProgress")} aria-valuenow={Math.round(usedPercent)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${usedPercent}%` }} /></div>}
  </article>;
}

export function CreditsSourceDetailPage(props: { source: "reward" }) {
  const { t } = useTranslation();
  const account = useCreditAccount();
  const { demo, now } = useCreditDemo(!account.live);
  const [period, setPeriod] = useState<"valid" | "expired">("valid");
  const [pageSize, setPageSize] = useState(10);
  const buckets = demo.buckets.filter(b => b.source === props.source && Date.parse(b.grantedAt) <= now.getTime());
  const expired = buckets.filter(b => b.expiresAt !== null && Date.parse(b.expiresAt) <= now.getTime());
  const valid = buckets.filter(b => b.expiresAt === null || Date.parse(b.expiresAt) > now.getTime());
  const rewardGrants = account.grants.filter(grant => grant.sourceType !== "PLAN" && grant.status !== "REVOKED");
  const visibleGrants = rewardGrants.filter(grant => (grant.status === "EXPIRED") === (period === "expired"));
  if (account.live && !account.summary) return <CreditsSettingsShell><CreditAccountStatus account={account} /></CreditsSettingsShell>;
  return <CreditsSettingsShell><div className={`${usageStyles.detailContent} ${usageStyles.commercePage}`}>
    <header className={usageStyles.commerceHeader}><h1>{t("credits.detail.rewardTitle")}</h1></header>
    <div className={usageStyles.creditTabs} role="tablist" aria-label={t("credits.detail.validity")}>
      {(["valid", "expired"] as const).map(value => <button key={value} type="button" role="tab" id={`credits-tab-${value}`} aria-selected={period === value} aria-controls="credits-source-panel" tabIndex={period === value ? 0 : -1} onClick={() => setPeriod(value)} onKeyDown={event => {
        if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const next = event.key === "Home" ? "valid" : event.key === "End" ? "expired" : value === "valid" ? "expired" : "valid";
          setPeriod(next);
          document.getElementById(`credits-tab-${next}`)?.focus();
        }
      }}>{t(value === "valid" ? "credits.detail.valid" : "credits.detail.expired")}</button>)}
    </div>
    <div role="tabpanel" id="credits-source-panel" aria-labelledby={`credits-tab-${period}`}>
      <CreditSourceDetails key={`${props.source}:${period}`} source={props.source} buckets={period === "valid" ? valid : expired} grants={account.live ? visibleGrants : undefined} period={period} pageSize={pageSize} onPageSizeChange={setPageSize} />
    </div>
  </div></CreditsSettingsShell>;
}

function CreditAccountStatus({ account }: { account: ReturnType<typeof useCreditAccount> }) {
  const { t } = useTranslation();
  return <div role={account.error ? "alert" : "status"}>
    <p>{t(account.error === "auth" ? "credits.live.auth" : account.error ? "credits.live.error" : "credits.live.loading")}</p>
    {account.error && <Button size="sm" variant="secondary" onClick={account.reload}>{t("credits.live.retry")}</Button>}
  </div>;
}

/** Original credits layout, with server data in account mode. */
export function CreditsSettingsPanel(props: { invitationContent?: ReactNode }) {
  const { dispatch } = useAppState();
  const { language, t } = useTranslation();
  const account = useCreditAccount();
  const { demo, reload, now } = useCreditDemo(!account.live);
  const [refreshing, setRefreshing] = useState(false);
  const [redeemOpen, setRedeemOpen] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const cycleKey = account.summary?.plan.cycleStart ?? creditCycleKey(demo, now);
  const [dismissedCycle, setDismissedCycle] = useState(() => (
    typeof window !== "undefined" ? window.sessionStorage.getItem(LOW_DISMISS_KEY) : null
  ));
  const lowDismissed = dismissedCycle === cycleKey;
  const pool = describeCreditPool(demo, now);
  const low = account.live ? !!account.summary && creditMinor(account.summary.account.spendable) * 10n < creditMinor(account.summary.plan.nextCycleGrant) : isCreditLow(pool);
  const plan = account.live ? account.summary?.plan.code.toLowerCase() : demo.plan;
  const resetAt = account.summary?.plan.cycleEnd ?? creditCycleWindow(demo, now).end.toISOString();
  const activeGrants = account.grants.filter(grant => grant.status !== "EXPIRED" && grant.status !== "REVOKED");


  function dismissLow() {
    window.sessionStorage.setItem(LOW_DISMISS_KEY, cycleKey);
    setDismissedCycle(cycleKey);
  }

  function refreshBalance() {
    if (account.live) { account.reload(); setRefreshedAt(new Date()); return; }
    if (refreshing) return;
    setRefreshing(true);
    window.setTimeout(() => {
      reload();
      setRefreshedAt(new Date());
      setRefreshing(false);
    }, 450);
  }

  if (account.live && !account.summary) return <div id="credits-balance" className={usageStyles.detailContent}><CreditAccountStatus account={account} /></div>;

  return (
    <div id="credits-balance" className={`${usageStyles.detailContent} ${usageStyles.balancePage}`}>
      <section className={usageStyles.usageSection}>
        <div className={usageStyles.sectionHead}>
          <h2>
            <Coins size={16} className="text-text-ink/60" aria-hidden="true" />
            {t("credits.balance.title")}
          </h2>

        </div>


        {low && !lowDismissed && (
          <p className={usageStyles.creditLowLine}>
            <span>{t("credits.low")}</span>
            <button type="button" onClick={() => dispatch(appActions.navigate("/plans"))}>{t(plan === "pro" ? "credits.balance.managePlan" : "credits.upgrade")}</button>
            <button type="button" onClick={dismissLow}>{t("credits.low.dismiss")}</button>
          </p>
        )}

        <div className={usageStyles.balanceHero}>
          <div className={usageStyles.balanceHeroTop}>
            <strong className={usageStyles.balancePlan}>{t(plan === "pro" ? "plan.pro.name" : "plan.free.name")}</strong>
            <button type="button" className={usageStyles.balanceEntryButton} onClick={() => dispatch(appActions.navigate("/plans"))}>
              {t(plan === "pro" ? "credits.balance.managePlan" : "credits.balance.upgrade")}
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          </div>
          <div className={usageStyles.balanceHeroBody}>
            <div className={usageStyles.balanceAmount}>
              <strong>{account.summary ? formatCreditAmount(account.summary.account.balance, language) : formatCredits(pool.totalRemaining, language)}</strong>
              <span>{t("credits.balance.total")}</span>
              <button type="button" className={usageStyles.balanceRefresh} onClick={refreshBalance} disabled={refreshing} aria-label={t(refreshing ? "credits.refreshing" : "credits.refresh")} title={refreshedAt ? t("credits.refreshed", {time:formatStamp(refreshedAt)}) : t("credits.refresh")}>
                <RefreshCw size={15} className={refreshing ? usageStyles.creditsRefreshSpin : undefined} aria-hidden="true" />
              </button>
            </div>
            <dl className={`${usageStyles.balanceBreakdown} ${usageStyles.balanceBreakdownIntl}`}>
              {([ ["plan",pool.planRemaining], ["reward",pool.rewardRemaining] ] as const).map(([source,value]) => (
                <div key={source}><dt>{t(`credits.source.${source}`)}</dt><dd>{account.summary ? formatCreditAmount(account.summary.balanceBySource[source], language) : formatCredits(value,language)}</dd></div>
              ))}
            </dl>
          </div>
          <span className={usageStyles.balanceLive} role="status">{refreshedAt ? t("credits.refreshed", {time:formatStamp(refreshedAt)}) : ""}</span>
        </div>
      </section>

      {props.invitationContent}

      <section className={usageStyles.usageSection}>
        <div className={usageStyles.sectionHead}>
          <h2>{t("credits.detail.title")}</h2>
          <Button type="button" size="sm" variant="secondary" aria-expanded={redeemOpen} aria-controls="credits-redeem-panel" onClick={() => setRedeemOpen(open => !open)}>{t("credits.redeem.title")}</Button>
        </div>
        {redeemOpen && <div id="credits-redeem-panel"><CreditsRedeemForm available={!account.live} /></div>}
        <div className={usageStyles.sourceSummaryList}>
          {(["plan", "reward"] as const).map(source => <CreditSourceSummary
            key={source} source={source} buckets={pool.buckets.filter(bucket => bucket.source === source)}
            grants={account.live ? activeGrants.filter(grant => (grant.sourceType === "PLAN" ? "plan" : "reward") === source) : undefined}
            nextGrant={resetAt}
          />)}
        </div>
      </section>

      <CreditsUsageLedger live={account.live} />
    </div>
  );
}

/** Check-in on the home screen. Claiming here uses the same preview balance as the check-in page. */
export function HomeCheckinCard(props: { compact?: boolean; dismissible?: boolean }) {
  const { language, t } = useTranslation();
  const { demo, update, now } = useCreditDemo();
  const today = formatDayKey(now);
  const view = describeCheckin(demo, today);
  const [dismissedOn, setDismissedOn] = useState<string | null>(() => {
    try { return window.localStorage.getItem("memmy.home.checkinDismissedOn"); } catch { return null; }
  });

  function dismiss() {
    const date = formatDayKey(new Date());
    setDismissedOn(date);
    try { window.localStorage.setItem("memmy.home.checkinDismissedOn", date); } catch { /* Keep this visit dismissed when storage is unavailable. */ }
  }

  function claim() {
    update(current => claimCheckin(current, formatDayKey(new Date())));
  }

  if (props.compact) {
    if (view.claimedToday) {
      return null;
    }
    return (
      <Button type="button" variant="primary" size="sm" className={usageStyles.creditsAction} onClick={claim} style={{ marginRight: 8 }}>
        {t("credits.checkin.compactAction", { n: String(CHECKIN_DAILY) })}
      </Button>
    );
  }

  if (props.dismissible && dismissedOn === today) return null;

  return (
    <div className={`home-checkin${view.claimedToday ? " home-checkin--claimed" : ""}`}>
      <span className="home-checkin__mark" aria-hidden="true">
        {view.claimedToday ? <Check size={16} strokeWidth={1.8} /> : <CalendarDays size={16} strokeWidth={1.6} />}
      </span>
      <div className="home-checkin__main" role={view.claimedToday ? "status" : undefined}>
        <p className="home-checkin__title">{t(view.claimedToday ? "credits.checkin.done" : "credits.checkin.title")}</p>
        <p className="home-checkin__reward">
          <strong>+{CHECKIN_DAILY.toLocaleString(language)}</strong>
          <span>{view.claimedToday ? t("credits.checkin.received") : t("credits.unit")}</span>
        </p>
      </div>
      {view.claimedToday ? (
        <span className="home-checkin__done">{t("credits.checkin.streakReceived", { n: String(view.filled) })}</span>
      ) : (
        <button type="button" className="home-checkin__action" onClick={claim}>
          {t("credits.checkin.action")}
        </button>
      )}
      {props.dismissible ? (
        <button type="button" className="home-checkin__close" onClick={dismiss} aria-label={t("credits.checkin.close")} title={t("credits.checkin.dismissToday")}>
          <X size={14} strokeWidth={1.6} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

/** Daily check-in backed by the shared local preview account until the server exists. */
export function CreditsCheckinPage() {
  return (
    <CreditsSettingsShell>
      <div className={usageStyles.detailContent}>
        <HomeCheckinCard />
      </div>
    </CreditsSettingsShell>
  );
}
