import { useTranslation } from "../i18n/use-translation.js";
import type { PluginScenarioTarget } from "./plugin-conversation-controls.js";
import "./home-starter-actions.css";

/** Starter prompts shown only while the user is composing a new task. */
export function HomeStarterActions(props: {
  scenarios: PluginScenarioTarget[];
  disabled?: boolean;
  onSend?: (prompt: string) => void;
  onSelect?: (prompt: string) => void;
}) {
  const { t } = useTranslation();
  const send = props.onSelect ?? props.onSend ?? (() => undefined);
  const legalDiagnosis = props.scenarios.find((scenario) => scenario.pluginId === "legal-labor"
    && scenario.id === "labor-risk-diagnosis");

  return (
    <div className="home-prompt-suggestions" aria-label={t("home.empty")}>
      {legalDiagnosis && (
        <button type="button" disabled={props.disabled} onClick={() => send(legalDiagnosis.prompt)}>
          <span>{t("home.suggestion.legalDiagnosis")}</span>
        </button>
      )}
      <button type="button" disabled={props.disabled} onClick={() => send(t("home.suggestionPrompt.two"))}>
        <span>{t("home.suggestion.two")}</span>
      </button>
      {!legalDiagnosis && (
        <button type="button" disabled={props.disabled} onClick={() => send(t("home.suggestionPrompt.one"))}>
          <span>{t("home.suggestion.one")}</span>
        </button>
      )}
      <button type="button" disabled={props.disabled} onClick={() => send(t("home.suggestionPrompt.three"))}>
        <span>{t("home.suggestion.three")}</span>
      </button>
    </div>
  );
}
