import { AlertTriangle, Check, CheckCircle2, ChevronDown, ChevronUp, Database, Info, KeyRound, Loader2, Pencil, Plus, Trash2, Wrench, X, XCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { ConfigClient, ModelProviderConfig } from "../api/config-client.js";
import { Button } from "../components/button.js";
import { ConfirmDialog } from "../components/confirm-dialog.js";
import { Modal } from "../components/modal.js";
import { ModelProviderLogo } from "../components/model-provider-logo.js";
import { Select, type SelectOption } from "../components/Select.js";
import { Tooltip } from "../components/tooltip.js";
import { useTranslation } from "../i18n/use-translation.js";
import {
  deleteModelConnection,
  getModelCandidates,
  getTaskModelCandidates,
  setModelAssignment,
  setModelConnectionAvailability,
  setTaskModelCandidates,
  upsertModelConnection,
  type ModelCapability,
  type ModelAssignmentKind,
  type ModelConnection,
  type ModelWorkspaceMode,
  type ModelWorkspaceMutationError
} from "../state/model-workspace.js";
import { useModelWorkspace } from "../state/use-model-workspace.js";
import {
  ConfigField,
  PasswordConfigField,
  TestButton as ApiKeyTestButton
} from "./api-key-form-fields.js";
import { DEFAULT_ENDPOINTS, DEFAULT_MODEL_IDS, PROTOCOL_OPTIONS, fromProtocol, type Protocol } from "./model-config.js";
import {
  SETTINGS_ADD_MODEL_EVENT,
  SETTINGS_ADD_MODEL_RETURN_STORAGE_KEY,
  settingsTabHash,
  shouldOpenAddModelFromHash
} from "./settings-nav.js";

type TestStatus = "idle" | "testing" | "success" | "error";

interface ConnectionTestState {
  status: TestStatus;
  message: string | null;
}

interface ConnectionEditorState {
  connectionId: string | null;
  provider: Protocol;
  endpoint: string;
  apiKey: string;
  maxTokens: string;
  dailyTokenLimit: string;
  models: Array<{
    name: string;
    capability: ModelCapability;
  }>;
  modelDraft: string;
  capabilityDraft: ModelCapability;
  addingModel: boolean;
  editingModelName: string | null;
}

export interface ModelWorkspaceSectionProps {
  mode: ModelWorkspaceMode;
  seedConfig?: ModelProviderConfig | null;
  configClient?: Pick<ConfigClient, "testModelConfig">;
  autoOpenAddConnection?: boolean;
  onFinishSetup?: () => void;
  /** Called when the add/edit modal closes and the flow should return to the main chat. */
  onReturnToMain?: () => void;
}

/** Returns addable protocols in display order, excluding those already configured. */
export function availableConnectionProtocols(connections: readonly ModelConnection[]): Protocol[] {
  const configured = new Set(
    connections.map((connection) => protocolFromConnection(connection.provider))
  );
  return PROTOCOL_OPTIONS
    .map((option) => option.value)
    .filter((provider) => !configured.has(provider));
}

/**
 * Multi-provider settings UI backed only by the frontend workspace adapter.
 * Existing backend model config is read as a seed and remains otherwise intact.
 */
export function ModelWorkspaceSection(props: ModelWorkspaceSectionProps) {
  const { t } = useTranslation();
  const { workspace, commit } = useModelWorkspace(props.seedConfig);
  const [modelsExpanded, setModelsExpanded] = useState(true);
  const [taskPickerOpen, setTaskPickerOpen] = useState(false);
  const [editor, setEditor] = useState<ConnectionEditorState | null>(null);
  const [editorTest, setEditorTest] = useState<ConnectionTestState>({ status: "idle", message: null });
  const [showEditorApiKey, setShowEditorApiKey] = useState(false);
  const [showEditorAdvanced, setShowEditorAdvanced] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ModelConnection | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState(false);
  const [testStates, setTestStates] = useState<Record<string, ConnectionTestState>>({});
  const space = workspace.spaces[props.mode];
  const textCandidates = getModelCandidates(workspace, props.mode, "chat");
  const taskCandidates = getTaskModelCandidates(workspace, props.mode);
  const embeddingCandidates = getModelCandidates(workspace, props.mode, "embedding");
  const asrCandidates = getModelCandidates(workspace, props.mode, "asr");
  const imageCandidates = getModelCandidates(workspace, props.mode, "image");
  const configuredProviders = new Set(
    space.connections.map((connection) => protocolFromConnection(connection.provider))
  );
  const availableProviders = availableConnectionProtocols(space.connections);
  const nextAvailableProvider = availableProviders[0];
  const canAddConnection = Boolean(nextAvailableProvider);

  function commitWorkspace(next: typeof workspace): boolean {
    const saved = commit(next);
    setSaveError(!saved);
    return saved;
  }

  const openAddConnection = useCallback(() => {
    const provider = nextAvailableProvider;
    if (!provider) return;
    setFormError(null);
    setEditorTest({ status: "idle", message: null });
    setShowEditorApiKey(false);
    setShowEditorAdvanced(false);
    setEditor({
      connectionId: null,
      provider,
      endpoint: DEFAULT_ENDPOINTS[provider],
      apiKey: "",
      maxTokens: "",
      dailyTokenLimit: "",
      models: [],
      modelDraft: DEFAULT_MODEL_IDS[provider],
      capabilityDraft: "chat",
      addingModel: true,
      editingModelName: null
    });
  }, [nextAvailableProvider]);

  function closeEditor() {
    setEditor(null);
    setFormError(null);
    if (
      typeof window === "undefined"
      || window.sessionStorage.getItem(SETTINGS_ADD_MODEL_RETURN_STORAGE_KEY) !== "/main"
    ) {
      return;
    }
    window.sessionStorage.removeItem(SETTINGS_ADD_MODEL_RETURN_STORAGE_KEY);
    const nextUrl = `${window.location.pathname}${window.location.search}`;
    window.history.replaceState(window.history.state, "", nextUrl);
    props.onReturnToMain?.();
  }

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const openRequestedEditor = () => {
      openAddConnection();
      const nextHash = settingsTabHash("model");
      const nextUrl = `${window.location.pathname}${window.location.search}${nextHash}`;
      window.history.replaceState(window.history.state, "", nextUrl);
    };
    const openFromEvent = () => openRequestedEditor();
    if (
      shouldOpenAddModelFromHash(window.location.hash)
      || props.autoOpenAddConnection
      || window.sessionStorage.getItem(SETTINGS_ADD_MODEL_RETURN_STORAGE_KEY) === "/main"
    ) {
      openRequestedEditor();
    }
    window.addEventListener(SETTINGS_ADD_MODEL_EVENT, openFromEvent);
    return () => window.removeEventListener(SETTINGS_ADD_MODEL_EVENT, openFromEvent);
  }, [openAddConnection, props.autoOpenAddConnection]);

  function openEditConnection(connection: ModelConnection) {
    const provider = protocolFromConnection(connection.provider);
    setFormError(null);
    setEditorTest(testStates[connection.id] ?? { status: "idle", message: null });
    setShowEditorApiKey(false);
    setShowEditorAdvanced(false);
    setEditor({
      connectionId: connection.id,
      provider,
      endpoint: connection.endpoint,
      apiKey: "",
      maxTokens: connection.maxTokens?.toString() ?? "",
      dailyTokenLimit: connection.dailyTokenLimit?.toString() ?? "",
      models: connection.models.map((model) => ({
        name: model,
        capability: connection.modelCapabilities?.[model] ?? "chat"
      })),
      modelDraft: "",
      capabilityDraft: "chat",
      addingModel: false,
      editingModelName: null
    });
  }

  function resolveEditorModels() {
    if (!editor) {
      return { models: [] as Array<{ name: string; capability: ModelCapability }>, error: null as string | null };
    }
    const draftName = editor.modelDraft.trim();
    if (!editor.addingModel || !draftName) {
      return {
        models: editor.models,
        error: editor.models.length === 0 ? t("settings.modelWorkspace.invalidModel") : null
      };
    }
    if (editor.models.some((model) => (
      model.name !== editor.editingModelName
      && model.name.toLocaleLowerCase() === draftName.toLocaleLowerCase()
    ))) {
      return { models: editor.models, error: t("settings.modelWorkspace.duplicateModel") };
    }
    const nextModel = { name: draftName, capability: editor.capabilityDraft };
    return {
      models: editor.editingModelName
        ? editor.models.map((model) => model.name === editor.editingModelName ? nextModel : model)
        : [...editor.models, nextModel],
      error: null
    };
  }

  function saveConnection() {
    if (!editor) return;
    const maxTokens = parseOptionalPositiveInteger(editor.maxTokens);
    const dailyTokenLimit = parseOptionalPositiveInteger(editor.dailyTokenLimit);
    if (maxTokens === null || dailyTokenLimit === null) {
      setFormError(t("settings.modelWorkspace.invalidTokenLimit"));
      return;
    }
    const resolved = resolveEditorModels();
    if (resolved.error) {
      setFormError(resolved.error);
      return;
    }
    const existing = editor.connectionId
      ? space.connections.find((connection) => connection.id === editor.connectionId)
      : undefined;
    const providerChanged = Boolean(
      existing && protocolFromConnection(existing.provider) !== editor.provider
    );
    const result = upsertModelConnection(workspace, props.mode, {
      id: editor.connectionId ?? undefined,
      provider: editor.provider,
      endpoint: editor.endpoint,
      apiKey: editor.apiKey || undefined,
      apiKeyMasked: providerChanged ? undefined : existing?.apiKeyMasked,
      maxTokens,
      dailyTokenLimit,
      models: resolved.models.map((model) => model.name),
      modelCapabilities: Object.fromEntries(
        resolved.models.map((model) => [model.name, model.capability])
      )
    });
    if (result.error) {
      setFormError(mutationErrorText(result.error, t));
      return;
    }
    const savedConnection = result.workspace.spaces[props.mode].connections.find(
      (connection) => connection.id === editor.connectionId || connection.provider === editor.provider
    );
    const workspaceWithAvailability = savedConnection && (editorTest.status === "success" || editorTest.status === "error")
      ? setModelConnectionAvailability(
          result.workspace,
          props.mode,
          savedConnection.id,
          editorTest.status === "success"
        )
      : result.workspace;
    const existingTaskIds = getTaskModelCandidates(workspaceWithAvailability, props.mode)
      .map((candidate) => candidate.id);
    const savedTaskIds = savedConnection
      ? getModelCandidates(workspaceWithAvailability, props.mode, "chat")
          .filter((candidate) => candidate.connectionId === savedConnection.id)
          .map((candidate) => candidate.id)
      : [];
    const nextWorkspace = savedTaskIds.length > 0
      ? setTaskModelCandidates(
          workspaceWithAvailability,
          props.mode,
          [...new Set([...existingTaskIds, ...savedTaskIds])]
        )
      : workspaceWithAvailability;
    if (commitWorkspace(nextWorkspace)) {
      if (savedConnection && editorTest.status !== "idle") {
        setTestStates((current) => ({ ...current, [savedConnection.id]: editorTest }));
      }
      closeEditor();
    }
  }

  function saveEditorModel() {
    if (!editor) return;
    const name = editor.modelDraft.trim();
    if (!name) {
      setFormError(t("settings.modelWorkspace.invalidModel"));
      return;
    }
    if (editor.models.some((model) => (
      model.name !== editor.editingModelName
      && model.name.toLocaleLowerCase() === name.toLocaleLowerCase()
    ))) {
      setFormError(t("settings.modelWorkspace.duplicateModel"));
      return;
    }
    const nextModel = { name, capability: editor.capabilityDraft };
    const models = editor.editingModelName
      ? editor.models.map((model) => model.name === editor.editingModelName ? nextModel : model)
      : [...editor.models, nextModel];
    setEditor({
      ...editor,
      models,
      modelDraft: "",
      capabilityDraft: "chat",
      addingModel: false,
      editingModelName: null
    });
    setFormError(null);
    setEditorTest({ status: "idle", message: null });
  }

  function editEditorModel(modelName: string) {
    if (!editor) return;
    const model = editor.models.find((item) => item.name === modelName);
    if (!model) return;
    setEditor({
      ...editor,
      modelDraft: model.name,
      capabilityDraft: model.capability,
      addingModel: true,
      editingModelName: model.name
    });
    setFormError(null);
  }

  function cancelEditorModel() {
    if (!editor) return;
    setEditor({
      ...editor,
      modelDraft: "",
      capabilityDraft: "chat",
      addingModel: false,
      editingModelName: null
    });
    setFormError(null);
  }

  function removeEditorModel(modelName: string) {
    if (!editor) return;
    setEditor({
      ...editor,
      models: editor.models.filter((model) => model.name !== modelName),
      ...(editor.editingModelName === modelName
        ? {
            modelDraft: "",
            capabilityDraft: "chat" as const,
            addingModel: false,
            editingModelName: null
          }
        : {})
    });
    setFormError(null);
    setEditorTest({ status: "idle", message: null });
  }

  function confirmDeleteConnection() {
    if (!deleteTarget) return;
    const result = deleteModelConnection(workspace, props.mode, deleteTarget.id);
    if (result.error) {
      setSaveError(true);
      return;
    }
    if (commitWorkspace(result.workspace)) {
      setDeleteTarget(null);
    }
  }

  async function testEditorConnection() {
    if (!editor) return;
    const resolved = resolveEditorModels();
    if (resolved.error || resolved.models.length === 0) {
      setEditorTest({ status: "error", message: t("settings.modelWorkspace.testNoModel") });
      return;
    }
    const model = resolved.models.find((item) => item.capability === "chat")?.name
      ?? resolved.models[0]?.name;
    if (!model) {
      setEditorTest({ status: "error", message: t("settings.modelWorkspace.testNoModel") });
      return;
    }
    const existing = editor.connectionId
      ? space.connections.find((connection) => connection.id === editor.connectionId)
      : undefined;
    const providerChanged = Boolean(
      existing && protocolFromConnection(existing.provider) !== editor.provider
    );
    if (!editor.apiKey.trim() && (!existing?.apiKeyMasked || providerChanged)) {
      setEditorTest({ status: "error", message: t("settings.modelWorkspace.testKeyRequired") });
      return;
    }
    setEditorTest({ status: "testing", message: t("settings.modelWorkspace.testing") });
    try {
      const result = props.configClient
        ? await props.configClient.testModelConfig({
            provider: fromProtocol(editor.provider),
            endpoint: editor.endpoint,
            model,
            apiKey: editor.apiKey,
            apiKeyMasked: providerChanged ? "" : existing?.apiKeyMasked ?? "",
            configured: true
          }, "chat", "primary")
        : await simulateConnectionTest();
      setEditorTest({
        status: result.ok ? "success" : "error",
        message: result.ok ? t("settings.modelWorkspace.testSuccess") : t("settings.modelWorkspace.testFailed")
      });
    } catch {
      setEditorTest({ status: "error", message: t("settings.modelWorkspace.testFailed") });
    }
  }

  function updateAssignment(kind: ModelAssignmentKind, candidateId: string) {
    commitWorkspace(setModelAssignment(workspace, props.mode, kind, candidateId));
  }

  function toggleTaskCandidate(candidateId: string) {
    const selectedIds = taskCandidates.map((candidate) => candidate.id);
    const selected = selectedIds.includes(candidateId);
    if (selected && selectedIds.length === 1) return;
    const nextIds = selected
      ? selectedIds.filter((id) => id !== candidateId)
      : [...selectedIds, candidateId];
    commitWorkspace(setTaskModelCandidates(workspace, props.mode, nextIds));
  }

  const textOptions = textCandidates.map((candidate) => candidateOption(
    candidate.id,
    candidate.source === "platform"
      ? candidate.displayName
      : connectionProtocolLabel(candidate.provider, t),
    candidate.model,
    candidate.source === "platform"
      ? t("settings.modelWorkspace.platformModels")
      : t("settings.modelWorkspace.byokConnections"),
    candidate.source,
    candidate.provider
  ));
  const embeddingModelOptions = embeddingCandidates.map((candidate) => candidateOption(
    candidate.id,
    candidate.source === "platform"
      ? candidate.displayName
      : connectionProtocolLabel(candidate.provider, t),
    candidate.model,
    candidate.source === "platform"
      ? t("settings.modelWorkspace.platformModels")
      : t("settings.modelWorkspace.byokConnections"),
    candidate.source,
    candidate.provider
  ));
  const asrOptions = asrCandidates.map((candidate) => candidateOption(
    candidate.id,
    candidate.source === "platform"
      ? candidate.displayName
      : connectionProtocolLabel(candidate.provider, t),
    candidate.model,
    candidate.source === "platform"
      ? t("settings.modelWorkspace.platformModels")
      : t("settings.modelWorkspace.byokConnections"),
    candidate.source,
    candidate.provider
  ));
  const imageOptions = imageCandidates.map((candidate) => candidateOption(
    candidate.id,
    candidate.source === "platform"
      ? candidate.displayName
      : connectionProtocolLabel(candidate.provider, t),
    candidate.model,
    candidate.source === "platform"
      ? t("settings.modelWorkspace.platformModels")
      : t("settings.modelWorkspace.byokConnections"),
    candidate.source,
    candidate.provider
  ));
  const embeddingOptions: SelectOption[] = [
    {
      value: "builtin:local-embedding",
      label: t("settings.modelWorkspace.localEmbedding"),
      selectedLabel: t("settings.modelWorkspace.localEmbeddingShort"),
      groupLabel: t("settings.modelWorkspace.specialBuiltins")
    },
    ...embeddingModelOptions
  ];
  const capabilityOptions = modelCapabilityOptions(t);
  const editorExistingConnection = editor?.connectionId
    ? space.connections.find((connection) => connection.id === editor.connectionId)
    : undefined;
  const editorOriginalProvider = editorExistingConnection
    ? protocolFromConnection(editorExistingConnection.provider)
    : null;
  const editorProviderChanged = Boolean(
    editor && editorOriginalProvider && editor.provider !== editorOriginalProvider
  );
  const editorHasUsableKey = Boolean(
    editor?.apiKey.trim()
    || (editorExistingConnection?.apiKeyMasked && !editorProviderChanged)
  );
  const canSaveConnection = Boolean(
    editor
    && editor.endpoint.trim()
    && editorHasUsableKey
    && (editor.models.length > 0 || (editor.addingModel && editor.modelDraft.trim()))
  );
  const selectedTaskModelsText = taskCandidates.length > 0
    ? taskCandidates.map((candidate) => candidate.model).join("、")
    : t("settings.modelWorkspace.notConfigured");

  return (
    <div className="model-workspace-layout">
      {props.onFinishSetup && (
        <div className="flex items-center justify-between gap-4 rounded-card border border-action-sky/15 bg-action-sky/5 px-4 py-3">
          <p className="text-xs leading-relaxed text-text-ink/55">
            {t("settings.modelWorkspace.onboardingContinueHint")}
          </p>
          <button
            type="button"
            onClick={props.onFinishSetup}
            className="shrink-0 text-xs text-action-sky transition-colors cursor-pointer hover:text-action-sky-hover"
          >
            {t("apiKey.startUsing")}
          </button>
        </div>
      )}
      <section>
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <Database size={16} className="text-text-ink/60" aria-hidden="true" />
            <h3 className="text-sm font-semibold text-text-ink">{t("settings.modelWorkspace.libraryTitle")}</h3>
          </div>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={openAddConnection}
            disabled={!canAddConnection}
            title={!canAddConnection ? t("settings.modelWorkspace.allProvidersAdded") : undefined}
            aria-label={t("settings.modelWorkspace.addConnection")}
          >
            <Plus size={13} aria-hidden="true" />
            {t("settings.modelWorkspace.addConnection")}
          </Button>
        </div>

        <div className="bg-background-paper rounded-card-lg border-content-panel p-6">
          <div className="flex items-center justify-between gap-4">
            <p className="text-xs leading-relaxed text-text-ink/45">
              {t(
                props.mode === "byok"
                  ? "settings.modelWorkspace.libraryHintByok"
                  : "settings.modelWorkspace.libraryHint"
              )}
            </p>
            <button
              type="button"
              aria-expanded={modelsExpanded}
              onClick={() => setModelsExpanded((expanded) => !expanded)}
              className="inline-flex shrink-0 items-center gap-1 rounded-btn px-2 py-1 text-xs text-text-ink/50 transition-colors hover:bg-canvas-oat/60 hover:text-text-ink/70"
            >
              <span>{t(
                modelsExpanded
                  ? "settings.modelWorkspace.collapseLibrary"
                  : "settings.modelWorkspace.expandLibrary"
              )}</span>
              {modelsExpanded
                ? <ChevronUp size={12} aria-hidden="true" />
                : <ChevronDown size={12} aria-hidden="true" />}
            </button>
          </div>

          <div className="mt-4 space-y-3">
          {props.mode === "account" && (
            <article className="rounded-card border-content-panel bg-canvas-oat/40 p-4">
              <div className="flex items-center gap-2">
                <h4 className="flex min-w-0 items-center gap-2 text-sm font-semibold text-text-ink/80">
                  <ModelProviderLogo provider="memmy" size={18} />
                  <span className="truncate">
                    {workspace.platformModels[0]?.displayName ?? "Memmy Platform"}
                  </span>
                </h4>
                <span className="inline-flex shrink-0 items-center gap-1 rounded-tag bg-action-sky/10 px-2 py-0.5 text-[10px] text-action-sky">
                  {t("settings.modelWorkspace.platformProvided")}
                </span>
              </div>
              {modelsExpanded ? (
                <ProviderModelList
                  items={workspace.platformModels.map((model) => ({
                    id: model.id,
                    model: model.model,
                    capability: model.capability
                  }))}
                />
              ) : (
                <p className="mt-2 text-xs text-text-ink/45">
                  {t("settings.modelWorkspace.platformManaged")} · {t("settings.modelWorkspace.modelCount", {
                    count: workspace.platformModels.length
                  })}
                </p>
              )}
            </article>
          )}

          {space.connections.map((connection) => {
            const test = testStates[connection.id] ?? (
              connection.available === false
                ? { status: "error" as const, message: t("settings.modelWorkspace.testFailed") }
                : { status: "idle" as const, message: null }
            );
            return (
              <article key={connection.id} className="rounded-card border-content-panel bg-canvas-oat/40 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h4 className="flex min-w-0 items-center gap-2 text-sm font-semibold text-text-ink/80">
                      <ModelProviderLogo provider={connection.provider} size={16} />
                      <span className="truncate">{connectionProtocolLabel(connection.provider, t)}</span>
                    </h4>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <ConnectionStatus status={test.status} />
                    <button
                      type="button"
                      onClick={() => openEditConnection(connection)}
                      aria-label={t("settings.modelWorkspace.editConnection", { provider: connection.provider })}
                      className="rounded-btn p-1.5 text-text-ink/45 hover:bg-background-paper hover:text-text-ink/70"
                    >
                      <Pencil size={13} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteTarget(connection)}
                      aria-label={t("settings.modelWorkspace.deleteConnection", { provider: connection.provider })}
                      className="rounded-btn p-1.5 text-text-ink/45 hover:bg-status-error-soft hover:text-status-error"
                    >
                      <Trash2 size={13} aria-hidden="true" />
                    </button>
                  </div>
                </div>
                {modelsExpanded ? (
                      <ProviderModelList
                        emptyLabel={t("settings.modelWorkspace.noModels")}
                        items={connection.models.map((model) => ({
                          id: model,
                          model,
                          capability: connection.modelCapabilities?.[model] ?? "chat"
                        }))}
                      />
                ) : (
                  <p className="mt-2 text-xs text-text-ink/45">
                    {connectionProtocolLabel(connection.provider, t)} · {t("settings.modelWorkspace.modelCount", {
                      count: connection.models.length
                    })}
                  </p>
                )}
              </article>
            );
          })}

          {props.mode === "byok" && space.connections.length === 0 && (
            <div className="rounded-card border border-dashed border-border-stone/50 bg-canvas-oat/25 px-5 py-6 text-center">
              <KeyRound size={22} className="mx-auto text-text-ink/30" aria-hidden="true" />
              <p className="mt-2 text-sm text-text-ink/65">{t("settings.modelWorkspace.emptyTitle")}</p>
              <p className="mt-1 text-xs text-text-ink/45">{t("settings.modelWorkspace.emptyHint")}</p>
            </div>
          )}
          </div>
        </div>
      </section>

      <section>
        <div className="mb-3 flex items-center gap-2">
          <Wrench size={16} className="text-text-ink/60" aria-hidden="true" />
          <h3 className="text-sm font-semibold text-text-ink">{t("settings.modelWorkspace.bindingTitle")}</h3>
        </div>
        <div className="bg-background-paper rounded-card-lg border-content-panel p-6">
          <p className="text-xs leading-relaxed text-text-ink/45">
            {t("settings.modelWorkspace.bindingHint")}
          </p>
          <div className="mt-2 space-y-1">
          <div className="flex items-center justify-between gap-4 bg-action-sky/5 px-3.5 py-3">
            <div className="min-w-0">
              <p className="text-sm text-text-ink/80">{t("settings.modelWorkspace.conversationModels")}</p>
              <p className="mt-0.5 text-[11px] text-text-ink/45">
                {t("settings.modelWorkspace.taskSelectionHint")}
              </p>
              <p className="task-model-selection-summary" title={selectedTaskModelsText}>
                {t("settings.modelWorkspace.taskSelectedModels", { models: selectedTaskModelsText })}
              </p>
            </div>
            <button
              type="button"
              aria-expanded={taskPickerOpen}
              disabled={textCandidates.length === 0}
              onClick={() => setTaskPickerOpen((open) => !open)}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-btn bg-action-sky/10 px-2.5 py-1 text-xs text-action-sky transition-colors hover:bg-action-sky/15 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t("settings.modelWorkspace.taskSelectedCount", { count: taskCandidates.length })}
              {taskPickerOpen
                ? <ChevronUp size={12} aria-hidden="true" />
                : <ChevronDown size={12} aria-hidden="true" />}
            </button>
          </div>
          {taskPickerOpen && (
            <div className="task-model-picker">
              {(["platform", "byok"] as const).map((source) => {
                const candidates = textCandidates.filter((candidate) => candidate.source === source);
                if (candidates.length === 0) return null;
                return (
                  <div key={source} className="task-model-picker__group">
                    <div className="task-model-picker__group-title">
                      {source === "platform"
                        ? <ModelProviderLogo provider="memmy" size={14} />
                        : <KeyRound size={12} aria-hidden="true" />}
                      {t(
                        source === "platform"
                          ? "settings.modelWorkspace.platformModels"
                          : "settings.modelWorkspace.byokConnections"
                      )}
                    </div>
                    {candidates.map((candidate) => {
                      const selected = taskCandidates.some((item) => item.id === candidate.id);
                      const lastSelected = selected && taskCandidates.length === 1;
                      return (
                        <button
                          key={candidate.id}
                          type="button"
                          role="checkbox"
                          aria-checked={selected}
                          disabled={lastSelected}
                          title={lastSelected ? t("settings.modelWorkspace.taskAtLeastOne") : undefined}
                          onClick={() => toggleTaskCandidate(candidate.id)}
                          className="task-model-picker__option"
                        >
                          <span className={`task-model-picker__checkbox${selected ? " is-selected" : ""}`}>
                            {selected && <Check size={11} strokeWidth={3} aria-hidden="true" />}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-left">{candidate.model}</span>
                          <span className="shrink-0 text-[10px] text-text-ink/40">
                            {candidate.source === "platform"
                              ? candidate.displayName
                              : connectionProtocolLabel(candidate.provider, t)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}
          <div className="h-px bg-border-stone/30" />
          <AssignmentRow
            kind="memorySummary"
            label={t("settings.model.memorySummary")}
            description={t("settings.model.memoryDesc")}
            tip={t("apiKey.modelPage.memoryHint")}
            value={space.assignments.memorySummary}
            options={textOptions}
            onChange={updateAssignment}
          />
          <div className="h-px bg-border-stone/30" />
          <AssignmentRow
            kind="memoryEvolution"
            label={t("settings.model.skillEvolution")}
            description={t("settings.model.skillDesc")}
            value={space.assignments.memoryEvolution}
            options={textOptions}
            onChange={updateAssignment}
          />
          <div className="h-px bg-border-stone/30" />
          <AssignmentRow
            kind="embedding"
            label={t("settings.model.embeddingSearch")}
            description={t("settings.model.embeddingDesc")}
            value={space.assignments.embedding}
            options={embeddingOptions}
            onChange={updateAssignment}
          />
          <div className="h-px bg-border-stone/30" />
          <AssignmentRow
            kind="asr"
            label={t("settings.model.asr")}
            description={t("settings.model.asrDesc")}
            badge={t("settings.modelWorkspace.optional")}
            value={space.assignments.asr}
            options={asrOptions}
            onChange={updateAssignment}
          />
          <div className="h-px bg-border-stone/30" />
          <AssignmentRow
            kind="image"
            label={t("settings.model.imageGen")}
            description={t("settings.model.imageGenDesc")}
            badge={t("settings.modelWorkspace.optional")}
            value={space.assignments.image}
            options={imageOptions}
            onChange={updateAssignment}
          />
          </div>
        </div>
      </section>

      {saveError && (
        <div className="flex items-center gap-2 rounded-card bg-status-error-soft px-3 py-2 text-xs text-status-error" role="alert">
          <AlertTriangle size={13} aria-hidden="true" />
          {t("settings.modelWorkspace.saveFailed")}
        </div>
      )}

      {editor && (
        <Modal
          open
          title={t(editor.connectionId ? "settings.modelWorkspace.editTitle" : "settings.modelWorkspace.addTitle")}
          closeLabel={t("common.close")}
          closeContent={<X size={16} aria-hidden="true" />}
          onClose={closeEditor}
          className="model-connection-modal"
          backdropClassName="model-connection-modal__backdrop"
          bodyClassName="model-connection-modal__body"
          footerClassName="model-connection-modal__footer"
          footer={(
            <div className="model-connection-modal__footer-actions">
              <ApiKeyTestButton
                status={editorTest.status}
                onClick={() => void testEditorConnection()}
                label={t("settings.modelWorkspace.test")}
              />
              <div className="model-connection-modal__footer-primary">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={closeEditor}
                  aria-label={t("dialog.cancel")}
                >
                  {t("dialog.cancel")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="primary"
                  disabled={!canSaveConnection || editorTest.status === "testing"}
                  onClick={saveConnection}
                  aria-label={t("common.save")}
                >
                  {t("common.save")}
                </Button>
              </div>
            </div>
          )}
        >
          <Select
            label={t("apiKey.provider")}
            value={editor.provider}
            onValueChange={(value) => {
              const provider = value as Protocol;
              setEditor((current) => current ? {
                ...current,
                provider,
                endpoint: DEFAULT_ENDPOINTS[provider],
                apiKey: "",
                ...(current.connectionId
                  ? {}
                  : {
                      models: [],
                      modelDraft: DEFAULT_MODEL_IDS[provider],
                      capabilityDraft: "chat" as const,
                      addingModel: true,
                      editingModelName: null
                    })
              } : current);
              setFormError(null);
              setEditorTest({ status: "idle", message: null });
            }}
            options={PROTOCOL_OPTIONS.map((option) => {
              const usedByAnotherConnection = configuredProviders.has(option.value)
                && option.value !== editorOriginalProvider;
              return {
                value: option.value,
                label: usedByAnotherConnection
                  ? `${t(option.labelKey)} · ${t("settings.modelWorkspace.providerAdded")}`
                  : t(option.labelKey),
                disabled: usedByAnotherConnection,
                icon: <ModelProviderLogo provider={option.value} size={16} />
              };
            })}
            className="select-control--subtle model-connection-select"
            labelClassName="model-connection-select__label"
          />
          <ConfigField
            label={t("apiKey.endpoint")}
            value={editor.endpoint}
            onChange={(value) => {
              setEditor((current) => current ? { ...current, endpoint: value } : current);
              setEditorTest({ status: "idle", message: null });
            }}
            placeholder={DEFAULT_ENDPOINTS[editor.provider]}
          />
          <PasswordConfigField
            label={editor.connectionId && !editorProviderChanged
              ? t("settings.modelWorkspace.replaceKey")
              : t("apiKey.key")}
            value={editor.apiKey}
            onChange={(value) => {
              setEditor((current) => current ? { ...current, apiKey: value } : current);
              setEditorTest({ status: "idle", message: null });
            }}
            maskedValue={editor.connectionId && !editorProviderChanged
              ? editorExistingConnection?.apiKeyMasked
              : undefined}
            placeholder={editor.connectionId && !editorProviderChanged
              ? t("settings.modelWorkspace.replaceKeyPlaceholder")
              : "sk-..."}
            showPassword={showEditorApiKey}
            onTogglePassword={() => setShowEditorApiKey((show) => !show)}
          />
          <div className="grid gap-1.5">
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs text-text-ink/65">
                {t("settings.modelWorkspace.modelsTitle")}
              </div>
              {!editor.addingModel && (
                <button
                  type="button"
                  onClick={() => setEditor({
                    ...editor,
                    modelDraft: "",
                    capabilityDraft: "chat",
                    addingModel: true,
                    editingModelName: null
                  })}
                  aria-label={t("settings.modelWorkspace.addModel")}
                  className="inline-flex w-fit items-center gap-1 text-xs text-text-ink/55 transition-colors cursor-pointer hover:text-text-ink/75"
                >
                  <Plus size={12} aria-hidden="true" />
                  {t("settings.modelWorkspace.addModel")}
                </button>
              )}
            </div>
            <div className="rounded-card bg-canvas-oat/40 p-3">
            <ProviderModelList
              flush
              emptyLabel={editor.models.length === 0 && !editor.addingModel
                ? t("settings.modelWorkspace.noModels")
                : undefined}
              items={editor.models
                .filter((model) => model.name !== editor.editingModelName)
                .map((model) => ({
                id: model.name,
                model: model.name,
                capability: model.capability,
                editLabel: t("settings.modelWorkspace.editModel", { model: model.name }),
                onEdit: () => editEditorModel(model.name),
                deleteLabel: t("settings.modelWorkspace.deleteModel", { model: model.name }),
                onDelete: () => removeEditorModel(model.name)
              }))}
            />
            {editor.addingModel && (
            <div className={`${
              editor.models.some((model) => model.name !== editor.editingModelName) ? "mt-3" : ""
            } grid gap-2`}>
              <div className="model-editor-fields">
                <ConfigField
                  label={t("apiKey.model")}
                  value={editor.modelDraft}
                  onChange={(value) => {
                    setEditor({ ...editor, modelDraft: value });
                    setFormError(null);
                  }}
                  placeholder={t("settings.modelWorkspace.modelPlaceholder")}
                />
                <Select
                  label={t("settings.modelWorkspace.modelCapability")}
                  labelClassName="model-capability-select__label"
                  value={editor.capabilityDraft}
                  options={capabilityOptions}
                  onValueChange={(value) => setEditor({
                    ...editor,
                    capabilityDraft: value as ModelCapability
                  })}
                  className="select-control--subtle model-capability-select"
                  menuClassName="model-capability-select__menu"
                />
              </div>
              <div className="model-editor-actions">
                <button
                  type="button"
                  onClick={cancelEditorModel}
                  className="inline-flex h-7 items-center px-2 text-xs text-text-ink/50 transition-colors cursor-pointer hover:text-text-ink/75"
                >
                  {t("dialog.cancel")}
                </button>
                <button
                  type="button"
                  disabled={!editor.modelDraft.trim()}
                  onClick={saveEditorModel}
                  aria-label={t(
                    editor.editingModelName
                      ? "settings.modelWorkspace.saveModel"
                      : "settings.modelWorkspace.addModel"
                  )}
                  className="inline-flex h-7 items-center gap-1 px-2 text-xs text-action-sky transition-colors cursor-pointer hover:text-action-sky-hover disabled:cursor-not-allowed disabled:opacity-35"
                >
                  {!editor.editingModelName && <Plus size={12} aria-hidden="true" />}
                  {t(
                    editor.editingModelName
                      ? "settings.modelWorkspace.saveModel"
                      : "settings.modelWorkspace.addModel"
                  )}
                </button>
              </div>
            </div>
            )}
            </div>
          </div>
          <button
            type="button"
            aria-expanded={showEditorAdvanced}
            onClick={() => setShowEditorAdvanced((show) => !show)}
            className="inline-flex w-fit items-center gap-1.5 text-xs text-text-ink/55 transition-colors cursor-pointer hover:text-text-ink/75"
          >
            <span aria-hidden="true">{showEditorAdvanced ? "−" : "+"}</span>
            {t("apiKey.advanced")}
          </button>
          {showEditorAdvanced && (
            <div className="model-connection-advanced-fields space-y-3">
              <ConfigField
                label={t("apiKey.maxTokens")}
                placeholder={t("apiKey.noLimit")}
                value={editor.maxTokens}
                onChange={(value) => {
                  setEditor({ ...editor, maxTokens: value });
                  setFormError(null);
                }}
                suffix="tokens"
              />
              <ConfigField
                label={t("apiKey.dailyLimit")}
                placeholder={t("apiKey.noLimit")}
                value={editor.dailyTokenLimit}
                onChange={(value) => {
                  setEditor({ ...editor, dailyTokenLimit: value });
                  setFormError(null);
                }}
                suffix="tokens"
              />
            </div>
          )}
          {formError && <p className="text-xs text-status-error" role="alert">{formError}</p>}
          {editorTest.message && (
            <p
              className={`flex items-center gap-1.5 text-xs ${
                editorTest.status === "success" ? "text-status-success" : "text-status-error"
              }`}
              role={editorTest.status === "error" ? "alert" : "status"}
            >
              {editorTest.status === "success"
                ? <CheckCircle2 size={12} aria-hidden="true" />
                : editorTest.status === "error"
                  ? <XCircle size={12} aria-hidden="true" />
                  : <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
              {editorTest.message}
            </p>
          )}
        </Modal>
      )}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={t("settings.modelWorkspace.deleteTitle")}
        message={t("settings.modelWorkspace.deleteConfirm", { provider: deleteTarget?.provider ?? "" })}
        cancelLabel={t("common.cancel")}
        closeLabel={t("common.close")}
        confirmLabel={t("common.delete")}
        confirmVariant="danger"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={confirmDeleteConnection}
      />
    </div>
  );
}

interface ProviderModelListItem {
  id: string;
  model: string;
  capability: ModelCapability;
  editLabel?: string;
  onEdit?: () => void;
  deleteLabel?: string;
  onDelete?: () => void;
}

function ProviderModelList(props: {
  items: ProviderModelListItem[];
  emptyLabel?: string;
  flush?: boolean;
}) {
  const { t } = useTranslation();

  if (props.items.length === 0) {
    return props.emptyLabel
      ? <p className={`${props.flush ? "" : "mt-3 "}text-xs text-text-ink/40`}>{props.emptyLabel}</p>
      : null;
  }

  return (
    <div className={`provider-model-list ${props.flush ? "" : "mt-3 "}rounded-input bg-background-paper px-3.5`}>
      {props.items.map((item, index) => (
        <div
          key={item.id}
          className={`flex min-w-0 items-center justify-between gap-3 py-2.5 ${
            index > 0 ? "border-t border-border-stone/30" : ""
          }`}
        >
          <span className="min-w-0 truncate text-sm text-text-ink/70" title={item.model}>
            {item.model}
          </span>
          <div className="flex shrink-0 items-center gap-1.5">
            <span className="rounded-tag bg-canvas-oat px-2 py-0.5 text-[10px] text-text-ink/50">
              {t(modelCapabilityMessageKey(item.capability))}
            </span>
            {item.onEdit && (
              <button
                type="button"
                onClick={item.onEdit}
                aria-label={item.editLabel}
                className="rounded-btn p-1 text-text-ink/35 hover:bg-canvas-oat hover:text-text-ink/65"
              >
                <Pencil size={11} aria-hidden="true" />
              </button>
            )}
            {item.onDelete && (
              <button
                type="button"
                onClick={item.onDelete}
                aria-label={item.deleteLabel}
                className="rounded-btn p-1 text-text-ink/35 hover:bg-status-error-soft hover:text-status-error"
              >
                <Trash2 size={11} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function AssignmentRow(props: {
  kind: ModelAssignmentKind;
  label: string;
  description: string;
  tip?: string;
  badge?: string;
  value: string | undefined;
  options: SelectOption[];
  onChange: (kind: ModelAssignmentKind, value: string) => void;
}) {
  const { t } = useTranslation();
  const optionExists = props.options.some((option) => option.value === props.value);
  const value = optionExists ? props.value! : props.options[0]?.value ?? "";
  return (
    <div className="flex items-center justify-between gap-4 px-3.5 py-2.5">
      <div className="min-w-0">
        <div className="model-assignment-label-row">
          <span className="model-assignment-label">{props.label}</span>
          {props.tip ? (
            <Tooltip content={props.tip}>
              <button
                type="button"
                className="model-assignment-tip-icon"
                aria-label={props.tip}
              >
                <Info size={12} strokeWidth={1.9} aria-hidden="true" />
              </button>
            </Tooltip>
          ) : null}
          {props.badge && (
            <span className="rounded-tag bg-canvas-oat px-2 py-0.5 text-[10px] text-text-ink/50">
              {props.badge}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-[11px] text-text-ink/45">{props.description}</p>
      </div>
      <Select
        label={t("settings.modelWorkspace.chooseFor", { feature: props.label })}
        labelClassName="sr-only"
        value={value}
        placeholder={t("settings.modelWorkspace.notConfigured")}
        options={props.options}
        onValueChange={(next) => props.onChange(props.kind, next)}
        disabled={props.options.length === 0}
        className="select-control--compact select-control--subtle model-assignment-select"
        menuClassName="model-assignment-select__menu"
      />
    </div>
  );
}

function ConnectionStatus(props: { status: TestStatus }) {
  const { t } = useTranslation();
  const className = props.status === "success"
    ? "bg-status-success-soft text-status-success"
    : props.status === "error"
      ? "bg-status-error-soft text-status-error"
      : props.status === "testing"
        ? "bg-action-sky/10 text-action-sky"
        : "bg-background-paper text-text-ink/45";
  const icon = props.status === "success"
    ? <CheckCircle2 size={10} aria-hidden="true" />
    : props.status === "error"
      ? <XCircle size={10} aria-hidden="true" />
      : props.status === "testing"
        ? <Loader2 size={10} className="animate-spin" aria-hidden="true" />
        : <span className="h-1.5 w-1.5 rounded-full bg-border-stone" aria-hidden="true" />;
  return (
    <span className={`inline-flex items-center gap-1 rounded-tag px-2 py-0.5 text-[10px] ${className}`}>
      {icon}
      {t(
        props.status === "testing"
          ? "settings.modelWorkspace.testing"
          : props.status === "success"
            ? "settings.modelWorkspace.testSuccess"
            : props.status === "error"
              ? "settings.modelWorkspace.testFailed"
              : "settings.modelWorkspace.untested"
      )}
    </span>
  );
}

function candidateOption(
  value: string,
  providerLabel: string,
  model: string,
  groupLabel: string,
  source: "platform" | "byok" = "byok",
  providerId?: string
): SelectOption {
  return {
    value,
    label: `${providerLabel} · ${model}`,
    selectedLabel: model,
    groupLabel,
    icon: (
      <ModelProviderLogo
        provider={source === "platform" ? "memmy" : (providerId ?? providerLabel)}
        size={16}
      />
    )
  };
}

function connectionProtocolLabel(
  provider: string,
  t: ReturnType<typeof useTranslation>["t"]
): string {
  const protocol = protocolFromConnection(provider);
  const option = PROTOCOL_OPTIONS.find((item) => item.value === protocol);
  return option ? t(option.labelKey) : provider;
}

function protocolFromConnection(provider: string): Protocol {
  if (provider === "moonshot" || provider === "kimi") return "moonshot";
  if (PROTOCOL_OPTIONS.some((option) => option.value === provider)) return provider as Protocol;
  return "openai";
}

function modelCapabilityOptions(
  t: ReturnType<typeof useTranslation>["t"]
): SelectOption[] {
  return (["chat", "embedding", "asr", "image"] as const).map((capability) => ({
    value: capability,
    label: capability === "chat"
      ? t("settings.modelWorkspace.capability.chatOption")
      : t(modelCapabilityMessageKey(capability)),
    selectedLabel: t(modelCapabilityMessageKey(capability))
  }));
}

function modelCapabilityMessageKey(capability: ModelCapability) {
  if (capability === "embedding") return "settings.modelWorkspace.capability.embedding" as const;
  if (capability === "asr") return "settings.modelWorkspace.capability.asr" as const;
  if (capability === "image") return "settings.modelWorkspace.capability.image" as const;
  return "settings.modelWorkspace.capability.chat" as const;
}

function parseOptionalPositiveInteger(value: string): number | undefined | null {
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (!/^\d+$/u.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function mutationErrorText(
  error: ModelWorkspaceMutationError,
  t: ReturnType<typeof useTranslation>["t"]
): string {
  if (error === "duplicate_provider") return t("settings.modelWorkspace.duplicateProvider");
  if (error === "duplicate_model") return t("settings.modelWorkspace.duplicateModel");
  if (error === "invalid_model") return t("settings.modelWorkspace.invalidModel");
  if (error === "connection_not_found") return t("settings.modelWorkspace.connectionMissing");
  return t("settings.modelWorkspace.invalidConnection");
}

async function simulateConnectionTest(): Promise<{ ok: boolean }> {
  await new Promise((resolve) => window.setTimeout(resolve, 450));
  return { ok: true };
}
