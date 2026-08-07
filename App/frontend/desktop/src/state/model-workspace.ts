/** Frontend-only multi-provider model workspace and scoped model selections. */
import type { ModelProviderConfig } from "../api/config-client.js";

export const MODEL_WORKSPACE_STORAGE_KEY = "memmy-model-workspace-v1";
export const MODEL_WORKSPACE_EVENT = "memmy:model-workspace-changed";
export const MODEL_WORKSPACE_VERSION = 1;

export type ModelWorkspaceMode = "account" | "byok";
export type ModelCapability = "chat" | "embedding" | "asr" | "image";
export type ModelAssignmentKind = "memorySummary" | "memoryEvolution" | "embedding" | "asr" | "image";
export type ModelWorkspaceMutationError =
  | "duplicate_provider"
  | "duplicate_model"
  | "invalid_connection"
  | "invalid_model"
  | "connection_not_found";

export interface PlatformModel {
  id: string;
  provider: "memmy-platform";
  model: string;
  displayName: string;
  capability: ModelCapability;
}

export interface ModelConnection {
  id: string;
  provider: string;
  endpoint: string;
  /** Persisted display value only. Plaintext keys remain transient form state. */
  apiKeyMasked: string;
  /** Optional output-token cap applied to requests using this connection. */
  maxTokens?: number;
  /** Optional local daily token budget for this connection. */
  dailyTokenLimit?: number;
  models: string[];
  modelCapabilities?: Record<string, ModelCapability>;
  /** False after a failed connection test; invalid connections leave candidate lists. */
  available?: boolean;
}

export interface ModelWorkspaceSpace {
  connections: ModelConnection[];
  assignments: Partial<Record<ModelAssignmentKind, string>>;
  /** Explicit Agent candidate subset. Undefined preserves legacy "all text models" behavior. */
  taskCandidateIds?: string[];
}

export interface ScopedModelSelection {
  mode: ModelWorkspaceMode;
  candidateId: string;
  /** Stable model identity used to preserve a conversation across spaces. */
  model?: string;
  /** Provider retained so a deleted custom model can keep its original logo. */
  provider?: string;
}

export interface ModelWorkspace {
  version: typeof MODEL_WORKSPACE_VERSION;
  platformModels: PlatformModel[];
  spaces: Record<ModelWorkspaceMode, ModelWorkspaceSpace>;
  selectionsByScope: Record<string, ScopedModelSelection>;
}

export interface ModelCandidate {
  id: string;
  source: "platform" | "byok";
  provider: string;
  model: string;
  displayName: string;
  connectionId: string | null;
  capability: ModelCapability;
}

export interface ModelConnectionInput {
  id?: string;
  provider: string;
  endpoint: string;
  apiKey?: string;
  apiKeyMasked?: string;
  maxTokens?: number;
  dailyTokenLimit?: number;
  models: string[];
  modelCapabilities?: Record<string, ModelCapability>;
}

export interface ModelWorkspaceMutationResult {
  workspace: ModelWorkspace;
  error: ModelWorkspaceMutationError | null;
}

export interface ResolvedModelSelection {
  candidate: ModelCandidate | null;
  candidateId: string | null;
  unavailable: boolean;
  previousModel?: string | null;
  previousProvider?: string | null;
  reason: "saved" | "initial" | "mode_preserved" | "mode_changed" | "unavailable" | "empty";
}

export interface WorkspaceUsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface WorkspaceUsageRow extends WorkspaceUsageTotals {
  id: string;
  provider: string;
  model: string;
  breakdownAvailable: boolean;
}

export interface AccountLogoutByokPreparation {
  workspace: ModelWorkspace;
  hasTaskModel: boolean;
}

interface EventTargetLike {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
  dispatchEvent(event: Event): boolean;
}

