/** Pure view-model helpers for the canonical model catalog returned by the local API. */
import type {
  CatalogEndpointInput,
  CatalogProviderId,
  ModelAssignment,
  ModelCapability as CatalogCapability,
  ModelConfigInput,
  ModelConfigView,
  ModelEndpointProtocol,
  TextModelItemView
} from "@memmy/local-api-contracts";
import { CLIENT_PRESET_ID_PREFIX, type ModelProviderConfig } from "../api/config-client.js";

export const MODEL_WORKSPACE_STORAGE_KEY = "memmy-model-workspace-v1";

export type ModelWorkspaceMode = "account" | "byok";
export type ModelCapability = "chat" | "memorySummary" | "memoryEvolution" | "embedding" | "asr" | "image";
export type ModelAssignmentKind = "memorySummary" | "memoryEvolution" | "embedding" | "asr" | "image";
export type ModelWorkspaceMutationError =
  | "duplicate_provider"
  | "duplicate_model"
  | "invalid_connection"
  | "invalid_model"
  | "incompatible_model_capabilities"
  | "connection_not_found";

export interface ModelConnection {
  id: string;
  provider: string;
  endpointId: string;
  endpoint: string;
  protocol: ModelEndpointProtocol;
  apiKeyMasked: string;
  models: string[];
  modelEntries: ModelConnectionModel[];
  modelCapabilities: Record<string, ModelCapability>;
  presetIds: Record<string, string>;
  available: boolean;
  accountManaged: boolean;
}

export interface ModelConnectionModel {
  presetId: string;
  model: string;
  capability: ModelCapability;
  capabilities: CatalogCapability[];
}

export interface ModelWorkspaceSpace {
  connections: ModelConnection[];
  assignments: Partial<Record<ModelAssignmentKind, string>>;
  taskCandidateIds: string[];
  defaultTaskCandidateId: string | null;
}

export interface ModelWorkspace {
  catalog: ModelConfigView;
  spaces: Record<ModelWorkspaceMode, ModelWorkspaceSpace>;
}

export interface ModelCandidate {
  id: string;
  source: "platform" | "byok";
  provider: string;
  model: string;
  displayName: string;
  connectionId: string | null;
  endpointId: string;
  capability: ModelCapability;
  capabilities: CatalogCapability[];
  available: boolean;
}

export interface ModelConnectionInput {
  id?: string;
  provider: string;
  endpointId?: string;
  endpoint: string;
  protocol?: ModelEndpointProtocol;
  apiKey?: string;
  apiKeyMasked?: string;
  models: string[];
  modelEntries?: Array<{
    presetId?: string;
    model: string;
    capability: ModelCapability;
    capabilities?: ModelCapability[];
  }>;
  modelCapabilities?: Record<string, ModelCapability>;
}

export interface ModelWorkspaceMutationResult {
  workspace: ModelWorkspace;
  error: ModelWorkspaceMutationError | null;
}

export interface ByokPresetInput {
  provider: string;
  endpointId?: string;
  endpoint: string;
  protocol: ModelEndpointProtocol;
  apiKey?: string;
  apiKeyMasked?: string;
  model: string;
  capabilities: CatalogCapability[];
  presetId?: string;
}

