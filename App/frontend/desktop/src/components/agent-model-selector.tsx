import { Settings2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { ModelProviderConfig } from "../api/config-client.js";
import { useTranslation } from "../i18n/use-translation.js";
import { appActions } from "../state/app-actions.js";
import { useAppState } from "../state/app-state.js";
import {
  getTaskModelCandidates,
  resolveScopedModelSelection,
  setScopedModelSelection,
  type ModelWorkspaceMode
} from "../state/model-workspace.js";
import { useModelWorkspace } from "../state/use-model-workspace.js";
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

/** Frontend-only per-chat model picker. It never calls the runtime `/model`. */
export function AgentModelSelector(props: AgentModelSelectorProps) {
  const { t } = useTranslation();
  const { dispatch } = useAppState();
  const { workspace, commit } = useModelWorkspace(props.seedConfig);
  const [saveFailed, setSaveFailed] = useState(false);
  const candidates = getTaskModelCandidates(workspace, props.mode);
  const scopedResolved = resolveScopedModelSelection(workspace, props.mode, props.scopeKey);
  const resetDraftToLatest = props.scopeKey.startsWith("draft-")
    && candidates.length > 0
    && (
      scopedResolved.reason === "unavailable"
      || scopedResolved.reason === "mode_changed"
      || scopedResolved.reason === "mode_preserved"
    );
  const resolved = resetDraftToLatest
    ? {
        candidate: candidates[0]!,
        candidateId: candidates[0]!.id,
        unavailable: false,
        reason: "initial" as const
      }
    : scopedResolved;
  const hasNoModels = candidates.length === 0;

  useEffect(() => {
    if (
      !resolved.candidateId
      || (
        resolved.reason !== "initial"
        && resolved.reason !== "mode_preserved"
        && resolved.reason !== "mode_changed"
      )
    ) {
      return;
    }
    const saved = commit(setScopedModelSelection(
      workspace,
      props.mode,
      props.scopeKey,
      resolved.candidateId
    ));
    setSaveFailed(!saved);
  }, [
    commit,
    props.mode,
    props.scopeKey,
    resolved.candidateId,
    resolved.reason,
    workspace
  ]);

  const options: SelectOption[] = hasNoModels
    ? [{
        value: "__no_models__",
        label: t("home.modelSelector.emptyOption"),
        disabled: true
      }]
    : candidates.map((candidate) => ({
        value: candidate.id,
        label: candidate.model,
        selectedLabel: candidate.model,
        groupLabel: candidate.source === "platform"
          ? t("home.modelSelector.platformGroup")
          : t("home.modelSelector.byokGroup"),
        icon: <ModelProviderIcon source={candidate.source} provider={candidate.provider} />
      }));
  if (!hasNoModels && resolved.unavailable && resolved.candidateId) {
    const unavailableModel = resolved.previousModel ?? t("home.modelSelector.unavailableOption");
    const unavailableOption: SelectOption = {
      value: resolved.candidateId,
      label: unavailableModel,
      selectedLabel: unavailableModel,
      groupLabel: t("home.modelSelector.byokGroup"),
      icon: resolved.previousProvider
        ? <ModelProviderIcon source="byok" provider={resolved.previousProvider} />
        : undefined,
      disabled: true
    };
    const firstCustomIndex = candidates.findIndex((candidate) => candidate.source === "byok");
    options.splice(firstCustomIndex >= 0 ? firstCustomIndex : options.length, 0, unavailableOption);
  }

  function selectModel(candidateId: string) {
    const saved = commit(setScopedModelSelection(workspace, props.mode, props.scopeKey, candidateId));
    setSaveFailed(!saved);
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
        value={hasNoModels ? "" : resolved.candidateId ?? ""}
        placeholder={hasNoModels
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
      {saveFailed && (
        <p className="agent-model-selector__error" role="alert">
          {t("home.modelSelector.saveFailed")}
        </p>
      )}
    </div>
  );
}

function ModelProviderIcon(props: { source: "platform" | "byok"; provider: string }) {
  if (props.source === "platform") {
    return <ModelProviderLogo provider="memmy" className="agent-model-selector__provider-logo" size={15} />;
  }
  return <ModelProviderLogo provider={props.provider} className="agent-model-selector__provider-logo" size={15} />;
}