const PLATFORM_MODELS: PlatformModel[] = [
  {
    id: "platform:memmy-platform:agent_chat",
    provider: "memmy-platform",
    model: "agent_chat",
    displayName: "Memmy Platform",
    capability: "chat"
  },
  {
    id: "platform:memmy-platform:embedding",
    provider: "memmy-platform",
    model: "embedding",
    displayName: "Memmy Platform",
    capability: "embedding"
  },
  {
    id: "platform:memmy-platform:asr",
    provider: "memmy-platform",
    model: "asr",
    displayName: "Memmy Platform",
    capability: "asr"
  }
];

/**
 * Creates a workspace seed. Existing single-provider config is reused as the
 * first local BYOK connection. Account BYOK starts empty because legacy config
 * must never be copied into an account space.
 */
export function createModelWorkspaceSeed(saved?: ModelProviderConfig | null): ModelWorkspace {
  const localConnections = connectionsFromLegacyConfig(saved);
  const localCandidates = candidatesFromConnections("byok", localConnections, null);
  const accountCandidates = PLATFORM_MODELS.map(platformModelCandidate);

  return {
    version: MODEL_WORKSPACE_VERSION,
    platformModels: PLATFORM_MODELS.map((model) => ({ ...model })),
    spaces: {
      account: {
        connections: [],
        assignments: createDefaultAssignments(accountCandidates, "account")
      },
      byok: {
        connections: localConnections,
        assignments: createLegacyAssignments(saved, localCandidates)
      }
    },
    selectionsByScope: {}
  };
}

/** Reads and validates persisted workspace data, falling back to a fresh seed. */
export function readModelWorkspace(
  storage: Pick<Storage, "getItem"> | undefined,
  saved?: ModelProviderConfig | null
): ModelWorkspace {
  if (!storage) return createModelWorkspaceSeed(saved);
  try {
    const raw = storage.getItem(MODEL_WORKSPACE_STORAGE_KEY);
    if (!raw) return createModelWorkspaceSeed(saved);
    return parseModelWorkspace(JSON.parse(raw)) ?? createModelWorkspaceSeed(saved);
  } catch {
    return createModelWorkspaceSeed(saved);
  }
}

/** Writes the complete workspace atomically and reports quota/security failures. */
export function writeModelWorkspace(
  storage: Pick<Storage, "setItem"> | undefined,
  workspace: ModelWorkspace
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(MODEL_WORKSPACE_STORAGE_KEY, JSON.stringify(workspace));
    return true;
  } catch {
    return false;
  }
}

/** Persists and notifies same-window subscribers (native storage events do not). */
export function persistModelWorkspace(
  storage: Pick<Storage, "setItem"> | undefined,
  workspace: ModelWorkspace,
  eventTarget: EventTargetLike | undefined = browserEventTarget()
): boolean {
  const saved = writeModelWorkspace(storage, workspace);
  if (saved && eventTarget) {
    eventTarget.dispatchEvent(new Event(MODEL_WORKSPACE_EVENT));
  }
  return saved;
}

/** Subscribes to both same-window writes and cross-window localStorage updates. */
export function subscribeModelWorkspace(
  listener: () => void,
  eventTarget: EventTargetLike | undefined = browserEventTarget()
): () => void {
  if (!eventTarget) return () => undefined;
  const onWorkspaceEvent: EventListener = () => listener();
  const onStorage: EventListener = (event) => {
    if (!(event instanceof StorageEvent) || event.key === MODEL_WORKSPACE_STORAGE_KEY) {
      listener();
    }
  };
  eventTarget.addEventListener(MODEL_WORKSPACE_EVENT, onWorkspaceEvent);
  eventTarget.addEventListener("storage", onStorage);
  return () => {
    eventTarget.removeEventListener(MODEL_WORKSPACE_EVENT, onWorkspaceEvent);
    eventTarget.removeEventListener("storage", onStorage);
  };
}

/** Returns candidates in product order, filtered to one model capability. */
export function getModelCandidates(
  workspace: ModelWorkspace,
  mode: ModelWorkspaceMode,
  capability: ModelCapability = "chat"
): ModelCandidate[] {
  const byokCandidates = candidatesFromConnections(mode, workspace.spaces[mode].connections, capability);
  if (mode === "byok") return byokCandidates;
  return [
    ...workspace.platformModels
      .filter((model) => model.capability === capability)
      .map(platformModelCandidate),
    ...byokCandidates
  ];
}