export interface ResolvedModelSelection {
  candidate: ModelCandidate | null;
  candidateId: string | null;
  unavailable: boolean;
  reason: "saved" | "initial" | "unavailable" | "empty";
  previousModel?: string | null;
  previousProvider?: string | null;
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

const EMPTY_ASSIGNMENT: Omit<ModelAssignment, "ownerAccountId"> = {
  agent: { candidates: [], default: null },
  memorySummary: null,
  memoryEvolution: null,
  embedding: null,
  asr: null,
  imageGeneration: null
};

/** Returns the catalog embedded in app state, or an inert pre-bootstrap catalog. */
export function catalogFromConfig(config?: ModelProviderConfig | null): ModelConfigView {
  return config?.catalog ?? emptyCatalog();
}

/** Builds the UI workspace directly from the server catalog. No legacy or browser state is imported. */
export function createModelWorkspace(config?: ModelProviderConfig | ModelConfigView | null): ModelWorkspace {
  const catalog = isCatalogView(config) ? config : catalogFromConfig(config);
  return {
    catalog,
    spaces: {
      account: createSpace(catalog, "account"),
      byok: createSpace(catalog, "byok")
    }
  };
}

/** Removes the obsolete cache after a successful catalog read. */
export function clearLegacyModelWorkspace(storage?: Pick<Storage, "removeItem">): void {
  try {
    storage?.removeItem(MODEL_WORKSPACE_STORAGE_KEY);
  } catch {
    // A denied browser storage area must not make a successful API read fail.
  }
}

/** Converts a view-model mutation back to the PUT DTO while retaining every catalog field. */
export function modelConfigInput(workspace: ModelWorkspace): ModelConfigInput {
  return modelConfigInputFromView(workspace.catalog);
}

export function modelConfigInputFromView(view: ModelConfigView): ModelConfigInput {
  return {
    configRevision: view.configRevision,
    providers: view.providers.filter((provider) => provider.editable && !provider.accountManaged).map((provider) => ({
      provider: provider.provider,
      ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
      ...(provider.ownerAccountId ? { ownerAccountId: provider.ownerAccountId } : {}),
      endpoints: provider.endpoints.map(endpointInput),
      models: provider.models.map((model) => ({
        presetId: model.presetId,
        endpointId: model.endpointId,
        model: model.model,
        source: model.source,
        ...(model.ownerAccountId ? { ownerAccountId: model.ownerAccountId } : {}),
        capabilities: [...model.capabilities]
      }))
    })),
    modelAssignments: cloneAssignments(view.modelAssignments)
  };
}

/** Adds or patches exactly one BYOK endpoint/preset and leaves all other catalog data untouched. */
export function upsertByokPreset(
  workspace: ModelWorkspace,
  input: ByokPresetInput
): { workspace: ModelWorkspace; presetId: string; endpointId: string } {
  const providerId = normalizeProvider(input.provider);
  const apiBase = input.endpoint.trim().replace(/\/+$/, "");
  const model = input.model.trim();
  if (!providerId || !isHttpUrl(apiBase) || !model || !input.capabilities.length) {
    throw new Error("invalid catalog preset");
  }
  if (!input.capabilities.every((capability) => protocolSupportsCatalog(input.protocol, capability))) {
    throw new Error("endpoint protocol does not support preset capabilities");
  }
  const next = cloneCatalog(workspace.catalog);
  let provider = next.providers.find((item) => item.provider === providerId && !item.accountManaged);
  if (!provider) {
    provider = {
      provider: providerId,
      configured: Boolean(input.apiKey),
      hasApiKey: Boolean(input.apiKey),
      apiKeyMasked: input.apiKey ? maskApiKey(input.apiKey) : "",
      apiKey: "",
      endpoints: [],
      accountManaged: false,
      editable: true,
      models: []
    };
    next.providers.push(provider);
  }
  let endpoint = provider.endpoints.find((item) => (
    input.endpointId
      ? item.endpointId === input.endpointId
      : item.apiBase.replace(/\/+$/, "") === apiBase
        && item.protocol === input.protocol
        && endpointAuthMatches(item, input)
  ));
  if (endpoint && input.endpointId && (
    endpoint.apiBase.replace(/\/+$/, "") !== apiBase
    || endpoint.protocol !== input.protocol
    || (input.apiKeyMasked && !input.apiKey && endpoint.apiKeyMasked !== input.apiKeyMasked)
  )) {
    throw new Error("explicit endpoint identity does not match model configuration");
  }
  if (!endpoint) {
    if (input.endpointId) throw new Error("explicit endpoint identity was not found");
    if (input.apiKeyMasked && !input.apiKey) {
      throw new Error("masked endpoint credentials require an explicit endpoint ID");
    }
    endpoint = {
      endpointId: newId("endpoint"),
      apiBase,
      protocol: input.protocol,
      hasApiKey: Boolean(input.apiKey),
      apiKeyMasked: input.apiKey ? maskApiKey(input.apiKey) : input.apiKeyMasked ?? "",
      apiKey: input.apiKey ?? ""
    };
    provider.endpoints.push(endpoint);
  } else if (input.apiKey) {
    endpoint.apiKey = input.apiKey;
    endpoint.apiKeyMasked = maskApiKey(input.apiKey);
    endpoint.hasApiKey = true;
  }
  const existing = provider.models.find((item) => (
    item.source === "byok"
    && item.endpointId === endpoint!.endpointId
    && item.model === model
  ));
  const presetId = existing?.presetId ?? input.presetId ?? newClientPresetId();
  const preset = {
    presetId,
    provider: providerId,
    endpointId: endpoint.endpointId,
    protocol: input.protocol,
    model,
    source: "byok" as const,
    capabilities: unique([...(existing?.capabilities ?? []), ...input.capabilities]) as CatalogCapability[],
    available: true
  };
  if (existing) Object.assign(existing, preset);
  else provider.models.push(preset);
  refreshEffectiveCandidates(next);
  return { workspace: createModelWorkspace(next), presetId, endpointId: endpoint.endpointId };
}

/** Assigns one preset in one mode without touching the other mode. */
export function assignCatalogPreset(
  workspace: ModelWorkspace,
  mode: ModelWorkspaceMode,
  capability: CatalogCapability,
  presetId: string
): ModelWorkspace {
  const candidate = visiblePresets(workspace.catalog, mode)
    .find((item) => item.presetId === presetId && item.capabilities.includes(capability));
  if (!candidate) return workspace;
  const next = cloneCatalog(workspace.catalog);
  const assignment = next.modelAssignments[mode];
  if (capability === "agent") {
    assignment.agent.candidates = unique([...assignment.agent.candidates, presetId]);
    assignment.agent.default = presetId;
  } else if (capability === "memory_summary") assignment.memorySummary = presetId;
  else if (capability === "memory_evolution") assignment.memoryEvolution = presetId;
  else if (capability === "embedding") assignment.embedding = presetId;
  else if (capability === "asr") assignment.asr = presetId;
  else assignment.imageGeneration = presetId;
  return createModelWorkspace(next);
}

/** Resolves the endpoint identity currently assigned to a catalog capability. */
export function assignedCatalogEndpointId(
  workspace: ModelWorkspace,
  mode: ModelWorkspaceMode,
  capability: CatalogCapability
): string | undefined {
  const assignment = workspace.catalog.modelAssignments[mode];
  const presetId = capability === "agent"
    ? assignment.agent.default ?? assignment.agent.candidates[0]
    : capability === "memory_summary"
      ? assignment.memorySummary
      : capability === "memory_evolution"
        ? assignment.memoryEvolution
        : capability === "embedding"
          ? assignment.embedding
          : capability === "asr"
            ? assignment.asr
            : assignment.imageGeneration;
  if (!presetId) return undefined;
  return workspace.catalog.providers.flatMap((provider) => provider.models)
    .find((preset) => preset.presetId === presetId)?.endpointId;
}

export function getModelCandidates(
  workspace: ModelWorkspace,
  mode: ModelWorkspaceMode,
  capability: ModelCapability = "chat"
): ModelCandidate[] {
  const required = toCatalogCapability(capability);
  return visiblePresets(workspace.catalog, mode)
    .filter((preset) => preset.capabilities.includes(required))
    .map((preset) => candidateFromPreset(workspace.catalog, preset, capability));
}

export function getTaskModelCandidates(workspace: ModelWorkspace, mode: ModelWorkspaceMode): ModelCandidate[] {
  const candidates = getModelCandidates(workspace, mode, "chat");
  const order = workspace.catalog.modelAssignments[mode].agent.candidates;
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  return order.map((id) => byId.get(id)).filter((candidate): candidate is ModelCandidate => Boolean(candidate));
}

export function resolveModelSelection(
  workspace: ModelWorkspace,
  mode: ModelWorkspaceMode,
  selectedPresetId?: string | null
): ResolvedModelSelection {
  const candidates = getTaskModelCandidates(workspace, mode);
  if (!candidates.length) {
    return selectedPresetId
      ? { candidate: null, candidateId: selectedPresetId, unavailable: true, reason: "unavailable" }
      : { candidate: null, candidateId: null, unavailable: false, reason: "empty" };
  }
  const candidateId = selectedPresetId ?? workspace.catalog.modelAssignments[mode].agent.default;
  if (!candidateId) {
    return { candidate: candidates[0]!, candidateId: candidates[0]!.id, unavailable: false, reason: "initial" };
  }
  const candidate = candidates.find((item) => item.id === candidateId) ?? null;
  return candidate
    ? { candidate, candidateId, unavailable: !candidate.available, reason: "saved" }
    : { candidate: null, candidateId, unavailable: true, reason: "unavailable" };
}

export function upsertModelConnection(
  workspace: ModelWorkspace,
  mode: ModelWorkspaceMode,
  input: ModelConnectionInput
): ModelWorkspaceMutationResult {
  const providerId = normalizeProvider(input.provider);
  const endpoint = input.endpoint.trim().replace(/\/+$/, "");
  const entries: Array<{ presetId?: string; model: string; capabilities: ModelCapability[]; capabilitiesExplicit: boolean }> = input.modelEntries?.length
    ? input.modelEntries.map((entry) => ({
        ...(entry.presetId ? { presetId: entry.presetId } : {}),
        model: entry.model.trim(),
        capabilities: unique(entry.capabilities?.length ? entry.capabilities : [entry.capability]),
        capabilitiesExplicit: Boolean(entry.capabilities?.length),
      })).filter((entry) => Boolean(entry.model))
    : input.models.map((model) => ({
        model: model.trim(),
        capabilities: [modelCapability(input, model)],
        capabilitiesExplicit: false,
      })).filter((entry) => Boolean(entry.model));
  const models = entries.map((entry) => entry.model);
  if (!providerId || !isHttpUrl(endpoint) || !models.length) {
    return { workspace, error: "invalid_connection" };
  }
  if (new Set(entries.map((entry) => entry.model.toLowerCase())).size !== entries.length) {
    return { workspace, error: "duplicate_model" };
  }

  const next = cloneCatalog(workspace.catalog);
  const existingConnection = input.id
    ? workspace.spaces[mode].connections.find((connection) => connection.id === input.id)
    : undefined;
  let endpointId = existingConnection?.endpointId ?? input.endpointId ?? newId("endpoint");
  if (
    existingConnection
    && existingConnection.provider !== providerId
    && next.providers.some((item) => (
      item.provider === providerId
      && item.endpoints.some((candidate) => candidate.endpointId === endpointId)
    ))
  ) {
    endpointId = newId("endpoint");
  }
  const protocol = input.protocol ?? protocolFor(providerId, entries[0]!.capabilities[0]!);
  if (!protocolSupportsModelCapabilities(protocol, entries.flatMap((entry) => entry.capabilities))) {
    return { workspace, error: "incompatible_model_capabilities" };
  }

  const previousEndpointId = existingConnection?.endpointId;
  const previousProvider = existingConnection
    ? next.providers.find((item) => item.provider === existingConnection.provider && !item.accountManaged)
    : undefined;
  if (previousProvider && previousEndpointId) {
    previousProvider.endpoints = previousProvider.endpoints.filter((item) => item.endpointId !== previousEndpointId);
    previousProvider.models = previousProvider.models.filter((item) => item.endpointId !== previousEndpointId);
    if (previousProvider.provider !== providerId && (!previousProvider.endpoints.length || !previousProvider.models.length)) {
      next.providers = next.providers.filter((item) => item !== previousProvider);
    }
  }

  let provider = next.providers.find((item) => item.provider === providerId && !item.accountManaged);
  if (!provider) {
    provider = {
      provider: providerId,
      configured: Boolean(input.apiKey),
      hasApiKey: Boolean(input.apiKey),
      apiKeyMasked: input.apiKey ? maskApiKey(input.apiKey) : input.apiKeyMasked ?? "",
      apiKey: "",
      endpoints: [],
      accountManaged: false,
      editable: true,
      models: []
    };
    next.providers.push(provider);
  }

  provider.endpoints.push({
    endpointId,
    apiBase: endpoint,
    protocol,
    hasApiKey: Boolean(input.apiKey || input.apiKeyMasked),
    apiKeyMasked: input.apiKey ? maskApiKey(input.apiKey) : input.apiKeyMasked ?? "",
    apiKey: input.apiKey ?? ""
  });
  provider.models.push(...entries.map((entry, index) => {
    const model = entry.model;
    const previousPreset = existingConnection
      ? (entry.presetId ? nextPresetById(workspace.catalog, entry.presetId) : null)
        ?? nextPresetByModelAndCapability(workspace.catalog, existingConnection.endpointId, model, entry.capabilities[0]!)
        ?? nextPresetByModel(workspace.catalog, existingConnection.endpointId, existingConnection.models[index] ?? "")
      : null;
    const selectedCapability = entry.capabilities[0]!;
    const capabilities = entry.capabilitiesExplicit
      ? unique(entry.capabilities.map(toCatalogCapability))
      : previousPreset && fromCapabilities(previousPreset.capabilities) === selectedCapability
        ? [...previousPreset.capabilities]
        : [toCatalogCapability(selectedCapability)];
    return {
      presetId: previousPreset?.presetId ?? newClientPresetId(),
      provider: providerId,
      endpointId,
      protocol,
      model,
      source: "byok" as const,
      capabilities,
      available: true
    };
  }));

  const nextPresetIds = provider.models.filter((item) => item.endpointId === endpointId).map((item) => item.presetId);
  const nextAgentPresetIds = provider.models
    .filter((item) => item.endpointId === endpointId && item.capabilities.includes("agent"))
    .map((item) => item.presetId);
  const previousPresetIds = existingConnection
    ? existingConnection.modelEntries.map((entry) => entry.presetId)
    : [];
  const assignment = next.modelAssignments[mode];
  assignment.agent.candidates = replaceIds(assignment.agent.candidates, previousPresetIds, nextAgentPresetIds);
  if (!assignment.agent.candidates.length) assignment.agent.candidates = [...nextAgentPresetIds];
  if (!assignment.agent.default || previousPresetIds.includes(assignment.agent.default)) {
    assignment.agent.default = nextPresetIds.find((id) => presetHasCapability(next, id, "agent")) ?? assignment.agent.default;
  }
  refreshEffectiveCandidates(next);
  return { workspace: createModelWorkspace(next), error: null };
}

export function deleteModelConnection(
  workspace: ModelWorkspace,
  mode: ModelWorkspaceMode,
  connectionId: string
): ModelWorkspaceMutationResult {
  const connection = workspace.spaces[mode].connections.find((item) => item.id === connectionId);
  if (!connection || connection.accountManaged) return { workspace, error: "connection_not_found" };
  const next = cloneCatalog(workspace.catalog);
  const provider = next.providers.find((item) => item.provider === connection.provider && !item.accountManaged);
  if (!provider) return { workspace, error: "connection_not_found" };
  const removedIds = provider.models.filter((item) => item.endpointId === connection.endpointId).map((item) => item.presetId);
  provider.endpoints = provider.endpoints.filter((item) => item.endpointId !== connection.endpointId);
  provider.models = provider.models.filter((item) => item.endpointId !== connection.endpointId);
  if (!provider.endpoints.length || !provider.models.length) {
    next.providers = next.providers.filter((item) => item !== provider);
  }
  clearAssignmentReferences(next.modelAssignments.byok, removedIds);
  clearAssignmentReferences(next.modelAssignments.account, removedIds);
  refreshEffectiveCandidates(next);
  return { workspace: createModelWorkspace(next), error: null };
}

export function setModelConnectionAvailability(
  workspace: ModelWorkspace,
  _mode: ModelWorkspaceMode,
  connectionId: string,
  available: boolean
): ModelWorkspace {
  const next = cloneCatalog(workspace.catalog);
  for (const provider of next.providers) {
    for (const model of provider.models) {
      if (`${provider.provider}:${model.endpointId}` === connectionId) model.available = available;
    }
  }
  refreshEffectiveCandidates(next);
  return createModelWorkspace(next);
}

export function setTaskModelCandidates(
  workspace: ModelWorkspace,
  mode: ModelWorkspaceMode,
  candidateIds: string[]
): ModelWorkspace {
  const next = cloneCatalog(workspace.catalog);
  const allowed = new Set(getModelCandidates(workspace, mode, "chat").map((candidate) => candidate.id));
  const selected = unique(candidateIds.filter((id) => allowed.has(id)));
  next.modelAssignments[mode].agent.candidates = selected;
  if (!selected.includes(next.modelAssignments[mode].agent.default ?? "")) {
    next.modelAssignments[mode].agent.default = selected[0] ?? null;
  }
  return createModelWorkspace(next);
}

export function setDefaultTaskModel(
  workspace: ModelWorkspace,
  mode: ModelWorkspaceMode,
  candidateId: string
): ModelWorkspace {
  const next = cloneCatalog(workspace.catalog);
  if (next.modelAssignments[mode].agent.candidates.includes(candidateId)) {
    next.modelAssignments[mode].agent.default = candidateId;
  }
  return createModelWorkspace(next);
}

export function setModelAssignment(
  workspace: ModelWorkspace,
  mode: ModelWorkspaceMode,
  kind: ModelAssignmentKind,
  candidateId: string
): ModelWorkspace {
  const capability = assignmentCapability(kind);
  const allowed = new Set(getModelCandidates(workspace, mode, capability).map((candidate) => candidate.id));
  if (!allowed.has(candidateId)) return workspace;
  const next = cloneCatalog(workspace.catalog);
  const key = kind === "image" ? "imageGeneration" : kind;
  next.modelAssignments[mode][key] = candidateId;
  return createModelWorkspace(next);
}

export function maskApiKey(apiKey: string): string {
  const normalized = apiKey.trim();
  if (!normalized) return "";
  return `••••••••${normalized.slice(-4)}`;
}

export function buildWorkspaceUsageRows(
  workspace: ModelWorkspace,
  mode: ModelWorkspaceMode,
  usage: WorkspaceUsageTotals
): WorkspaceUsageRow[] {
  const candidates = getModelCandidates(workspace, mode).filter((candidate) => candidate.source === "byok");
  const attributable = candidates.length === 1;
  return candidates.map((candidate) => ({
    id: candidate.id,
    provider: candidate.provider,
    model: candidate.model,
    inputTokens: attributable ? usage.inputTokens : 0,
    outputTokens: attributable ? usage.outputTokens : 0,
    totalTokens: attributable ? usage.totalTokens : 0,
    breakdownAvailable: attributable
  }));
}

function createSpace(catalog: ModelConfigView, mode: ModelWorkspaceMode): ModelWorkspaceSpace {
  const candidates = visiblePresets(catalog, mode);
  const visibleIds = new Set(candidates.map((preset) => preset.presetId));
  const connections = catalog.providers.flatMap((provider): ModelConnection[] => provider.endpoints.flatMap((endpoint): ModelConnection[] => {
    const models = provider.models.filter((model) => (
      model.endpointId === endpoint.endpointId
      && visibleIds.has(model.presetId)
    ));
    if (!models.length || provider.accountManaged) return [];
    const id = `${provider.provider}:${endpoint.endpointId}`;
    return [{
      id,
      provider: provider.provider,
      endpointId: endpoint.endpointId,
      endpoint: endpoint.apiBase,
      protocol: endpoint.protocol,
      apiKeyMasked: endpoint.apiKeyMasked || provider.apiKeyMasked,
      models: models.map((model) => model.model),
      modelEntries: models.map((model) => ({
        presetId: model.presetId,
        model: model.model,
        capability: fromCapabilities(model.capabilities),
        capabilities: [...model.capabilities]
      })),
      modelCapabilities: Object.fromEntries(models.map((model) => [model.model, fromCapabilities(model.capabilities)])),
      presetIds: Object.fromEntries(models.map((model) => [model.model, model.presetId])),
      available: models.some((model) => model.available),
      accountManaged: provider.accountManaged
    }];
  }));
  const assignment = catalog.modelAssignments[mode];
  return {
    connections,
    assignments: {
      memorySummary: assignment.memorySummary ?? undefined,
      memoryEvolution: assignment.memoryEvolution ?? undefined,
      embedding: assignment.embedding ?? undefined,
      asr: assignment.asr ?? undefined,
      image: assignment.imageGeneration ?? undefined
    },
    taskCandidateIds: [...assignment.agent.candidates],
    defaultTaskCandidateId: assignment.agent.default
  };
}

function candidateFromPreset(catalog: ModelConfigView, preset: TextModelItemView, capability: ModelCapability): ModelCandidate {
  const provider = catalog.providers.find((item) => item.provider === preset.provider);
  return {
    id: preset.presetId,
    source: preset.source === "account" ? "platform" : "byok",
    provider: preset.provider,
    model: preset.model,
    displayName: preset.model,
    connectionId: preset.source === "account" ? null : `${preset.provider}:${preset.endpointId}`,
    endpointId: preset.endpointId,
    capability,
    capabilities: [...preset.capabilities],
    available: preset.available && Boolean(provider)
  };
}

function endpointInput(endpoint: ModelConfigView["providers"][number]["endpoints"][number]): CatalogEndpointInput {
  return {
    endpointId: endpoint.endpointId,
    apiBase: endpoint.apiBase,
    protocol: endpoint.protocol,
    ...(endpoint.apiKey ? { apiKey: endpoint.apiKey } : {})
  };
}

function emptyCatalog(): ModelConfigView {
  return {
    configRevision: "unavailable",
    providers: [],
    modelAssignments: { byok: cloneAssignment(EMPTY_ASSIGNMENT), account: cloneAssignment(EMPTY_ASSIGNMENT) },
    effectiveCandidates: { byok: [], account: [] },
    configured: false,
    updatedAt: new Date(0).toISOString()
  };
}

function isCatalogView(value: unknown): value is ModelConfigView {
  return Boolean(value && typeof value === "object" && "effectiveCandidates" in value && "modelAssignments" in value);
}

function cloneCatalog(catalog: ModelConfigView): ModelConfigView {
  return structuredClone(catalog);
}

function cloneAssignments(assignments: ModelConfigView["modelAssignments"]): ModelConfigView["modelAssignments"] {
  return { byok: cloneAssignment(assignments.byok), account: cloneAssignment(assignments.account) };
}

function cloneAssignment<T extends Omit<ModelAssignment, "ownerAccountId"> | ModelAssignment>(assignment: T): T {
  return { ...assignment, agent: { candidates: [...assignment.agent.candidates], default: assignment.agent.default } };
}

function normalizeProvider(provider: string): CatalogProviderId | null {
  const normalized = provider.trim().toLowerCase();
  const aliases: Record<string, CatalogProviderId> = { qwen: "dashscope", kimi: "moonshot", baidu: "qianfan", doubao: "volcengine" };
  const candidate = aliases[normalized] ?? normalized;
  return ["openai", "anthropic", "gemini", "deepseek", "zhipu", "dashscope", "moonshot", "minimax", "qianfan", "volcengine", "memmy_account"].includes(candidate)
    ? candidate as CatalogProviderId
    : null;
}

function protocolFor(provider: CatalogProviderId, capability: ModelCapability): ModelEndpointProtocol {
  if (capability === "embedding") return "openai-embeddings";
  if (capability === "asr") return "dashscope-input-audio-chat";
  if (capability === "image") return provider === "dashscope" ? "dashscope-multimodal-generation" : "openai-images";
  if (provider === "anthropic") return "anthropic-messages";
  if (provider === "gemini") return "gemini-generate-content";
  if (provider === "memmy_account") return "memmy-account";
  return "openai-chat-completions";
}

export function protocolSupportsModelCapabilities(protocol: ModelEndpointProtocol, capabilities: ModelCapability[]): boolean {
  return capabilities.every((capability) => protocolSupportsCatalog(protocol, toCatalogCapability(capability)));
}

function protocolSupportsCatalog(protocol: ModelEndpointProtocol, capability: CatalogCapability): boolean {
  if (capability === "agent" || capability === "memory_summary" || capability === "memory_evolution") {
    return protocolForCapability(protocol) === "chat";
  }
  if (capability === "image_generation") return protocolForCapability(protocol) === "image";
  return protocolForCapability(protocol) === capability;
}

function protocolForCapability(protocol: ModelEndpointProtocol): ModelCapability {
  if (protocol === "openai-embeddings") return "embedding";
  if (protocol === "dashscope-input-audio-chat") return "asr";
  if (protocol === "openai-images" || protocol === "dashscope-multimodal-generation") return "image";
  return "chat";
}

function modelCapability(input: ModelConnectionInput, model: string): ModelCapability {
  return input.modelCapabilities?.[model] ?? "chat";
}

function toCatalogCapability(capability: ModelCapability): CatalogCapability {
  if (capability === "chat") return "agent";
  if (capability === "memorySummary") return "memory_summary";
  if (capability === "memoryEvolution") return "memory_evolution";
  if (capability === "image") return "image_generation";
  return capability;
}

function fromCapabilities(capabilities: CatalogCapability[]): ModelCapability {
  if (capabilities.includes("agent")) return "chat";
  if (capabilities.includes("memory_summary")) return "memorySummary";
  if (capabilities.includes("memory_evolution")) return "memoryEvolution";
  if (capabilities.includes("embedding")) return "embedding";
  if (capabilities.includes("asr")) return "asr";
  return "image";
}

function assignmentCapability(kind: ModelAssignmentKind): ModelCapability {
  if (kind === "memorySummary") return "memorySummary";
  if (kind === "memoryEvolution") return "memoryEvolution";
  if (kind === "embedding") return "embedding";
  if (kind === "asr") return "asr";
  if (kind === "image") return "image";
  return "chat";
}

function nextPresetByModel(catalog: ModelConfigView, endpointId: string, model: string): TextModelItemView | null {
  return catalog.providers.flatMap((provider) => provider.models)
    .find((preset) => preset.endpointId === endpointId && preset.model === model) ?? null;
}

function nextPresetByModelAndCapability(
  catalog: ModelConfigView,
  endpointId: string,
  model: string,
  capability: ModelCapability
): TextModelItemView | null {
  return catalog.providers.flatMap((provider) => provider.models)
    .find((preset) => (
      preset.endpointId === endpointId
      && preset.model === model
      && fromCapabilities(preset.capabilities) === capability
    )) ?? null;
}

function nextPresetById(catalog: ModelConfigView, presetId: string): TextModelItemView | null {
  return catalog.providers.flatMap((provider) => provider.models)
    .find((preset) => preset.presetId === presetId) ?? null;
}

function replaceIds(current: string[], oldIds: string[], nextIds: string[]): string[] {
  const old = new Set(oldIds);
  const kept = current.filter((id) => !old.has(id));
  return unique([...kept, ...nextIds]);
}

function clearAssignmentReferences(assignment: ModelAssignment, removedIds: string[]): void {
  const removed = new Set(removedIds);
  assignment.agent.candidates = assignment.agent.candidates.filter((id) => !removed.has(id));
  if (assignment.agent.default && removed.has(assignment.agent.default)) assignment.agent.default = assignment.agent.candidates[0] ?? null;
  for (const key of ["memorySummary", "memoryEvolution", "embedding", "asr", "imageGeneration"] as const) {
    if (assignment[key] && removed.has(assignment[key]!)) assignment[key] = null;
  }
}

function refreshEffectiveCandidates(catalog: ModelConfigView): void {
  const presets = catalog.providers.flatMap((provider) => provider.models);
  const byId = new Map(presets.map((preset) => [preset.presetId, preset]));
  catalog.effectiveCandidates.byok = catalog.modelAssignments.byok.agent.candidates
    .map((presetId) => byId.get(presetId))
    .filter((preset): preset is TextModelItemView => Boolean(preset));
  catalog.effectiveCandidates.account = catalog.modelAssignments.account.agent.candidates
    .map((presetId) => byId.get(presetId))
    .filter((preset): preset is TextModelItemView => Boolean(preset));
  catalog.configured = catalog.modelAssignments.byok.agent.candidates.length > 0
    || catalog.modelAssignments.account.agent.candidates.length > 0;
}

function visiblePresets(catalog: ModelConfigView, mode: ModelWorkspaceMode): TextModelItemView[] {
  const ownerAccountId = catalog.modelAssignments.account.ownerAccountId;
  return catalog.providers.flatMap((provider) => provider.models).filter((preset) => {
    if (preset.source === "byok") return true;
    return mode === "account"
      && Boolean(ownerAccountId)
      && preset.ownerAccountId === ownerAccountId;
  });
}

function presetHasCapability(catalog: ModelConfigView, presetId: string, capability: CatalogCapability): boolean {
  return catalog.providers.some((provider) => provider.models.some((preset) => preset.presetId === presetId && preset.capabilities.includes(capability)));
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function newId(prefix: string): string {
  return globalThis.crypto?.randomUUID?.() ?? `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function unique<T extends string>(values: T[]): T[] {
  return [...new Set(values)];
}

function endpointAuthMatches(
  endpoint: ModelConfigView["providers"][number]["endpoints"][number],
  input: Pick<ByokPresetInput, "apiKey" | "apiKeyMasked">
): boolean {
  if (input.apiKey) return endpoint.apiKey === input.apiKey;
  if (input.apiKeyMasked) return false;
  return !endpoint.hasApiKey && !endpoint.apiKey && !endpoint.apiKeyMasked;
}

function newClientPresetId(): string {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${CLIENT_PRESET_ID_PREFIX}${suffix}`;
}
