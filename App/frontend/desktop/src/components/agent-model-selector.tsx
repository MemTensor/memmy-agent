import { Settings2 } from "lucide-react";
import type { ModelProviderConfig } from "../api/config-client.js";
import { useTranslation } from "../i18n/use-translation.js";
import { agentActions, appActions } from "../state/app-actions.js";
import { useAppState } from "../state/app-state.js";
import {
  getTaskModelCandidates,
  createModelWorkspace,
  resolveModelSelection,
  type ModelWorkspaceMode
} from "../state/model-workspace.js";
import {
  settingsTabHash
} from "../pages/settings-nav.js";
import { ModelProviderLogo } from "./model-provider-logo.js";
import { Select, type SelectOption } from "./Select.js";

export interface AgentModelSelectorProps {
  mode: ModelWorkspaceMode;
  scopeKey: string;
  disabled: boolean;
  seedConfig?: ModelProviderConfig | null;
}

/** Per-chat catalog preset picker. Selection lives in Agent state, never browser storage. */
export function AgentModelSelector(props: AgentModelSelectorProps) {
  const { t } = useTranslation();
  const { state, dispatch } = useAppState();
  const workspace = createModelWorkspace(props.seedConfig ?? state.modelConfig);
  const candidates = getTaskModelCandidates(workspace, props.mode);
  const committedSelection = state.agent.committedModelSelectionByScope[props.scopeKey];
  const selectedPreset = state.agent.pendingPresetByScope[props.scopeKey]
    ?? committedSelection?.presetId
    ?? null;
  const resolved = resolveModelSelection(workspace, props.mode, selectedPreset);
  const hasNoModels = candidates.length === 0;

  const options: SelectOption[] = candidates.map((candidate) => ({
        value: candidate.id,
        label: candidate.source === "platform" ? t("home.modelSelector.platformAgent") : candidate.model,
        selectedLabel: candidate.source === "platform" ? t("home.modelSelector.platformAgent") : candidate.model,
        groupLabel: candidate.source === "platform"
          ? t("home.modelSelector.platformGroup")
          : t("home.modelSelector.byokGroup"),
        icon: <ModelProviderIcon source={candidate.source} provider={candidate.provider} />
      }));
  if (resolved.unavailable && resolved.candidateId) {
    const unavailableModel = committedSelection?.model ?? resolved.previousModel ?? t("home.modelSelector.unavailableOption");
    const unavailableOption: SelectOption = {
      value: resolved.candidateId,
      label: unavailableModel,
      selectedLabel: unavailableModel,
      groupLabel: t("home.modelSelector.byokGroup"),
      icon: committedSelection?.provider || resolved.previousProvider
        ? <ModelProviderIcon
            source={committedSelection?.source === "account" ? "platform" : "byok"}
            provider={committedSelection?.provider ?? resolved.previousProvider!}
          />
        : undefined,
      disabled: true
    };
    const firstCustomIndex = candidates.findIndex((candidate) => candidate.source === "byok");
    options.splice(firstCustomIndex >= 0 ? firstCustomIndex : options.length, 0, unavailableOption);
  }
  if (!options.length) {
    options.push({
      value: "__no_models__",
      label: t("home.modelSelector.emptyOption"),
      disabled: true
    });
  }

  function selectModel(candidateId: string) {
    dispatch(agentActions.pendingModelPresetUpdated(props.scopeKey, candidateId));
  }

  function openCustomModelSettings() {
    if (typeof window !== "undefined") {
      const nextUrl = `${window.location.pathname}${window.location.search}${settingsTabHash("model")}`;
      window.history.replaceState(window.history.state, "", nextUrl);
    }
    dispatch(appActions.navigate("/settings"));
  }

  return (
    <div className="agent-model-selector" data-model-selector-scope={props.scopeKey}>
      <Select
        label={t("home.modelSelector.label")}
        labelClassName="sr-only"
        value={resolved.candidateId ?? ""}
        placeholder={hasNoModels && !resolved.unavailable
          ? t("home.modelSelector.emptyState")
          : t("home.modelSelector.empty")}
        options={options}
        onValueChange={selectModel}
        disabled={props.disabled}
        className="select-control--compact select-control--subtle agent-model-selector__control"
        buttonClassName="agent-model-selector__button"
        menuClassName="agent-model-selector__menu"
        menuFooter={({ close }) => (
          <div className="agent-model-selector__footer">
            <button
              type="button"
              className="agent-model-selector__configure"
              onClick={() => {
                close();
                openCustomModelSettings();
              }}
            >
              <Settings2 size={13} aria-hidden="true" />
              {t("home.modelSelector.configureCustom")}
            </button>
          </div>
        )}
      />
    </div>
  );
}

function ModelProviderIcon(props: { source: "platform" | "byok"; provider: string }) {
  if (props.source === "platform") {
    return <ModelProviderLogo provider="memmy" className="agent-model-selector__provider-logo" size={15} />;
  }
  return <ModelProviderLogo provider={props.provider} className="agent-model-selector__provider-logo" size={15} />;
}