/** Returns the explicit Agent candidate subset, or all text models for legacy workspaces. */
export function getTaskModelCandidates(
  workspace: ModelWorkspace,
  mode: ModelWorkspaceMode
): ModelCandidate[] {
  const textCandidates = getModelCandidates(workspace, mode, "chat");
  const selectedIds = workspace.spaces[mode].taskCandidateIds;
  if (!selectedIds) return textCandidates;
  const selected = new Set(selectedIds);
  return textCandidates.filter((candidate) => selected.has(candidate.id));
}

/**
 * Prepares the machine-local BYOK space before leaving account mode.
 * Legacy account-space connections are merged into the local space so logout
 * can stay on the current page without losing configured task models.
 */
export function prepareByokWorkspaceForAccountLogout(
  workspace: ModelWorkspace
): AccountLogoutByokPreparation {
  const localConnections = workspace.spaces.byok.connections;
  const accountConnections = workspace.spaces.account.connections;
  const mergedConnections = [...localConnections];

  for (const accountConnection of accountConnections) {
    const index = mergedConnections.findIndex(
      (connection) => normalizeProvider(connection.provider) === normalizeProvider(accountConnection.provider)
    );
    if (index >= 0) {
      mergedConnections[index] = accountConnection;
    } else {
      mergedConnections.push(accountConnection);
    }
  }

  const hasTaskModel = mergedConnections.some((connection) => (
    connection.models.some((model) => (connection.modelCapabilities?.[model] ?? "chat") === "chat")
  ));
  if (!hasTaskModel || accountConnections.length === 0) {
    return { workspace, hasTaskModel };
  }

  return {
    hasTaskModel: true,
    workspace: {
      ...workspace,
      spaces: {
        ...workspace.spaces,
        byok: {
          ...workspace.spaces.byok,
          connections: mergedConnections,
          taskCandidateIds: undefined
        }
      }
    }
  };
}

/** Replaces the Agent candidate subset while preserving product order. */
export function setTaskModelCandidates(
  workspace: ModelWorkspace,
  mode: ModelWorkspaceMode,
  candidateIds: readonly string[]
): ModelWorkspace {
  const available = getModelCandidates(workspace, mode, "chat");
  const requested = new Set(candidateIds);
  const taskCandidateIds = available
    .filter((candidate) => requested.has(candidate.id))
    .map((candidate) => candidate.id);
  if (taskCandidateIds.length === 0) return workspace;
  return {
    ...workspace,
    spaces: {
      ...workspace.spaces,
      [mode]: {
        ...workspace.spaces[mode],
        taskCandidateIds
      }
    }
  };
}

/** Adds or edits a connection while enforcing one provider per model space. */
export function upsertModelConnection(
  workspace: ModelWorkspace,
  mode: ModelWorkspaceMode,
  input: ModelConnectionInput
): ModelWorkspaceMutationResult {
  const provider = normalizeProvider(input.provider);
  const endpoint = input.endpoint.trim();
  const models = uniqueNames(input.models);
  const existing = input.id
    ? workspace.spaces[mode].connections.find((connection) => connection.id === input.id)
    : undefined;
  if (!provider || !endpoint || models.length === 0 || (!existing && !input.apiKey?.trim() && !input.apiKeyMasked?.trim())) {
    return { workspace, error: "invalid_connection" };
  }
  const duplicate = workspace.spaces[mode].connections.some(
    (connection) => connection.id !== input.id && normalizeProvider(connection.provider) === provider
  );
  if (duplicate) return { workspace, error: "duplicate_provider" };

  const apiKeyMasked = input.apiKey?.trim()
    ? maskApiKey(input.apiKey)
    : input.apiKeyMasked?.trim() || existing?.apiKeyMasked || "";
  const connection: ModelConnection = {
    id: existing?.id ?? input.id ?? createConnectionId(provider),
    provider,
    endpoint,
    apiKeyMasked,
    maxTokens: normalizeOptionalTokenLimit(input.maxTokens),
    dailyTokenLimit: normalizeOptionalTokenLimit(input.dailyTokenLimit),
    models,
    modelCapabilities: Object.fromEntries(models.map((model) => [
      model,
      input.modelCapabilities?.[model] ?? existing?.modelCapabilities?.[model] ?? "chat"
    ])),
    available: input.apiKey?.trim() ? true : existing?.available ?? true
  };
  const connections = existing
    ? workspace.spaces[mode].connections.map((item) => item.id === connection.id ? connection : item)
    : [...workspace.spaces[mode].connections, connection];
  return {
    workspace: replaceSpaceConnections(workspace, mode, connections),
    error: null
  };
}

