import { Check } from "lucide-react";
import {
  resolveThinkingEnabled,
  resolveThinkingLevel,
  type ModelThinkingConfig
} from "@memmy/local-api-contracts";
import { useTranslation } from "../i18n/use-translation.js";
import { agentActions } from "../state/app-actions.js";
import { useAppState } from "../state/app-state.js";

export interface AgentThinkingControlProps {
  scopeKey: string;
  thinkingConfig: ModelThinkingConfig | null;
  disabled: boolean;
}

/** Thinking settings shown inside the open model menu. */
export function AgentThinkingControl(props: AgentThinkingControlProps) {
  const { t } = useTranslation();
  const { state, dispatch } = useAppState();
  const config = props.thinkingConfig;

  if (!config) return null;

  const thinkingState = state.agent.thinkingStateByScope[props.scopeKey];
  const enabled = resolveThinkingEnabled(config, thinkingState?.enabled);
  const currentLevel = resolveThinkingLevel(config, thinkingState?.level);
  const showLevels = enabled && config.levels.length > 0;

  return (
    <div className="agent-thinking-control" aria-label={t("home.thinking.label")}>
      {config.switchable && (
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={() => dispatch(agentActions.thinkingToggled(props.scopeKey, !enabled))}
          disabled={props.disabled}
          className="thinking-toggle"
        >
          <span>{t("home.thinking.label")}</span>
          <span className={`thinking-toggle__switch ${enabled ? "thinking-toggle__switch--on" : ""}`} aria-hidden="true">
            <span className="thinking-toggle__switch-thumb" />
          </span>
        </button>
      )}

      {showLevels && (
        <div className="thinking-level-picker" role="group" aria-label={t("home.thinking.levelHeader")}>
          <div className="thinking-level-picker__header">{t("home.thinking.levelHeader")}</div>
          {config.levels.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={currentLevel === option}
              onClick={() => dispatch(agentActions.thinkingLevelChanged(props.scopeKey, option))}
              disabled={props.disabled}
              className={`thinking-level-option ${currentLevel === option ? "thinking-level-option--selected" : ""}`}
            >
              <span>{t(`home.thinking.levelValue.${option}`)}</span>
              {currentLevel === option && <Check size={15} strokeWidth={2.4} aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
