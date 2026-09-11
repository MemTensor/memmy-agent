import { AlertTriangle, Check, CheckCircle2, ChevronDown, ChevronUp, Database, Info, KeyRound, Loader2, Pencil, Plus, Trash2, Wrench, X, XCircle } from "lucide-react";
import {
  BUILTIN_LOCAL_EMBEDDING_ASSIGNMENT_ID,
  MODEL_NAME_MAX_LENGTH,
  type ModelEndpointProtocol
} from "@memmy/local-api-contracts";
import { useCallback, useEffect, useRef, useState } from "react";
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
  createModelWorkspace,
  getModelCandidates,
  getTaskModelCandidates,
  modelConfigInput,
  protocolSupportsModelCapabilities,
  setModelAssignment,
  setModelConnectionAvailability,
  setDefaultTaskModel,
  setTaskModelCandidates,
  upsertModelConnection,
  type ModelCapability,
  type ModelAssignmentKind,
  type ModelConnection,
  type ModelWorkspaceMode,
  type ModelWorkspaceMutationError
} from "../state/model-workspace.js";
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
import {
  connectionTestSignature,
  readConnectionTestStates,
  removeConnectionTestState,
  writeConnectionTestState,
  type StoredConnectionTestState,
  type StoredConnectionTestStatus
} from "./model-workspace-connection-test-state.js";

type TestStatus = "idle" | "testing" | "success" | "error";
export type ModelKind = "text" | "embedding" | "asr" | "image";

const DEFAULT_TEXT_CAPABILITIES: ModelCapability[] = ["chat", "memorySummary", "memoryEvolution"];
const MODEL_KIND_OPTIONS = ["text", "embedding", "asr", "image"] as const;

export function modelCapabilitiesForKind(kind: ModelKind): ModelCapability[] {
  if (kind === "text") return [...DEFAULT_TEXT_CAPABILITIES];
  return [kind];
}

export function normalizeEditorCapabilities(capabilities: ModelCapability[]): ModelCapability[] {
  return modelCapabilitiesForKind(modelKindForCapabilities(capabilities));
}

interface ConnectionTestState {
  status: TestStatus;
  message: string | null;
}

interface ConnectionEditorState {
  connectionId: string | null;
  provider: Protocol;
  endpoint: string;
  apiKey: string;
  models: Array<{
    presetId?: string;
    name: string;
    capabilities: ModelCapability[];
  }>;
  modelDraft: string;
  capabilityDrafts: ModelCapability[];
  addingModel: boolean;
  editingModelIndex: number | null;
}

export interface ModelWorkspaceSectionProps {
  mode: ModelWorkspaceMode;
  seedConfig?: ModelProviderConfig | null;
  configClient?: Pick<ConfigClient, "getModelConfig" | "saveModelCatalog" | "testModelConfig">;
  onConfigSaved?: (config: ModelProviderConfig) => void;
  autoOpenAddConnection?: boolean;
  onFinishSetup?: () => void;
  /** Called when the add/edit modal closes and the flow should return to the main chat. */
  onReturnToMain?: () => void;
}

/** Returns addable protocols in display order, excluding those already configured. */
export function availableConnectionProtocols(connections: readonly ModelConnection[]): Protocol[] {
  void connections;
  return PROTOCOL_OPTIONS.map((option) => option.value);
}

/**
 * Multi-provider settings UI backed by the revisioned local model catalog API.
 */