/** Removes one provider connection; scoped selections intentionally remain stale. */
export function deleteModelConnection(
  workspace: ModelWorkspace,
  mode: ModelWorkspaceMode,
  connectionId: string
): ModelWorkspaceMutationResult {
  const connections = workspace.spaces[mode].connections;
  if (!connections.some((connection) => connection.id === connectionId)) {
    return { workspace, error: "connection_not_found" };
  }
  return {
    workspace: replaceSpaceConnections(
      workspace,
      mode,
      connections.filter((connection) => connection.id !== connectionId)
    ),
    error: null
  };
}

/** Adds one model name below an existing provider connection. */
export function addConnectionModel(
  workspace: ModelWorkspace,
  mode: ModelWorkspaceMode,
  connectionId: string,
  modelName: string,
  capability: ModelCapability = "chat"
): ModelWorkspaceMutationResult {
  const model = modelName.trim();
  if (!model) return { workspace, error: "invalid_model" };
  const connection = workspace.spaces[mode].connections.find((item) => item.id === connectionId);
  if (!connection) return { workspace, error: "connection_not_found" };
  if (connection.models.some((item) => item.toLocaleLowerCase() === model.toLocaleLowerCase())) {
    return { workspace, error: "duplicate_model" };
  }
  return updateConnectionModels(
    workspace,
    mode,
    connectionId,
    [...connection.models, model],
    { ...connection.modelCapabilities, [model]: capability }
  );
}

/** Removes a model name; deleting the final name leaves an editable empty card. */
export function deleteConnectionModel(
  workspace: ModelWorkspace,
  mode: ModelWorkspaceMode,
  connectionId: string,
  modelName: string
): ModelWorkspaceMutationResult {
  const connection = workspace.spaces[mode].connections.find((item) => item.id === connectionId);
  if (!connection) return { workspace, error: "connection_not_found" };
  return updateConnectionModels(
    workspace,
    mode,
    connectionId,
    connection.models.filter((model) => model !== modelName),
    Object.fromEntries(
      Object.entries(connection.modelCapabilities ?? {}).filter(([model]) => model !== modelName)
    )
  );
}

/** Updates one independent memory/specialty-model assignment. */
export function setModelAssignment(
  workspace: ModelWorkspace,
  mode: ModelWorkspaceMode,
  kind: ModelAssignmentKind,
  candidateId: string
): ModelWorkspace {
  return {
    ...workspace,
    spaces: {
      ...workspace.spaces,
      [mode]: {
        ...workspace.spaces[mode],
        assignments: {
          ...workspace.spaces[mode].assignments,
          [kind]: candidateId
        }
      }
    }
  };
}

/** Marks a tested connection available or unavailable for every selector. */
export function setModelConnectionAvailability(
  workspace: ModelWorkspace,
  mode: ModelWorkspaceMode,
  connectionId: string,
  available: boolean
): ModelWorkspace {
  return replaceSpaceConnections(
    workspace,
    mode,
    workspace.spaces[mode].connections.map((connection) => (
      connection.id === connectionId ? { ...connection, available } : connection
    ))
  );
}

