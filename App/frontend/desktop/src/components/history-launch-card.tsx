import { useTranslation } from "../i18n/use-translation.js";
import "./history-launch-prompt.css";

/** Shared introduction for the launch notice and the History page before setup. */
export function HistoryLaunchCard({ onEnable, footnoteId }: { onEnable(): void; footnoteId?: string }) {
  const { t } = useTranslation();
  return <>
    <div className="history-launch-card">
      <div className="history-launch-copy">
        <h3>{t("historyLaunch.subtitle")}</h3>
        <p>{t("historyLaunch.description")}</p>
        <p>{t("historyLaunch.benefit")}</p>
        <button className="history-launch-primary" type="button" onClick={onEnable}>
          {t("historyLaunch.cta")}
        </button>
      </div>
      <div className="history-launch-visual" aria-hidden="true">
        <div className="history-launch-visual__glow" />
        <div className="history-launch-example">
          <p className="history-launch-chat__user">{t("historyLaunch.visualUser")}</p>
          <p className="history-launch-chat__agent">{t("historyLaunch.visualAgent")}</p>
        </div>
        <div className="history-launch-visual__caption">{t("historyLaunch.visualCaption")}</div>
      </div>
    </div>
    <p id={footnoteId} className="history-launch-footnote">
      {t("historyLaunch.footnote")}
    </p>
  </>;
}
