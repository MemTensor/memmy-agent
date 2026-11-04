import { ArrowRight, BookOpenText, CalendarCheck2, History } from "lucide-react";
import { useTranslation } from "../i18n/use-translation.js";
import { resolveContributionIcon } from "./agent-command-palette.js";
import type { PluginScenarioTarget } from "./plugin-conversation-controls.js";
import "./home-starter-actions.css";

/** Starter prompts shown only while the user is composing a new task. */
export function HomeStarterActions(props: {
  scenarios: PluginScenarioTarget[];
  onSelect(prompt: string): void;
}) {
  const { t } = useTranslation();

  if (props.scenarios.length > 0) {
    return (
      <div className="home-scenario-cards" aria-label={t("home.empty")}>
        {props.scenarios.map((scenario) => {
          const Icon = resolveContributionIcon(scenario.icon);
          return (
            <button
              key={`${scenario.pluginId}:${scenario.id}`}
              type="button"
              className="home-scenario-card"
              onClick={() => props.onSelect(scenario.prompt)}
            >
              <span className={`home-scenario-card__icon${scenario.icon === "scale" ? " home-scenario-card__icon--scale" : ""}`} aria-hidden="true"><Icon size={16} /></span>
              <span className="home-scenario-card__body">
                <span className="home-scenario-card__title">{scenario.name}</span>
                <span className="home-scenario-card__description">{scenario.description}</span>
              </span>
              <span className="home-scenario-card__cta" aria-hidden="true">
                {t("home.scenario.try")} <ArrowRight size={12} />
              </span>
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className="home-prompt-suggestions" aria-label={t("home.empty")}>
      <button type="button" onClick={() => props.onSelect(t("home.suggestionPrompt.one"))}>
        <span className="home-prompt-suggestions__icon" aria-hidden="true"><BookOpenText size={15} /></span>
        <span>{t("home.suggestion.one")}</span>
      </button>
      <button type="button" onClick={() => props.onSelect(t("home.suggestionPrompt.two"))}>
        <span className="home-prompt-suggestions__icon" aria-hidden="true"><CalendarCheck2 size={15} /></span>
        <span>{t("home.suggestion.two")}</span>
      </button>
      <button type="button" onClick={() => props.onSelect(t("home.suggestionPrompt.three"))}>
        <span className="home-prompt-suggestions__icon" aria-hidden="true"><History size={15} /></span>
        <span>{t("home.suggestion.three")}</span>
      </button>
    </div>
  );
}