/** Saves a selection under the existing agent chat/draft scope key. */
export function setScopedModelSelection(
  workspace: ModelWorkspace,
  mode: ModelWorkspaceMode,
  scopeKey: string,
  candidateId: string
): ModelWorkspace {
  const candidate = getTaskModelCandidates(workspace, mode)
    .find((item) => item.id === candidateId);
  return {
    ...workspace,
    selectionsByScope: {
      ...workspace.selectionsByScope,
      [scopeKey]: {
        mode,
        candidateId,
        ...(candidate?.model ? { model: candidate.model } : {}),
        ...(candidate?.provider ? { provider: candidate.provider } : {})
      }
    }
  };
}

/** Moves a draft selection to the newly created chat without touching others. */
export function transferScopedModelSelection(
  workspace: ModelWorkspace,
  fromScopeKey: string,
  toScopeKey: string
): ModelWorkspace {
  const selection = workspace.selectionsByScope[fromScopeKey];
  if (!selection || fromScopeKey === toScopeKey) return workspace;
  const selectionsByScope = { ...workspace.selectionsByScope };
  delete selectionsByScope[fromScopeKey];
  selectionsByScope[toScopeKey] = selection;
  return { ...workspace, selectionsByScope };
}

/** Copies a draft selection into a new chat while preserving the new-task preference. */
export function copyScopedModelSelection(
  workspace: ModelWorkspace,
  fromScopeKey: string,
  toScopeKey: string
): ModelWorkspace {
  const selection = workspace.selectionsByScope[fromScopeKey];
  if (!selection || fromScopeKey === toScopeKey) return workspace;
  return {
    ...workspace,
    selectionsByScope: {
      ...workspace.selectionsByScope,
      [toScopeKey]: selection
    }
  };
}

/**
 * Resolves one chat selection. A missing saved candidate stays unavailable
 * while alternatives exist; a completely empty space resolves to empty.
 * Switching account/BYOK preserves the model ID when possible, otherwise it
 * falls back to the new space's first item.
 */
export function resolveScopedModelSelection(
  workspace: ModelWorkspace,
  mode: ModelWorkspaceMode,
  scopeKey: string
): ResolvedModelSelection {
  const candidates = getTaskModelCandidates(workspace, mode);
  const saved = workspace.selectionsByScope[scopeKey];
  if (candidates.length === 0) {
    return {
      candidate: null,
      candidateId: null,
      unavailable: false,
      reason: "empty"
    };
  }
  if (!saved) {
    return { candidate: candidates[0]!, candidateId: candidates[0]!.id, unavailable: false, reason: "initial" };
  }
  if (saved.mode !== mode) {
    const previousModel = saved.model
      ?? getTaskModelCandidates(workspace, saved.mode)
        .find((candidate) => candidate.id === saved.candidateId)?.model
      ?? modelNameFromCandidateId(saved.candidateId);
    const preserved = previousModel
      ? candidates.find((candidate) => candidate.model === previousModel)
      : undefined;
    if (preserved) {
      return {
        candidate: preserved,
        candidateId: preserved.id,
        unavailable: false,
        previousModel,
        reason: "mode_preserved"
      };
    }
    return {
      candidate: candidates[0]!,
      candidateId: candidates[0]!.id,
      unavailable: false,
      previousModel,
      reason: "mode_changed"
    };
  }
  const candidate = candidates.find((item) => item.id === saved.candidateId) ?? null;
  if (!candidate) {
    return {
      candidate: null,
      candidateId: saved.candidateId,
      unavailable: true,
      previousModel: saved.model ?? modelNameFromCandidateId(saved.candidateId),
      previousProvider: saved.provider ?? providerFromUnavailableSelection(workspace, mode, saved.candidateId),
      reason: "unavailable"
    };
  }
  return { candidate, candidateId: candidate.id, unavailable: false, reason: "saved" };
}

/**
 * UI adapter for P1 usage. A single model can safely own the aggregate total;
 * with multiple models the current backend cannot attribute usage, so rows are
 * rendered without invented figures until the per-model contract is available.
 */
