import { route } from "../stores/router";
import { OverviewView } from "../views/OverviewView";
import { UserMemoriesView } from "../views/UserMemoriesView";
import { MemoriesView } from "../views/MemoriesView";
import { TasksView } from "../views/TasksView";
import { SkillsView } from "../views/SkillsView";
import { PoliciesView } from "../views/PoliciesView";
import { WorldModelsView } from "../views/WorldModelsView";
import { AnalyticsView } from "../views/AnalyticsView";
import { LogsView } from "../views/LogsView";
import { SettingsView } from "../views/SettingsView";
import { TEAM_SHARING_UI_ENABLED } from "../features";
import { Icon } from "./Icon";
import { t } from "../stores/i18n";

export function ContentRouter() {
  const path = route.value.path;
  // Allow deep-linking into a specific Settings tab.
  // e.g. clicking a model card on the Overview page navigates to
  // `#/settings?tab=models` and lands directly on the AI models tab.
  const settingsTabParam = route.value.params.tab;
  const settingsTab =
    settingsTabParam === "models" ||
    (TEAM_SHARING_UI_ENABLED && settingsTabParam === "hub") ||
    settingsTabParam === "agents" ||
    settingsTabParam === "general"
      ? settingsTabParam
      : undefined;
  switch (path) {
    case "/overview":     return <OverviewView />;
    case "/user-memories": return <UserMemoriesView />;
    case "/memories":     return <MemoriesView />;
    case "/tasks":        return <TasksView />;
    case "/skills":       return <SkillsView />;
    case "/policies":     return <PoliciesView />;
    case "/world-models": return <WorldModelsView />;
    case "/analytics":    return <AnalyticsView />;
    case "/logs":         return <LogsView />;
    // Keep legacy `/admin` bookmarks inside Settings. While sharing is
    // hidden they land on Models instead of exposing the retired tab.
    case "/admin":        return <SettingsView initialTab={TEAM_SHARING_UI_ENABLED ? "hub" : "models"} />;
    case "/settings":     return <SettingsView initialTab={settingsTab} />;
    default:
      return (
        <div class="empty">
          <div class="empty__icon">
            <Icon name="info" size={24} />
          </div>
          <div class="empty__title">{t("common.empty")}</div>
          <div class="empty__hint">
            <code class="mono">{path}</code>
          </div>
        </div>
      );
  }
}