export function ModelWorkspaceSection(props: ModelWorkspaceSectionProps) {
  const { t } = useTranslation();
  const [workspace, setWorkspace] = useState(() => createModelWorkspace(props.seedConfig));
  const [modelsExpanded, setModelsExpanded] = useState(true);
  const [taskPickerOpen, setTaskPickerOpen] = useState(false);
  const [editor, setEditor] = useState<ConnectionEditorState | null>(null);
  const [editorTest, setEditorTest] = useState<ConnectionTestState>({ status: "idle", message: null });
  const [showEditorApiKey, setShowEditorApiKey] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ModelConnection | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savePending, setSavePending] = useState(false);
  const saveInFlightRef = useRef(false);
  const hasMutatedRef = useRef(false);
  const [testStates, setTestStates] = useState<Record<string, StoredConnectionTestState>>({});
  const space = workspace.spaces[props.mode];
  const connectionTestIdentity = space.connections
    .map((connection) => `${connection.id}:${connectionTestSignature(connection)}`)
    .sort()
    .join("|");
  const textCandidates = getModelCandidates(workspace, props.mode, "chat");
  const memorySummaryCandidates = getModelCandidates(workspace, props.mode, "memorySummary");
  const memoryEvolutionCandidates = getModelCandidates(workspace, props.mode, "memoryEvolution");
  const taskCandidates = getTaskModelCandidates(workspace, props.mode);
  const embeddingCandidates = getModelCandidates(workspace, props.mode, "embedding");
  const asrCandidates = getModelCandidates(workspace, props.mode, "asr");
  const imageCandidates = getModelCandidates(workspace, props.mode, "image");
  const platformCandidates = props.mode === "account"
    ? [...textCandidates, ...memorySummaryCandidates, ...memoryEvolutionCandidates, ...embeddingCandidates, ...asrCandidates, ...imageCandidates]
        .filter((candidate, index, items) => (
          candidate.source === "platform"
          && items.findIndex((item) => item.id === candidate.id) === index
        ))
    : [];
  const availableProviders = availableConnectionProtocols(space.connections);
  const nextAvailableProvider = availableProviders[0];
  const canAddConnection = Boolean(nextAvailableProvider);

  function commitWorkspace(next: typeof workspace, onSaved?: (savedWorkspace: typeof workspace) => void): boolean {
    if (saveInFlightRef.current) return false;
    setWorkspace(next);
    setSaveError(null);
    hasMutatedRef.current = true;
    if (props.configClient) {
      saveInFlightRef.current = true;
      setSavePending(true);
      void (async () => {
        try {
          const saved = await props.configClient!.saveModelCatalog(modelConfigInput(next));
          const savedWorkspace = createModelWorkspace(saved);
          setWorkspace(savedWorkspace);
          props.onConfigSaved?.(saved);
          onSaved?.(savedWorkspace);
        } catch (error) {
          setSaveError(modelWorkspaceErrorText(error, t));
          try {
            const latest = await props.configClient!.getModelConfig();
            setWorkspace(createModelWorkspace(latest));
            props.onConfigSaved?.(latest);
          } catch {
            // Keep the optimistic workspace visible when even the conflict reload is unavailable.
          }
        } finally {
          saveInFlightRef.current = false;
          setSavePending(false);
        }
      })();
    } else {
      onSaved?.(next);
    }
    return true;
  }

  useEffect(() => {
    if (!saveInFlightRef.current) setWorkspace(createModelWorkspace(props.seedConfig));
  }, [props.seedConfig]);

  useEffect(() => {
    const restored = readConnectionTestStates(
      space.connections,
      modelConnectionTestStorage()
    );
    setTestStates((current) => {
      const currentValid = Object.fromEntries(space.connections.flatMap((connection) => {
        const state = current[connection.id];
        return state?.signature === connectionTestSignature(connection)
          ? [[connection.id, state]]
          : [];
      }));
      return { ...restored, ...currentValid };
    });
  }, [connectionTestIdentity]);

  useEffect(() => {
    if (!props.configClient) return;
    let active = true;
    void props.configClient.getModelConfig().then((saved) => {
      if (!active || hasMutatedRef.current) return;
      setWorkspace(createModelWorkspace(saved));
      props.onConfigSaved?.(saved);
    }).catch((error) => setSaveError(modelWorkspaceErrorText(error, t)));
    return () => { active = false; };
  }, [props.configClient]);

  const openAddConnection = useCallback(() => {
    const provider = nextAvailableProvider;
    if (!provider) return;
    setFormError(null);
    setEditorTest({ status: "idle", message: null });
    setShowEditorApiKey(false);
    setEditor({
      connectionId: null,
      provider,
      endpoint: DEFAULT_ENDPOINTS[provider],
      apiKey: "",
      models: [],
      modelDraft: DEFAULT_MODEL_IDS[provider],
      capabilityDrafts: [...DEFAULT_TEXT_CAPABILITIES],
      addingModel: true,
      editingModelIndex: null
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
    const savedTest = connectionTestState(connection, testStates);
    setFormError(null);
    setEditorTest(savedTest
      ? { status: savedTest, message: connectionTestMessage(savedTest, t) }
      : { status: "idle", message: null });
    setShowEditorApiKey(false);
    setEditor({
      connectionId: connection.id,
      provider,
      endpoint: connection.endpoint,
      apiKey: "",
      models: connection.modelEntries.map((entry) => ({
        presetId: entry.presetId,
        name: entry.model,
        capabilities: normalizeEditorCapabilities(entry.capabilities.map(fromCatalogCapability))
      })),
      modelDraft: "",
      capabilityDrafts: [...DEFAULT_TEXT_CAPABILITIES],
      addingModel: false,
      editingModelIndex: null
    });
  }

  function resolveEditorModels() {
    if (!editor) {
      return { models: [] as Array<{ presetId?: string; name: string; capabilities: ModelCapability[] }>, error: null as string | null };
    }
    const draftName = editor.modelDraft.trim();
    if (!editor.addingModel || !draftName) {
      return {
        models: editor.models,
        error: editor.models.length === 0 ? t("settings.modelWorkspace.invalidModel") : null
      };
    }
    if (editor.models.some((model, index) => (
      index !== editor.editingModelIndex
      && model.name.toLocaleLowerCase() === draftName.toLocaleLowerCase()
    ))) {
      return { models: editor.models, error: t("settings.modelWorkspace.duplicateModel") };
    }
    const editedModel = editor.editingModelIndex === null
      ? undefined
      : editor.models[editor.editingModelIndex];
    const nextModel = {
      ...(editedModel?.presetId ? { presetId: editedModel.presetId } : {}),
      name: draftName,
      capabilities: editor.capabilityDrafts
    };
    return {
      models: editor.editingModelIndex !== null
        ? editor.models.map((model, index) => index === editor.editingModelIndex ? nextModel : model)
        : [...editor.models, nextModel],
      error: null
    };
  }

  function saveConnection() {
    if (!editor) return;
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
    const capabilities = resolved.models.flatMap((model) => model.capabilities);
    const result = upsertModelConnection(workspace, props.mode, {
      id: editor.connectionId ?? undefined,
      provider: editor.provider,
      endpoint: editor.endpoint,
      protocol: editorProtocolForCapabilities(
        editor.provider,
        capabilities,
        providerChanged ? undefined : existing?.protocol
      ),
      apiKey: editor.apiKey || undefined,
      apiKeyMasked: providerChanged ? undefined : existing?.apiKeyMasked,
      models: resolved.models.map((model) => model.name),
      modelEntries: resolved.models.map((model) => ({
        ...(model.presetId ? { presetId: model.presetId } : {}),
        model: model.name,
        capability: model.capabilities[0]!,
        capabilities: model.capabilities
      })),
      modelCapabilities: Object.fromEntries(
        resolved.models.map((model) => [model.name, model.capabilities[0]!])
      )
    });
    if (result.error) {
      setFormError(mutationErrorText(result.error, t));
      return;
    }
    const savedConnection = result.workspace.spaces[props.mode].connections.find((connection) => (
      connection.id === editor.connectionId
      || (
        editor.connectionId === null
        && protocolFromConnection(connection.provider) === editor.provider
        && connection.endpoint === editor.endpoint.trim().replace(/\/+$/, "")
        && resolved.models.every((model) => connection.modelEntries.some((entry) => (
          entry.model === model.name
          && model.capabilities.every((capability) => entry.capabilities.includes(toCatalogCapabilityForEditor(capability)))
        )))
      )
    ));
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
    const savedTestStatus: StoredConnectionTestStatus | null = editorTest.status === "success" || editorTest.status === "error"
      ? editorTest.status
      : null;
    const persistTestState = (savedWorkspace: typeof workspace) => {
      const storage = modelConnectionTestStorage();
      if (editor.connectionId && editor.connectionId !== savedConnection?.id) {
        removeConnectionTestState(editor.connectionId, storage);
      }
      if (!savedConnection) return;
      const canonicalConnection = savedWorkspace.spaces[props.mode].connections
        .find((connection) => connection.id === savedConnection.id);
      if (savedTestStatus && canonicalConnection) {
        writeConnectionTestState(canonicalConnection, savedTestStatus, storage);
      } else {
        removeConnectionTestState(savedConnection.id, storage);
      }
    };
    if (commitWorkspace(nextWorkspace, persistTestState)) {
      setTestStates((current) => {
        const next = { ...current };
        if (editor.connectionId) delete next[editor.connectionId];
        if (savedConnection && savedTestStatus) {
          next[savedConnection.id] = {
            status: savedTestStatus,
            signature: connectionTestSignature(savedConnection)
          };
        }
        return next;
      });
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
    if (editor.models.some((model, index) => (
      index !== editor.editingModelIndex
      && model.name.toLocaleLowerCase() === name.toLocaleLowerCase()
    ))) {
      setFormError(t("settings.modelWorkspace.duplicateModel"));
      return;
    }
    const editedModel = editor.editingModelIndex === null
      ? undefined
      : editor.models[editor.editingModelIndex];
    const nextModel = {
      ...(editedModel?.presetId ? { presetId: editedModel.presetId } : {}),
      name,
      capabilities: editor.capabilityDrafts
    };
    const models = editor.editingModelIndex !== null
      ? editor.models.map((model, index) => index === editor.editingModelIndex ? nextModel : model)
      : [...editor.models, nextModel];
    setEditor({
      ...editor,
      models,
      modelDraft: "",
      capabilityDrafts: [...DEFAULT_TEXT_CAPABILITIES],
      addingModel: false,
      editingModelIndex: null
    });
    setFormError(null);
    setEditorTest({ status: "idle", message: null });
  }

  function editEditorModel(modelIndex: number) {
    if (!editor) return;
    const model = editor.models[modelIndex];
    if (!model) return;
    setEditor({
      ...editor,
      modelDraft: model.name,
      capabilityDrafts: model.capabilities,
      addingModel: true,
      editingModelIndex: modelIndex
    });
    setFormError(null);
  }

  function cancelEditorModel() {
    if (!editor) return;
    setEditor({
      ...editor,
      modelDraft: "",
      capabilityDrafts: [...DEFAULT_TEXT_CAPABILITIES],
      addingModel: false,
      editingModelIndex: null
    });
    setFormError(null);
  }

  function removeEditorModel(modelIndex: number) {
    if (!editor) return;
    setEditor({
      ...editor,
      models: editor.models.filter((_model, index) => index !== modelIndex),
      editingModelIndex: editor.editingModelIndex !== null && modelIndex < editor.editingModelIndex
        ? editor.editingModelIndex - 1
        : editor.editingModelIndex,
      ...(editor.editingModelIndex === modelIndex
        ? {
            modelDraft: "",
            capabilityDrafts: [...DEFAULT_TEXT_CAPABILITIES],
            addingModel: false,
            editingModelIndex: null
          }
        : {})
    });
    setFormError(null);
    setEditorTest({ status: "idle", message: null });
  }

  function confirmDeleteConnection() {
    if (!deleteTarget) return;
    const deletedConnectionId = deleteTarget.id;
    const result = deleteModelConnection(workspace, props.mode, deleteTarget.id);
    if (result.error) {
      setSaveError(mutationErrorText(result.error, t));
      return;
    }
    if (commitWorkspace(result.workspace, () => removeConnectionTestState(
      deletedConnectionId,
      modelConnectionTestStorage()
    ))) {
      setTestStates((current) => {
        const next = { ...current };
        delete next[deletedConnectionId];
        return next;
      });
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
    const selectedModel = resolved.models.find((item) => item.capabilities.includes("chat"))
      ?? resolved.models[0];
    if (!selectedModel) {
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
          endpointId: existing?.endpointId ?? editor.connectionId ?? "connection-test-new",
          protocol: editorProtocolForCapabilities(
            editor.provider,
            selectedModel.capabilities,
            providerChanged ? undefined : existing?.protocol
          ),
          endpoint: editor.endpoint,
            model: selectedModel.name,
            apiKey: editor.apiKey,
            apiKeyMasked: providerChanged ? "" : existing?.apiKeyMasked ?? "",
            configured: true
          }, testCapability(selectedModel.capabilities[0]!), testSecretTarget(selectedModel.capabilities[0]!))
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

  function chooseDefaultTaskCandidate(candidateId: string) {
    commitWorkspace(setDefaultTaskModel(workspace, props.mode, candidateId));
  }

  const memorySummaryOptions = memorySummaryCandidates.map((candidate) => candidateOption(
    candidate.id,
    candidate.source === "platform" ? t("settings.modelWorkspace.platformName") : connectionProtocolLabel(candidate.provider, t),
    candidate.source === "platform" ? platformModelName(candidate.capability, t) : candidate.model,
    candidate.source === "platform" ? t("settings.modelWorkspace.platformModels") : t("settings.modelWorkspace.byokConnections"),
    candidate.source,
    candidate.provider
  ));
  const memoryEvolutionOptions = memoryEvolutionCandidates.map((candidate) => candidateOption(
    candidate.id,
    candidate.source === "platform" ? t("settings.modelWorkspace.platformName") : connectionProtocolLabel(candidate.provider, t),
    candidate.source === "platform" ? platformModelName(candidate.capability, t) : candidate.model,
    candidate.source === "platform" ? t("settings.modelWorkspace.platformModels") : t("settings.modelWorkspace.byokConnections"),
    candidate.source,
    candidate.provider
  ));
  const customEmbeddingOptions = embeddingCandidates
    .filter((candidate) => candidate.source === "byok")
    .map((candidate) => candidateOption(
      candidate.id,
      connectionProtocolLabel(candidate.provider, t),
      candidate.model,
      t("settings.modelWorkspace.byokConnections"),
      candidate.source,
      candidate.provider
    ));
  const cloudEmbeddingOptions = props.mode === "account"
    ? embeddingCandidates
        .filter((candidate) => candidate.source === "platform")
        .map((candidate): SelectOption => ({
          value: candidate.id,
          label: t("settings.modelWorkspace.platformEmbedding"),
          selectedLabel: t("settings.modelWorkspace.platformEmbedding"),
          groupLabel: t("settings.modelWorkspace.platformModels"),
          icon: <ModelProviderLogo provider="memmy" size={16} />
        }))
    : [];
  const asrOptions = asrCandidates.map((candidate) => candidateOption(
    candidate.id,
    candidate.source === "platform"
      ? t("settings.modelWorkspace.platformName")
      : connectionProtocolLabel(candidate.provider, t),
    candidate.source === "platform" ? platformModelName(candidate.capability, t) : candidate.model,
    candidate.source === "platform"
      ? t("settings.modelWorkspace.platformModels")
      : t("settings.modelWorkspace.byokConnections"),
    candidate.source,
    candidate.provider
  ));
  const imageOptions = imageCandidates.map((candidate) => candidateOption(
    candidate.id,
    candidate.source === "platform"
      ? t("settings.modelWorkspace.platformName")
      : connectionProtocolLabel(candidate.provider, t),
    candidate.source === "platform" ? platformModelName(candidate.capability, t) : candidate.model,
    candidate.source === "platform"
      ? t("settings.modelWorkspace.platformModels")
      : t("settings.modelWorkspace.byokConnections"),
    candidate.source,
    candidate.provider
  ));
  const embeddingOptions: SelectOption[] = [
    {
      value: BUILTIN_LOCAL_EMBEDDING_ASSIGNMENT_ID,
      label: t("settings.modelWorkspace.localEmbedding"),
      selectedLabel: t("settings.modelWorkspace.localEmbeddingShort"),
      groupLabel: t("settings.modelWorkspace.platformModels"),
      icon: <ModelProviderLogo provider="memmy" size={16} />
    },
    ...cloudEmbeddingOptions,
    ...customEmbeddingOptions
  ];
  const embeddingAssignment = space.assignments.embedding
    ?? (props.mode === "byok" ? BUILTIN_LOCAL_EMBEDDING_ASSIGNMENT_ID : undefined);
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
    <div className="model-workspace-layout" aria-busy={savePending}>
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
      <div>
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
            disabled={!canAddConnection || savePending}
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
          {props.mode === "account" && platformCandidates.length > 0 && (
            <article className="rounded-card border-content-panel bg-canvas-oat/40 p-4">
              <div className="flex items-center gap-2">
                <h4 className="flex min-w-0 items-center gap-2 text-sm font-semibold text-text-ink/80">
                  <ModelProviderLogo provider="memmy" size={18} />
                  <span className="truncate">
                    {t("settings.modelWorkspace.platformName")}
                  </span>
                </h4>
                <span className="inline-flex shrink-0 items-center gap-1 rounded-tag bg-action-sky/10 px-2 py-0.5 text-[10px] text-action-sky">
                  {t("settings.modelWorkspace.platformProvided")}
                </span>
              </div>
            </article>
          )}

          {space.connections.map((connection) => {
            const storedTestStatus = connectionTestState(connection, testStates);
            const test = storedTestStatus
              ? { status: storedTestStatus, message: connectionTestMessage(storedTestStatus, t) }
              : (
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
                      disabled={props.mode === "byok" && space.connections.length <= 1}
                      aria-label={t("settings.modelWorkspace.deleteConnection", { provider: connection.provider })}
                      className="rounded-btn p-1.5 text-text-ink/45 hover:bg-status-error-soft hover:text-status-error disabled:cursor-not-allowed disabled:opacity-35"
                    >
                      <Trash2 size={13} aria-hidden="true" />
                    </button>
                  </div>
                </div>
                {modelsExpanded ? (
                      <ProviderModelList
                        emptyLabel={t("settings.modelWorkspace.noModels")}
                        items={connection.modelEntries.map((entry) => ({
                          id: entry.presetId,
                          model: entry.model,
                          capabilities: entry.capabilities.map(fromCatalogCapability)
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

      {saveError && (
        <div className="mt-2 mb-5 flex items-center gap-2 rounded-card bg-status-error-soft px-3 py-2 text-xs text-status-error" role="alert">
          <AlertTriangle size={13} aria-hidden="true" />
          {saveError}
        </div>
      )}

      <section className={saveError ? undefined : "mt-8"}>
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
                      const isDefault = space.defaultTaskCandidateId === candidate.id;
                      return (
                        <div key={candidate.id} className="task-model-picker__option">
                          <button
                            type="button"
                            role="checkbox"
                            aria-checked={selected}
                            disabled={lastSelected}
                            title={lastSelected ? t("settings.modelWorkspace.taskAtLeastOne") : undefined}
                            onClick={() => toggleTaskCandidate(candidate.id)}
                            className="task-model-picker__choice"
                          >
                          <span className={`task-model-picker__checkbox${selected ? " is-selected" : ""}`}>
                            {selected && <Check size={11} strokeWidth={3} aria-hidden="true" />}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-left">
                            {candidate.model}
                          </span>
                          <span className="shrink-0 text-[10px] text-text-ink/40">
                            {candidate.source === "platform"
                              ? t("settings.modelWorkspace.platformName")
                              : connectionProtocolLabel(candidate.provider, t)}
                          </span>
                          </button>
                          {selected && (
                            <button
                              type="button"
                              aria-pressed={isDefault}
                              onClick={() => chooseDefaultTaskCandidate(candidate.id)}
                              className="task-model-picker__default-button shrink-0"
                            >
                              {isDefault
                                ? t("settings.modelWorkspace.defaultModel")
                                : t("settings.modelWorkspace.setDefaultModel")}
                            </button>
                          )}
                        </div>
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
            options={memorySummaryOptions}
            onChange={updateAssignment}
          />
          <div className="h-px bg-border-stone/30" />
          <AssignmentRow
            kind="memoryEvolution"
            label={t("settings.model.skillEvolution")}
            description={t("settings.model.skillDesc")}
            value={space.assignments.memoryEvolution}
            options={memoryEvolutionOptions}
            onChange={updateAssignment}
          />
          <div className="h-px bg-border-stone/30" />
          <AssignmentRow
            kind="embedding"
            label={t("settings.model.embeddingSearch")}
            description={t("settings.model.embeddingDesc")}
            value={embeddingAssignment}
            options={embeddingOptions}
            onChange={updateAssignment}
            preserveUnassigned={props.mode === "account"}
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
      </div>

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
                  disabled={!canSaveConnection || editorTest.status === "testing" || savePending}
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
                      capabilityDrafts: [...DEFAULT_TEXT_CAPABILITIES],
                      addingModel: true,
                      editingModelIndex: null
                    })
              } : current);
              setFormError(null);
              setEditorTest({ status: "idle", message: null });
            }}
            options={PROTOCOL_OPTIONS.map((option) => {
              return {
                value: option.value,
                label: t(option.labelKey),
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
                    capabilityDrafts: editorExistingConnection
                      ? editorCapabilitiesForProtocol(editorExistingConnection.protocol)
                      : [...DEFAULT_TEXT_CAPABILITIES],
                    addingModel: true,
                    editingModelIndex: null
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
                .map((model, index) => ({ model, index }))
                .filter(({ index }) => index !== editor.editingModelIndex)
                .map(({ model, index }) => ({
                id: model.presetId ?? `${model.name}:${model.capabilities.join(":")}:${index}`,
                model: model.name,
                capabilities: model.capabilities,
                editLabel: t("settings.modelWorkspace.editModel", { model: model.name }),
                onEdit: () => editEditorModel(index),
                deleteLabel: t("settings.modelWorkspace.deleteModel", { model: model.name }),
                onDelete: () => removeEditorModel(index)
              }))}
            />
            {editor.addingModel && (
            <div className={`${
              editor.models.some((_model, index) => index !== editor.editingModelIndex) ? "mt-3" : ""
            } grid gap-2`}>
              <div className="model-editor-fields">
                <ConfigField
                  label={t("apiKey.model")}
                  value={editor.modelDraft}
                  maxLength={MODEL_NAME_MAX_LENGTH}
                  onChange={(value) => {
                    setEditor({ ...editor, modelDraft: value.slice(0, MODEL_NAME_MAX_LENGTH) });
                    setFormError(null);
                  }}
                  placeholder={t("settings.modelWorkspace.modelPlaceholder")}
                />
                <ModelCapabilityPicker
                  capabilities={editor.capabilityDrafts}
                  onChange={(capabilityDrafts) => setEditor({ ...editor, capabilityDrafts })}
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
                    editor.editingModelIndex !== null
                      ? "settings.modelWorkspace.saveModel"
                      : "settings.modelWorkspace.addModel"
                  )}
                  className="inline-flex h-7 items-center gap-1 px-2 text-xs text-action-sky transition-colors cursor-pointer hover:text-action-sky-hover disabled:cursor-not-allowed disabled:opacity-35"
                >
                  {editor.editingModelIndex === null && <Plus size={12} aria-hidden="true" />}
                  {t(
                    editor.editingModelIndex !== null
                      ? "settings.modelWorkspace.saveModel"
                      : "settings.modelWorkspace.addModel"
                  )}
                </button>
              </div>
            </div>
            )}
            </div>
          </div>
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
        message={t("settings.modelWorkspace.deleteConfirm", {
          provider: deleteTarget ? connectionProtocolLabel(deleteTarget.provider, t) : ""
        })}
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
  capabilities: ModelCapability[];
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
          className={`provider-model-list__row flex min-w-0 items-center justify-between gap-3 py-2.5 ${
            index > 0 ? "border-t border-border-stone/30" : ""
          }`}
        >
          <span className="min-w-0 flex-1 truncate text-sm text-text-ink/70" title={item.model}>
            {item.model}
          </span>
          <div className="flex shrink-0 items-center gap-1.5">
            <span className="rounded-tag bg-canvas-oat px-2 py-0.5 text-[10px] text-text-ink/50">
              {t(modelKindMessageKey(modelKindForCapabilities(item.capabilities)))}
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
  preserveUnassigned?: boolean;
}) {
  const { t } = useTranslation();
  const optionExists = props.options.some((option) => option.value === props.value);
  const value = optionExists
    ? props.value!
    : props.preserveUnassigned
      ? ""
      : props.options[0]?.value ?? "";
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

function connectionTestState(
  connection: ModelConnection,
  states: Record<string, StoredConnectionTestState>
): StoredConnectionTestStatus | null {
  const state = states[connection.id];
  return state?.signature === connectionTestSignature(connection) ? state.status : null;
}

function connectionTestMessage(
  status: StoredConnectionTestStatus,
  t: ReturnType<typeof useTranslation>["t"]
): string {
  return t(status === "success"
    ? "settings.modelWorkspace.testSuccess"
    : "settings.modelWorkspace.testFailed");
}

function modelConnectionTestStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
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
  if (provider === "dashscope") return "qwen";
  if (provider === "qianfan") return "baidu";
  if (provider === "volcengine") return "doubao";
  if (PROTOCOL_OPTIONS.some((option) => option.value === provider)) return provider as Protocol;
  return "openai";
}

function protocolForEditor(provider: Protocol, capability: ModelCapability): ModelEndpointProtocol {
  if (capability === "embedding") return "openai-embeddings";
  if (capability === "asr") return "dashscope-input-audio-chat";
  if (capability === "image") return provider === "qwen" ? "dashscope-multimodal-generation" : "openai-images";
  if (provider === "anthropic") return "anthropic-messages";
  if (provider === "gemini") return "gemini-generate-content";
  return "openai-chat-completions";
}

function editorCapabilitiesForProtocol(protocol: ModelEndpointProtocol): ModelCapability[] {
  if (protocol === "openai-embeddings") return ["embedding"];
  if (protocol === "dashscope-input-audio-chat") return ["asr"];
  if (protocol === "openai-images" || protocol === "dashscope-multimodal-generation") return ["image"];
  return [...DEFAULT_TEXT_CAPABILITIES];
}

export function editorProtocolForCapabilities(
  provider: Protocol,
  capabilities: ModelCapability[],
  existingProtocol?: ModelEndpointProtocol
): ModelEndpointProtocol {
  if (existingProtocol && protocolSupportsModelCapabilities(existingProtocol, capabilities)) {
    return existingProtocol;
  }
  return protocolForEditor(provider, capabilities[0] ?? "chat");
}

function modelKindForCapabilities(capabilities: ModelCapability[]): ModelKind {
  if (capabilities.includes("embedding")) return "embedding";
  if (capabilities.includes("asr")) return "asr";
  if (capabilities.includes("image")) return "image";
  return "text";
}

function ModelCapabilityPicker(props: {
  capabilities: ModelCapability[];
  onChange: (capabilities: ModelCapability[]) => void;
}) {
  const { t } = useTranslation();
  const kind = modelKindForCapabilities(props.capabilities);

  return (
    <Select
      label={t("settings.modelWorkspace.modelCapability")}
      labelClassName="model-capability-select__label"
      value={kind}
      options={modelKindOptions(t)}
      onValueChange={(value) => props.onChange(modelCapabilitiesForKind(value as ModelKind))}
      className="select-control--subtle model-capability-select"
      menuClassName="model-capability-select__menu"
    />
  );
}

function modelKindOptions(t: ReturnType<typeof useTranslation>["t"]): SelectOption[] {
  return MODEL_KIND_OPTIONS.map((kind) => ({
    value: kind,
    label: t(modelKindMessageKey(kind))
  }));
}

function modelKindMessageKey(kind: ModelKind) {
  return modelCapabilityMessageKey(kind === "text" ? "chat" : kind);
}

function modelCapabilityMessageKey(capability: ModelCapability) {
  if (capability === "memorySummary") return "settings.modelWorkspace.capability.memorySummary" as const;
  if (capability === "memoryEvolution") return "settings.modelWorkspace.capability.memoryEvolution" as const;
  if (capability === "embedding") return "settings.modelWorkspace.capability.embedding" as const;
  if (capability === "asr") return "settings.modelWorkspace.capability.asr" as const;
  if (capability === "image") return "settings.modelWorkspace.capability.image" as const;
  return "settings.modelWorkspace.capability.chat" as const;
}

function fromCatalogCapability(capability: "agent" | "memory_summary" | "memory_evolution" | "embedding" | "asr" | "image_generation"): ModelCapability {
  if (capability === "agent") return "chat";
  if (capability === "memory_summary") return "memorySummary";
  if (capability === "memory_evolution") return "memoryEvolution";
  if (capability === "image_generation") return "image";
  return capability;
}

function toCatalogCapabilityForEditor(capability: ModelCapability) {
  if (capability === "chat") return "agent" as const;
  if (capability === "memorySummary") return "memory_summary" as const;
  if (capability === "memoryEvolution") return "memory_evolution" as const;
  if (capability === "image") return "image_generation" as const;
  return capability;
}

function platformModelName(
  capability: ModelCapability,
  t: ReturnType<typeof useTranslation>["t"]
): string {
  return t(modelCapabilityMessageKey(capability));
}

function testCapability(capability: ModelCapability): "chat" | "embedding" | "asr" | "image" {
  if (capability === "embedding") return "embedding";
  if (capability === "asr") return "asr";
  if (capability === "image") return "image";
  return "chat";
}

function testSecretTarget(capability: ModelCapability): "primary" | "memory" | "skill" | "embedding" | "asr" | "image" {
  if (capability === "memorySummary") return "memory";
  if (capability === "memoryEvolution") return "skill";
  const target = testCapability(capability);
  return target === "chat" ? "primary" : target;
}

function mutationErrorText(
  error: ModelWorkspaceMutationError,
  t: ReturnType<typeof useTranslation>["t"]
): string {
  if (error === "duplicate_provider") return t("settings.modelWorkspace.duplicateProvider");
  if (error === "duplicate_model") return t("settings.modelWorkspace.duplicateModel");
  if (error === "invalid_model") return t("settings.modelWorkspace.invalidModel");
  if (error === "incompatible_model_capabilities") return t("settings.modelWorkspace.incompatibleModelCapabilities");
  if (error === "connection_not_found") return t("settings.modelWorkspace.connectionMissing");
  return t("settings.modelWorkspace.invalidConnection");
}

function modelWorkspaceErrorText(
  error: unknown,
  t: ReturnType<typeof useTranslation>["t"]
): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  if (code === "model_config_changed") return t("settings.model.configChanged");
  if (code === "config_write_busy") return t("settings.modelWorkspace.saveBusy");
  return error instanceof Error && error.message
    ? error.message
    : t("settings.modelWorkspace.saveFailed");
}

async function simulateConnectionTest(): Promise<{ ok: boolean }> {
  await new Promise((resolve) => window.setTimeout(resolve, 450));
  return { ok: true };
}