export function buildWorkspaceUsageRows(
  workspace: ModelWorkspace,
  mode: ModelWorkspaceMode,
  totals: WorkspaceUsageTotals
): WorkspaceUsageRow[] {
  const candidates = candidatesFromConnections(mode, workspace.spaces[mode].connections, null);
  if (candidates.length === 0) return [];
  const breakdownAvailable = candidates.length === 1;
  return candidates.map((candidate, index) => ({
    id: candidate.id,
    provider: candidate.provider,
    model: candidate.model,
    inputTokens: breakdownAvailable && index === 0 ? totals.inputTokens : 0,
    outputTokens: breakdownAvailable && index === 0 ? totals.outputTokens : 0,
    totalTokens: breakdownAvailable && index === 0 ? totals.totalTokens : 0,
    breakdownAvailable
  }));
}

/** Creates a consistently masked key without exposing the original in UI. */
export function maskApiKey(apiKey: string): string {
  const normalized = apiKey.trim();
  if (!normalized) return "";
  return `••••••••${normalized.slice(-4)}`;
}

export function modelCandidateId(mode: ModelWorkspaceMode, connectionId: string, model: string): string {
  return `${mode}:connection:${connectionId}:model:${encodeURIComponent(model)}`;
}

function modelNameFromCandidateId(candidateId: string): string | null {
  const marker = ":model:";
  const markerIndex = candidateId.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  try {
    return decodeURIComponent(candidateId.slice(markerIndex + marker.length)) || null;
  } catch {
    return null;
  }
}

function providerFromUnavailableSelection(
  workspace: ModelWorkspace,
  mode: ModelWorkspaceMode,
  candidateId: string
): string | null {
  const connectionId = connectionIdFromCandidateId(candidateId);
  if (!connectionId) return null;
  return workspace.spaces[mode].connections.find((connection) => connection.id === connectionId)?.provider ?? null;
}

function connectionIdFromCandidateId(candidateId: string): string | null {
  const prefix = ":connection:";
  const suffix = ":model:";
  const prefixIndex = candidateId.indexOf(prefix);
  const suffixIndex = candidateId.lastIndexOf(suffix);
  if (prefixIndex < 0 || suffixIndex <= prefixIndex + prefix.length) return null;
  return candidateId.slice(prefixIndex + prefix.length, suffixIndex) || null;
}

function browserEventTarget(): EventTargetLike | undefined {
  return typeof window === "undefined" ? undefined : window;
}

function connectionsFromLegacyConfig(saved?: ModelProviderConfig | null): ModelConnection[] {
  if (!saved?.configured || !saved.provider?.trim() || !saved.endpoint?.trim() || !saved.model?.trim()) return [];
  const legacyConfigs: Array<{
    capability: ModelCapability;
    config: {
      provider: string;
      endpoint: string;
      model: string;
      apiKey: string;
      apiKeyMasked: string;
      configured: boolean;
    } | null | undefined;
  }> = [
    { config: saved, capability: "chat" as const },
    { config: saved.memmyMemory?.summary, capability: "chat" as const },
    { config: saved.memmyMemory?.evolution, capability: "chat" as const },
    {
      config: saved.embedding?.configured ? { ...saved.embedding, provider: "openai" } : null,
      capability: "embedding" as const
    },
    { config: saved.asr, capability: "asr" as const },
    { config: saved.imageGen, capability: "image" as const }
  ];
  const connections: ModelConnection[] = [];
  for (const { config, capability } of legacyConfigs) {
    if (
      !config?.configured
      || !config.provider?.trim()
      || !config.endpoint?.trim()
      || !config.model?.trim()
    ) {
      continue;
    }
    const provider = normalizeProvider(config.provider);
    const existingIndex = connections.findIndex((connection) => connection.provider === provider);
    if (existingIndex >= 0) {
      const existing = connections[existingIndex]!;
      connections[existingIndex] = {
        ...existing,
        models: uniqueNames([...existing.models, config.model]),
        modelCapabilities: {
          ...existing.modelCapabilities,
          [config.model]: existing.modelCapabilities?.[config.model] ?? capability
        }
      };
      continue;
    }
    connections.push({
      id: `local-seed-${provider}`,
      provider,
      endpoint: config.endpoint.trim(),
      apiKeyMasked: config.apiKeyMasked?.trim() || maskApiKey(config.apiKey ?? ""),
      models: [config.model.trim()],
      modelCapabilities: { [config.model.trim()]: capability },
      available: true
    });
  }
  return connections;
}

