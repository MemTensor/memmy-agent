import { useEffect, useState } from "react";
import { useAppState } from "../state/app-state.js";
import { appActions } from "../state/app-actions.js";
import { useTranslation } from "../i18n/use-translation.js";
import { formatCreditAmount } from "../app/credit-display.js";
import { openExternalUrl } from "../utils/open-url.js";
import { writeSettingsTabHash } from "./settings-nav.js";
import type { AppRoutePath } from "../app/routes.js";
import styles from "./settings-token-usage.module.css";

/** Only server-published content is shown. An absent configuration creates no legal or reward promises. */
export function CreditsPublishedContent() {
  const { state, dispatch } = useAppState();
  const { t, language } = useTranslation();
  const [now, setNow] = useState(Date.now);
  const content = state.bootstrap?.desktopContent;
  useEffect(() => {
    if (!content?.promotions.length) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [content]);
  if (!content || content.locale !== language) return null;
  const links = [...content.agreements.map(item => ({ code: item.agreementCode, title: item.title, url: item.url, version: item.version })),
    ...content.pages.filter(page => !content.agreements.some(item => item.agreementCode === page.pageCode))
      .map(page => ({ code: page.pageCode, title: page.title, url: page.contentUrl, version: page.version }))];
  const promotions = content.promotions.filter(item => Date.parse(item.startAt) <= now && Date.parse(item.endAt) > now);
  const navigate = (target: string) => {
    const routes: Record<string, AppRoutePath> = { "memmy://credits": "/settings", "memmy://credits/check-in": "/checkin",
      "memmy://credits/invitations": "/settings", "memmy://credits/redemptions": "/redeem", "memmy://credits/plans": "/plans" };
    const route = routes[target];
    if (route) {
      if (route === "/settings") writeSettingsTabHash("tokens");
      dispatch(appActions.navigate(route));
      if (target === "memmy://credits/invitations") window.requestAnimationFrame(() => document.getElementById("credits-invitations")?.scrollIntoView({ block: "center" }));
    } else if (target.startsWith("https://")) void openExternalUrl(target);
  };
  if (!links.length && !promotions.length) return null;
  return <section className={styles.usageSection} aria-label={t("credits.content.title")}>
    {links.length > 0 && <nav className="flex flex-wrap gap-4 text-xs text-action-sky" aria-label={t("credits.content.rules")}>
      {links.map(link => <button type="button" key={link.code} title={`${link.title} · ${link.version}`} onClick={() => void openExternalUrl(link.url)}>{link.title}</button>)}
    </nav>}
    {promotions.length > 0 && <ul className="grid gap-3 mt-3">
      {promotions.map(item => <li key={item.promotionId} className="rounded-card border border-border-stone p-3">
        <button type="button" className="text-sm text-action-sky" onClick={() => { if (Date.parse(item.endAt) > Date.now()) navigate(item.targetUrl); }}>{item.title}</button>
        <p className="text-xs text-text-ink/60 mt-1">{item.description}</p>
        <p className="text-xs text-text-ink/60 mt-1">{t("credits.content.reward", { amount: formatCreditAmount(item.rewardRule.amount, language) })}
          {item.rewardRule.validDays !== null && ` · ${t("credits.content.validDays", { days: item.rewardRule.validDays })}`}
          {item.rewardRule.dailyLimit !== undefined && ` · ${t("credits.content.dailyLimit", { count: item.rewardRule.dailyLimit })}`}</p>
        <p className="text-xs text-text-ink/60 mt-1">{t("credits.content.endsAt", { time: new Date(item.endAt).toLocaleString(language) })}</p>
      </li>)}
    </ul>}
  </section>;
}
