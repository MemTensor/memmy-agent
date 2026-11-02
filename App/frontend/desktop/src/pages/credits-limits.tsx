/** One conversation showing what happens after the credit balance runs out. Preview only. */
import { Info, Send } from "lucide-react";
import { useTranslation } from "../i18n/use-translation.js";
import { appActions } from "../state/app-actions.js";
import { useAppState } from "../state/app-state.js";
import { AppFrame } from "./app-frame.js";

export function CreditsLimitsPage() {
  const { dispatch } = useAppState();
  const { t } = useTranslation();

  function upgrade() {
    dispatch(appActions.navigate("/plans"));
  }

  function useOwnKey() {
    if (typeof window !== "undefined") {
      window.location.hash = "#model-config";
    }
    dispatch(appActions.navigate("/settings"));
  }

  return (
    <AppFrame
      title={t("credits.limits.task")}
      topBar={(
        <h1 className="agent-conversation-title" title={t("credits.limits.task")}>
          <span className="agent-conversation-title__text">{t("credits.limits.task")}</span>
        </h1>
      )}
    >
      <div className="credits-empty-demo">
        <div className="credits-empty-demo__thread">
          <div className="credits-empty-demo__column">
            <div className="credits-empty-demo__user agent-chat-bubble agent-chat-bubble--user px-4 py-2.5">
              {t("credits.limits.user")}
            </div>
            <p className="credits-empty-demo__answer">{t("credits.limits.assistant")}</p>
            <p className="credits-limit-line" role="status">
              <span>
                <Info size={14} strokeWidth={1.75} aria-hidden="true" />
                {t("credits.limits.inlineLead")}
                <button type="button" onClick={upgrade}>{t("credits.exhausted.upgrade")}</button>
                {t("credits.limits.inlineJoin")}
                <button type="button" onClick={useOwnKey}>{t("credits.exhausted.byok")}</button>
                {t("credits.limits.inlineTail")}
              </span>
            </p>
          </div>
        </div>
        <div className="credits-empty-demo__dock">
          <form
            className="agent-composer-shell credits-empty-demo__composer"
            onSubmit={(event) => {
              event.preventDefault();
            }}
          >
            <textarea readOnly rows={2} value={t("credits.limits.draft")} aria-label={t("home.input")} />
            <div className="credits-empty-demo__bar">
              <span className="credits-empty-demo__balance">{t("credits.limits.balance")}</span>
              <button type="submit" className="composer-action-submit bg-action-sky text-white cursor-pointer" aria-label={t("home.send")}>
                <Send size={14} strokeWidth={2} />
              </button>
            </div>
          </form>
        </div>
      </div>
    </AppFrame>
  );
}