function createLegacyAssignments(
  saved: ModelProviderConfig | null | undefined,
  candidates: ModelCandidate[]
): Partial<Record<ModelAssignmentKind, string>> {
  const byModel = (
    model: string | null | undefined,
    capability: ModelCapability
  ) => candidates.find((candidate) => candidate.model === model && candidate.capability === capability)?.id;
  const firstChat = candidates.find((candidate) => candidate.capability === "chat")?.id;
  const firstAsr = candidates.find((candidate) => candidate.capability === "asr")?.id;
  const firstImage = candidates.find((candidate) => candidate.capability === "image")?.id;
  return {
    memorySummary: byModel(saved?.memmyMemory?.summary?.model, "chat") ?? firstChat,
    memoryEvolution: byModel(saved?.memmyMemory?.evolution?.model, "chat") ?? firstChat,
    embedding: byModel(saved?.embedding?.model, "embedding") ?? "builtin:local-embedding",
    asr: byModel(saved?.asr?.model, "asr") ?? firstAsr,
    image: byModel(saved?.imageGen?.model, "image") ?? firstImage
  };
}

function createDefaultAssignments(
  candidates: ModelCandidate[],
  mode: ModelWorkspaceMode
): Partial<Record<ModelAssignmentKind, string>> {
  const firstChat = candidates.find((candidate) => candidate.capability === "chat")?.id;
  const firstEmbedding = candidates.find((candidate) => candidate.capability === "embedding")?.id;
  const firstAsr = candidates.find((candidate) => candidate.capability === "asr")?.id;
  const firstImage = candidates.find((candidate) => candidate.capability === "image")?.id;
  return {
    memorySummary: firstChat,
    memoryEvolution: firstChat,
    embedding: firstEmbedding ?? (mode === "account" ? "platform:memmy-platform:embedding" : "builtin:local-embedding"),
    asr: firstAsr,
    image: firstImage
  };
}

function candidatesFromConnections(
  mode: ModelWorkspaceMode,
  connections: readonly ModelConnection[],
  capability: ModelCapability | null
): ModelCandidate[] {
  return connections.flatMap((connection) => connection.available === false ? [] : connection.models
    .filter((model) => capability === null || modelCapability(connection, model) === capability)
    .map((model) => ({
    id: modelCandidateId(mode, connection.id, model),
    source: "byok" as const,
    provider: connection.provider,
    model,
    displayName: model,
    connectionId: connection.id,
    capability: modelCapability(connection, model)
  })));
}

function platformModelCandidate(model: PlatformModel): ModelCandidate {
  return {
    id: model.id,
    source: "platform",
    provider: model.provider,
    model: model.model,
    displayName: model.displayName,
    connectionId: null,
    capability: model.capability
  };
}

function replaceSpaceConnections(
  workspace: ModelWorkspace,
  mode: ModelWorkspaceMode,
  connections: ModelConnection[]
): ModelWorkspace {
  return {
    ...workspace,
    spaces: {
      ...workspace.spaces,
      [mode]: {
        ...workspace.spaces[mode],
        connections
      }
    }
  };
}

function updateConnectionModels(
  workspace: ModelWorkspace,
  mode: ModelWorkspaceMode,
  connectionId: string,
  models: string[],
  modelCapabilities?: Record<string, ModelCapability>
): ModelWorkspaceMutationResult {
  return {
    workspace: replaceSpaceConnections(
      workspace,
      mode,
      workspace.spaces[mode].connections.map((connection) => (
        connection.id === connectionId
          ? {
              ...connection,
              models,
              modelCapabilities: modelCapabilities ?? Object.fromEntries(
                models.map((model) => [model, modelCapability(connection, model)])
              )
            }
          : connection
      ))
    ),
    error: null
  };
}

function uniqueNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const name of names) {
    const normalized = name.trim();
    const key = normalized.toLocaleLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function normalizeProvider(provider: string): string {
  const normalized = provider.trim().toLocaleLowerCase();
  if (normalized === "openai_compatible") return "openai";
  if (normalized === "google") return "gemini";
  if (normalized === "kimi") return "moonshot";
  if (normalized === "aliyun") return "qwen";
  return normalized;
}

function normalizeOptionalTokenLimit(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function createConnectionId(provider: string): string {
  const suffix = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${provider}-${suffix}`;
}

function parseModelWorkspace(value: unknown): ModelWorkspace | null {
  if (!isRecord(value) || value.version !== MODEL_WORKSPACE_VERSION) return null;
  if (!Array.isArray(value.platformModels) || !isRecord(value.spaces) || !isRecord(value.selectionsByScope)) return null;
  const account = parseSpace(value.spaces.account);
  const byok = parseSpace(value.spaces.byok);
  if (!account || !byok) return null;
  const platformModels = PLATFORM_MODELS.map((model) => ({ ...model }));
  const selectionsByScope = Object.fromEntries(
    Object.entries(value.selectionsByScope).filter((entry): entry is [string, ScopedModelSelection] => (
      isScopedSelection(entry[1])
    ))
  );
  return {
    version: MODEL_WORKSPACE_VERSION,
    platformModels,
    spaces: { account, byok },
    selectionsByScope
  };
}

function parseSpace(value: unknown): ModelWorkspaceSpace | null {
  if (!isRecord(value) || !Array.isArray(value.connections) || !isRecord(value.assignments)) return null;
  return {
    connections: value.connections.filter(isModelConnection).map((connection) => ({
      id: connection.id,
      provider: connection.provider,
      endpoint: connection.endpoint,
      apiKeyMasked: connection.apiKeyMasked,
      maxTokens: connection.maxTokens,
      dailyTokenLimit: connection.dailyTokenLimit,
      models: uniqueNames(connection.models),
      modelCapabilities: Object.fromEntries(
        uniqueNames(connection.models).map((model) => [
          model,
          modelCapability(connection, model)
        ])
      ),
      available: connection.available
    })),
    assignments: Object.fromEntries(
      Object.entries(value.assignments).filter((entry): entry is [ModelAssignmentKind, string] => (
        isAssignmentKind(entry[0]) && typeof entry[1] === "string"
      ))
    ),
    taskCandidateIds: Array.isArray(value.taskCandidateIds)
      ? value.taskCandidateIds.filter((candidateId): candidateId is string => typeof candidateId === "string")
      : undefined
  };
}

function modelCapability(connection: ModelConnection, model: string): ModelCapability {
  return connection.modelCapabilities?.[model] ?? "chat";
}

function isModelCapability(value: unknown): value is ModelCapability {
  return value === "chat" || value === "embedding" || value === "asr" || value === "image";
}

function isModelConnection(value: unknown): value is ModelConnection {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.provider === "string"
    && typeof value.endpoint === "string"
    && typeof value.apiKeyMasked === "string"
    && isOptionalTokenLimit(value.maxTokens)
    && isOptionalTokenLimit(value.dailyTokenLimit)
    && Array.isArray(value.models)
    && value.models.every((model) => typeof model === "string")
    && (
      value.modelCapabilities === undefined
      || (
        isRecord(value.modelCapabilities)
        && Object.values(value.modelCapabilities).every(isModelCapability)
      )
    );
}

function isOptionalTokenLimit(value: unknown): value is number | undefined {
  return value === undefined || (
    typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
  );
}

function isScopedSelection(value: unknown): value is ScopedModelSelection {
  return isRecord(value)
    && (value.mode === "account" || value.mode === "byok")
    && typeof value.candidateId === "string";
}

function isAssignmentKind(value: string): value is ModelAssignmentKind {
  return value === "memorySummary"
    || value === "memoryEvolution"
    || value === "embedding"
    || value === "asr"
    || value === "image";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
