import {
  BUILTIN_LOCAL_EMBEDDING_ASSIGNMENT_ID,
  type CatalogEndpointInput,
  type CatalogProviderId,
  type ModelAssignment,
  type ModelAssignments,
  type ModelCapability,
  type ModelConfigInput,
  type ModelConfigView,
  type ModelEndpointProtocol,
  type TextModelItemInput,
  type TextModelItemView,
  type TextModelProviderInput,
  type TextModelProviderView
} from "@memmy/local-api-contracts";
import { mutateRuntimeConfig } from "@memmy/migrations";
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import YAML from "yaml";

const ACCOUNT_PROVIDER = "memmy_account" as const;
const API_KEY_OPTIONAL_PROVIDERS = new Set<CatalogProviderId>();
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

type ConfigRecord = Record<string, unknown>;

const CAPABILITY_PROTOCOLS: Readonly<Record<ModelCapability, ReadonlySet<ModelEndpointProtocol>>> = {
  agent: new Set(["openai-chat-completions", "openai-responses", "anthropic-messages", "gemini-generate-content", "memmy-account"]),
  memory_summary: new Set(["openai-chat-completions", "anthropic-messages", "gemini-generate-content", "memmy-account"]),
  memory_evolution: new Set(["openai-chat-completions", "anthropic-messages", "gemini-generate-content", "memmy-account"]),
  embedding: new Set(["openai-embeddings", "memmy-account"]),
  asr: new Set(["dashscope-input-audio-chat", "memmy-account"]),
  image_generation: new Set(["openai-images", "dashscope-multimodal-generation", "memmy-account"])
};

const ASSIGNMENT_CAPABILITIES = {
  memorySummary: "memory_summary",
  memoryEvolution: "memory_evolution",
  embedding: "embedding",
  asr: "asr",
  imageGeneration: "image_generation"
} as const satisfies Readonly<Record<Exclude<keyof ModelAssignment, "ownerAccountId" | "agent">, ModelCapability>>;

export class ModelConfigChangedError extends Error {
  readonly code = "model_config_changed";

  constructor() {
    super("Model configuration changed in another entry point");
    this.name = "ModelConfigChangedError";
  }
}

export class InvalidModelConfigError extends Error {
  readonly code = "invalid_argument";

  constructor(message: string) {
    super(message);
    this.name = "InvalidModelConfigError";
  }
}

export async function readModelConfigCatalog(configPath: string): Promise<ModelConfigView> {
  const target = resolve(configPath);
  const { content, config } = await readConfig(target);
  return buildModelConfigView(config, revisionFor(config), await updatedAt(target, content));
}

export async function writeModelConfigCatalog(
  configPath: string,
  input: ModelConfigInput
): Promise<ModelConfigView> {
  const target = resolve(configPath);
  try {
    const result = await mutateRuntimeConfig(target, (current) => {
      if (input.configRevision !== revisionFor(current)) throw new ModelConfigChangedError();
      const next = mergeModelConfig(current, input);
      for (const key of Object.keys(current)) delete current[key];
      Object.assign(current, next);
      return next;
    });
    return buildModelConfigView(result.value, revisionFor(result.value), new Date().toISOString());
  } catch (error) {
    if (isErrorCode(error, "migration_lock_timeout")) {
      throw Object.assign(new Error("Model configuration is busy; try again"), {
        code: "config_write_busy" as const
      });
    }
    throw error;
  }
}

/** @deprecated Runtime-created preset IDs are UUIDs; deterministic IDs belong to registered migrations. */
export function generateDesktopPresetName(provider: string, model: string): string {
  const hash = createHash("sha256").update(`${provider.trim()}\0${model.trim()}`, "utf8").digest("hex").slice(0, 8);
  return `desktop-${readableIdPart(provider, 24) || "provider"}-${readableIdPart(model, 48) || "model"}-${hash}`;
}

function mergeModelConfig(config: ConfigRecord, input: ModelConfigInput): ConfigRecord {
  const existingProviders = record(config.providers);
  const existingPresets = record(config.modelPresets);
  const existingAssignments = normalizeStoredAssignments(config.modelAssignments);
  const normalizedProviders = input.providers.map(normalizeProviderInput);
  validateProviderIds(normalizedProviders);
  validateAccountInputs(normalizedProviders, existingProviders, existingPresets);

  const managedProviderIds = new Set<string>(normalizedProviders.filter((provider) => provider.provider !== ACCOUNT_PROVIDER).map((provider) => provider.provider));
  for (const providerId of Object.keys(existingProviders)) {
    if (providerId !== ACCOUNT_PROVIDER && isCatalogProviderId(providerId)) {
      managedProviderIds.add(providerId);
    }
  }
  for (const preset of Object.values(existingPresets)) {
    const value = record(preset);
    if (value.source === "byok") {
      const providerId = stringValue(value.provider);
      if (providerId) managedProviderIds.add(providerId);
    }
  }

  const nextProviders: ConfigRecord = Object.fromEntries(
    Object.entries(existingProviders).filter(([providerId]) => !managedProviderIds.has(providerId))
  );
  const nextPresets: ConfigRecord = Object.fromEntries(
    Object.entries(existingPresets).filter(([, value]) => record(value).source !== "byok")
  );
  const usedPresetIds = new Set(Object.keys(nextPresets));
  const existingByokPresets = Object.fromEntries(
    Object.entries(existingPresets).filter(([, value]) => record(value).source === "byok")
  );

  for (const providerInput of normalizedProviders) {
    if (providerInput.provider === ACCOUNT_PROVIDER) continue;
    const previousProvider = record(existingProviders[providerInput.provider]);
    const provider = mergeProvider(previousProvider, providerInput);
    nextProviders[providerInput.provider] = provider;
    validateEndpointDefinitions(providerInput, provider);

    for (const modelInput of providerInput.models) {
      if (modelInput.source !== "byok" || modelInput.ownerAccountId) {
        throw new InvalidModelConfigError("Desktop model settings may only create ownerless BYOK presets");
      }
      const endpoint = record(record(provider.endpoints)[modelInput.endpointId]);
      validatePresetEndpoint(providerInput.provider, modelInput, endpoint);
      const presetId = resolvePresetId(modelInput.presetId, existingByokPresets, usedPresetIds);
      const previousPreset = record(existingByokPresets[presetId]);
      nextPresets[presetId] = {
        ...previousPreset,
        provider: providerInput.provider,
        endpoint: modelInput.endpointId,
        model: modelInput.model,
        source: "byok",
        capabilities: [...new Set(modelInput.capabilities)]
      };
      delete record(nextPresets[presetId]).label;
      delete record(nextPresets[presetId]).ownerAccountId;
    }
  }

  validateUniqueModels(nextPresets);
  const modelAssignments = cloneAssignments(input.modelAssignments);
  validateAssignments(modelAssignments, nextPresets, existingAssignments);

  const next: ConfigRecord = {
    ...config,
    providers: nextProviders,
    modelPresets: nextPresets,
    modelAssignments
  };
  projectMemoryConfig(next, modelAssignments, config, existingAssignments);
  patchCompatibilityDefault(next, modelAssignments);
  return next;
}

function projectMemoryConfig(
  config: ConfigRecord,
  assignments: ModelAssignments,
  previousConfig: ConfigRecord,
  previousAssignments: ModelAssignments
): void {
  const mode = record(config.app).userMode === "account" ? "account" : "byok";
  const assignment = assignments[mode];
  const memory = { ...record(config.memmyMemory) };
  const routing = { ...record(memory.roleRouting) };

  const previousModeAssignment = previousAssignments[mode];
  const previousRouting = record(record(previousConfig.memmyMemory).roleRouting);
  projectMemoryRole(
    config,
    memory,
    routing,
    "evolution",
    assignment.memoryEvolution,
    assignment.agent.default,
    previousModeAssignment.memoryEvolution,
    previousRouting.evolution
  );
  projectMemoryRole(
    config,
    memory,
    routing,
    "summary",
    assignment.memorySummary,
    assignment.memoryEvolution ?? assignment.agent.default,
    previousModeAssignment.memorySummary,
    previousRouting.summary
  );
  memory.roleRouting = routing;
  memory.embedding = projectedMemoryEmbedding(
    config,
    record(memory.embedding),
    assignment.embedding,
    previousModeAssignment.embedding
  );
  config.memmyMemory = memory;

  function projectMemoryRole(
    root: ConfigRecord,
    target: ConfigRecord,
    roleRouting: ConfigRecord,
    role: "summary" | "evolution",
    presetId: string | null,
    inheritedPresetId: string | null,
    previousPresetId: string | null,
    previousRoute: unknown
  ): void {
    const preservesFixedRoute = previousRoute === "fixed" && presetId === previousPresetId;
    const followsInheritedModel = !preservesFixedRoute && (!presetId || presetId === inheritedPresetId);
    roleRouting[role] = followsInheritedModel ? "follow" : "fixed";
    if (followsInheritedModel) return;
    const connection = memoryConnection(root, presetId!);
    if (connection) target[role] = mergeMemoryConnection(record(target[role]), connection);
  }
}

function projectedMemoryEmbedding(
  config: ConfigRecord,
  previous: ConfigRecord,
  presetId: string | null,
  previousPresetId: string | null
): ConfigRecord {
  if (presetId === previousPresetId && previous.mode === "custom") {
    const connection = presetId ? memoryConnection(config, presetId) : null;
    return connection
      ? { ...mergeMemoryConnection(previous, connection), mode: "custom" }
      : previous;
  }
  if (presetId === previousPresetId && previous.mode === "local") {
    return {
      ...withoutMemoryConnection(previous),
      mode: "local",
      provider: "local"
    };
  }
  if (!presetId) {
    return {
      ...withoutMemoryConnection(previous),
      mode: "local",
      provider: "local"
    };
  }
  const preset = record(record(config.modelPresets)[presetId]);
  if (preset.source === "account") {
    return {
      ...withoutMemoryConnection(previous),
      mode: "cloud"
    };
  }
  const connection = memoryConnection(config, presetId);
  return connection
    ? {
        ...mergeMemoryConnection(previous, connection),
        mode: "custom",
        provider: "openai_compatible"
      }
    : {
        ...withoutMemoryConnection(previous),
        mode: "local",
        provider: "local"
      };
}

function memoryConnection(config: ConfigRecord, presetId: string): ConfigRecord | null {
  const preset = record(record(config.modelPresets)[presetId]);
  const providerId = stringValue(preset.provider);
  const endpointId = stringValue(preset.endpoint);
  const model = stringValue(preset.model);
  if (!providerId || !endpointId || !model) return null;
  const provider = record(record(config.providers)[providerId]);
  const endpoint = record(record(provider.endpoints)[endpointId]);
  const apiBase = stringValue(endpoint.apiBase);
  if (!apiBase) return null;
  const apiKey = stringValue(endpoint.apiKey) ?? stringValue(provider.apiKey);
  const extraHeaders = { ...record(provider.extraHeaders), ...record(endpoint.extraHeaders) };
  const extraBody = { ...record(provider.extraBody), ...record(endpoint.extraBody) };
  return {
    provider: memoryProvider(providerId),
    sourceProvider: providerId,
    endpoint: apiBase,
    model,
    ...(apiKey ? { apiKey } : {}),
    ...(Object.keys(extraHeaders).length ? { extraHeaders } : {}),
    ...(Object.keys(extraBody).length ? { extraBody } : {})
  };
}

function memoryProvider(providerId: string): string {
  if (providerId === "anthropic") return "anthropic";
  if (providerId === "gemini") return "gemini";
  return "openai_compatible";
}

function mergeMemoryConnection(previous: ConfigRecord, connection: ConfigRecord): ConfigRecord {
  return {
    ...withoutMemoryConnection(previous),
    ...connection
  };
}

function withoutMemoryConnection(value: ConfigRecord): ConfigRecord {
  const next = { ...value };
  for (const key of [
    "provider", "sourceProvider", "vendor", "endpoint", "apiBase", "baseUrl",
    "model", "modelId", "apiKey", "extraHeaders", "extraBody", "custom",
    "actualModelContext", "selectionError"
  ]) delete next[key];
  return next;
}

function normalizeProviderInput(input: TextModelProviderInput): TextModelProviderInput {
  return {
    ...input,
    apiKey: input.apiKey?.trim(),
    ownerAccountId: input.ownerAccountId?.trim(),
    endpoints: input.endpoints.map((endpoint) => ({
      ...endpoint,
      endpointId: endpoint.endpointId.trim(),
      apiBase: normalizeApiBase(endpoint.apiBase),
      apiKey: endpoint.apiKey?.trim()
    })),
    models: input.models.map((model) => ({
      ...model,
      presetId: model.presetId?.trim(),
      endpointId: model.endpointId.trim(),
      model: model.model.trim(),
      ownerAccountId: model.ownerAccountId?.trim(),
      capabilities: [...new Set(model.capabilities)]
    }))
  };
}

function validateProviderIds(providers: readonly TextModelProviderInput[]): void {
  const seen = new Set<CatalogProviderId>();
  for (const provider of providers) {
    if (seen.has(provider.provider)) throw new InvalidModelConfigError(`Duplicate Provider: ${provider.provider}`);
    seen.add(provider.provider);
    if (!ID_PATTERN.test(provider.provider)) throw new InvalidModelConfigError(`Invalid Provider ID: ${provider.provider}`);
    if (provider.provider !== ACCOUNT_PROVIDER && provider.ownerAccountId) {
      throw new InvalidModelConfigError("BYOK Providers cannot have ownerAccountId");
    }
    const endpointIds = new Set<string>();
    for (const endpoint of provider.endpoints) {
      if (!ID_PATTERN.test(endpoint.endpointId)) throw new InvalidModelConfigError(`Invalid endpoint ID: ${endpoint.endpointId}`);
      if (endpointIds.has(endpoint.endpointId)) throw new InvalidModelConfigError(`Duplicate endpoint ID: ${provider.provider}/${endpoint.endpointId}`);
      endpointIds.add(endpoint.endpointId);
    }
  }
}

function validateAccountInputs(
  inputs: readonly TextModelProviderInput[],
  providers: ConfigRecord,
  presets: ConfigRecord
): void {
  const input = inputs.find((provider) => provider.provider === ACCOUNT_PROVIDER);
  if (!input) return;
  const existingProvider = record(providers[ACCOUNT_PROVIDER]);
  if (!Object.keys(existingProvider).length) throw new InvalidModelConfigError("The account Provider is managed by account login");
  if (input.apiKey?.trim()) throw new InvalidModelConfigError("The account Provider credentials cannot be edited in model settings");
  if (input.ownerAccountId !== stringValue(existingProvider.ownerAccountId)) {
    throw new InvalidModelConfigError("The account Provider owner cannot be edited in model settings");
  }
  const existingEndpoints = record(existingProvider.endpoints);
  for (const endpoint of input.endpoints) {
    const existing = record(existingEndpoints[endpoint.endpointId]);
    if (
      normalizeApiBase(endpoint.apiBase) !== normalizeApiBase(stringValue(existing.apiBase) ?? "")
      || endpoint.protocol !== existing.protocol
      || endpoint.apiKey?.trim()
    ) {
      throw new InvalidModelConfigError("The account Provider cannot be edited in model settings");
    }
  }
  for (const model of input.models) {
    const existing = record(model.presetId ? presets[model.presetId] : undefined);
    if (
      !model.presetId
      || existing.source !== "account"
      || existing.provider !== ACCOUNT_PROVIDER
      || existing.endpoint !== model.endpointId
      || existing.model !== model.model
      || stableJson(existing.capabilities) !== stableJson(model.capabilities)
      || existing.ownerAccountId !== model.ownerAccountId
    ) {
      throw new InvalidModelConfigError("Account presets cannot be created or edited in model settings");
    }
  }
}

function mergeProvider(previous: ConfigRecord, input: TextModelProviderInput): ConfigRecord {
  const previousEndpoints = record(previous.endpoints);
  const endpoints = Object.fromEntries(input.endpoints.map((endpoint) => {
    const previousEndpoint = record(previousEndpoints[endpoint.endpointId]);
    return [endpoint.endpointId, mergeEndpoint(previousEndpoint, endpoint)];
  }));
  const next: ConfigRecord = {
    ...previous,
    endpoints
  };
  setOptionalSecret(next, "apiKey", input.apiKey, previous.apiKey);
  setOptionalRecord(next, "extraHeaders", input.extraHeaders, previous.extraHeaders);
  setOptionalRecord(next, "extraBody", input.extraBody, previous.extraBody);
  delete next.apiBase;
  delete next.apiType;
  delete next.ownerAccountId;
  return next;
}

function mergeEndpoint(previous: ConfigRecord, input: CatalogEndpointInput): ConfigRecord {
  const next: ConfigRecord = {
    ...previous,
    apiBase: input.apiBase,
    protocol: input.protocol
  };
  setOptionalSecret(next, "apiKey", input.apiKey, previous.apiKey);
  setOptionalRecord(next, "extraHeaders", input.extraHeaders, previous.extraHeaders);
  setOptionalRecord(next, "extraBody", input.extraBody, previous.extraBody);
  return next;
}

function validateEndpointDefinitions(input: TextModelProviderInput, provider: ConfigRecord): void {
  const signatures = new Set<string>();
  for (const endpoint of input.endpoints) {
    const merged = record(record(provider.endpoints)[endpoint.endpointId]);
    const signature = stableJson({
      provider: input.provider,
      protocol: merged.protocol,
      apiBase: normalizeApiBase(stringValue(merged.apiBase) ?? ""),
      apiKey: stringValue(merged.apiKey) ?? stringValue(provider.apiKey) ?? null,
      extraHeaders: merged.extraHeaders ?? provider.extraHeaders ?? null,
      extraBody: merged.extraBody ?? provider.extraBody ?? null
    });
    if (signatures.has(signature)) {
      throw new InvalidModelConfigError(`Duplicate endpoint definition for Provider ${input.provider}`);
    }
    signatures.add(signature);
  }
}

function validatePresetEndpoint(providerId: CatalogProviderId, model: TextModelItemInput, endpoint: ConfigRecord): void {
  if (!Object.keys(endpoint).length) {
    throw new InvalidModelConfigError(`Preset endpoint does not exist: ${providerId}/${model.endpointId}`);
  }
  const protocol = endpoint.protocol as ModelEndpointProtocol | undefined;
  if (!protocol) throw new InvalidModelConfigError(`Endpoint protocol is required: ${providerId}/${model.endpointId}`);
  for (const capability of model.capabilities) {
    if (!CAPABILITY_PROTOCOLS[capability].has(protocol)) {
      throw new InvalidModelConfigError(`Endpoint protocol ${protocol} does not support capability ${capability}`);
    }
  }
}

function resolvePresetId(
  requested: string | undefined,
  existing: ConfigRecord,
  used: Set<string>
): string {
  if (requested) {
    if (!ID_PATTERN.test(requested)) throw new InvalidModelConfigError(`Invalid preset ID: ${requested}`);
    if (!(requested in existing)) throw new InvalidModelConfigError("New presets must not provide a client-generated preset ID");
    if (used.has(requested)) throw new InvalidModelConfigError(`Duplicate preset ID: ${requested}`);
    used.add(requested);
    return requested;
  }
  let generated = randomUUID();
  while (used.has(generated) || generated in existing) generated = randomUUID();
  used.add(generated);
  return generated;
}

function validateUniqueModels(presets: ConfigRecord): void {
  const combinations = new Set<string>();
  for (const [presetId, value] of Object.entries(presets)) {
    if (presetId === BUILTIN_LOCAL_EMBEDDING_ASSIGNMENT_ID) {
      throw new InvalidModelConfigError(`Preset ID is reserved: ${presetId}`);
    }
    const preset = record(value);
    const provider = stringValue(preset.provider);
    const endpoint = stringValue(preset.endpoint);
    const model = stringValue(preset.model);
    if (!provider || !endpoint || !model || (preset.source !== "byok" && preset.source !== "account")) continue;
    const combination = `${provider}\0${endpoint}\0${model}`;
    if (combinations.has(combination)) {
      throw new InvalidModelConfigError(`Duplicate Provider/endpoint/model: ${provider} / ${endpoint} / ${model}`);
    }
    combinations.add(combination);
    if (!ID_PATTERN.test(presetId)) throw new InvalidModelConfigError(`Invalid preset ID: ${presetId}`);
  }
}

function validateAssignments(
  assignments: ModelAssignments,
  presets: ConfigRecord,
  previous: ModelAssignments
): void {
  validateAssignmentNamespace("byok", assignments.byok, presets, previous.byok);
  validateAssignmentNamespace("account", assignments.account, presets, previous.account);
}

function validateAssignmentNamespace(
  namespace: "byok" | "account",
  assignment: ModelAssignment,
  presets: ConfigRecord,
  previous: ModelAssignment
): void {
  const agentCandidates = new Set(assignment.agent.candidates);
  if (agentCandidates.size !== assignment.agent.candidates.length) {
    throw new InvalidModelConfigError(`Duplicate ${namespace} Agent candidate`);
  }
  if (assignment.agent.default && !agentCandidates.has(assignment.agent.default)) {
    throw new InvalidModelConfigError(`${namespace} Agent default must be one of its candidates`);
  }
  if (!assignment.agent.default && agentCandidates.size) {
    throw new InvalidModelConfigError(`${namespace} Agent default is required when candidates exist`);
  }
  for (const presetId of assignment.agent.candidates) {
    validateAssignmentReference(namespace, presetId, "agent", assignment, presets, previous);
  }
  for (const [field, capability] of Object.entries(ASSIGNMENT_CAPABILITIES) as Array<[keyof typeof ASSIGNMENT_CAPABILITIES, ModelCapability]>) {
    const presetId = assignment[field];
    if (presetId) validateAssignmentReference(namespace, presetId, capability, assignment, presets, previous);
  }
}

function validateAssignmentReference(
  namespace: "byok" | "account",
  presetId: string,
  capability: ModelCapability,
  assignment: ModelAssignment,
  presets: ConfigRecord,
  previous: ModelAssignment
): void {
  if (presetId === BUILTIN_LOCAL_EMBEDDING_ASSIGNMENT_ID) {
    if (capability !== "embedding") {
      throw new InvalidModelConfigError("The built-in local Embedding assignment is only valid for embedding");
    }
    if (namespace === "account" && !assignment.ownerAccountId) {
      throw new InvalidModelConfigError("The account built-in local Embedding assignment requires an account owner");
    }
    return;
  }
  const preset = record(presets[presetId]);
  if (!Object.keys(preset).length) {
    if (namespace === "account" && stableJson(assignment) === stableJson(previous)) return;
    throw new InvalidModelConfigError(`${namespace} assignment references missing preset ${presetId}`);
  }
  if (namespace === "byok" && preset.source !== "byok") {
    throw new InvalidModelConfigError("BYOK assignments may only reference BYOK presets");
  }
  if (preset.source === "account" && (
    !assignment.ownerAccountId
    || assignment.ownerAccountId !== preset.ownerAccountId
  )) {
    throw new InvalidModelConfigError("Account assignment owner does not match its platform preset");
  }
  if (!arrayValue(preset.capabilities).includes(capability)) {
    throw new InvalidModelConfigError(`Preset ${presetId} does not support capability ${capability}`);
  }
}

function patchCompatibilityDefault(config: ConfigRecord, assignments: ModelAssignments): void {
  const mode = record(config.app).userMode === "account" ? "account" : "byok";
  const selected = assignments[mode].agent.default;
  const agents = { ...record(config.agents) };
  const defaults = { ...record(agents.defaults), modelPreset: selected };
  agents.defaults = defaults;
  config.agents = agents;
}

function buildModelConfigView(
  config: ConfigRecord,
  configRevision: string,
  updatedAtValue: string
): ModelConfigView {
  const providers = record(config.providers);
  const presets = record(config.modelPresets);
  const assignments = normalizeStoredAssignments(config.modelAssignments);
  const providerViews = Object.entries(providers).flatMap(([providerId, value]) => {
    if (!isCatalogProviderId(providerId)) return [];
    const provider = record(value);
    const modelRows = Object.entries(presets).flatMap(([presetId, presetValue]) => {
      const preset = record(presetValue);
      if (preset.provider !== providerId || !isCurrentPreset(preset, provider)) return [];
      return [presetView(presetId, preset, provider)];
    });
    if (!modelRows.length) return [];
    return [providerView(providerId, provider, modelRows)];
  });
  const models = providerViews.flatMap((provider) => provider.models);
  const byId = new Map(models.map((model) => [model.presetId, model]));
  const effectiveCandidates = {
    byok: assignments.byok.agent.candidates.flatMap((presetId) => byId.get(presetId) ? [byId.get(presetId)!] : []),
    account: assignments.account.agent.candidates.flatMap((presetId) => byId.get(presetId) ? [byId.get(presetId)!] : [])
  };
  const mode = record(config.app).userMode === "account" ? "account" : "byok";
  const defaultId = assignments[mode].agent.default;
  return {
    configRevision,
    providers: providerViews,
    modelAssignments: assignments,
    memorySettings: memorySettings(config),
    effectiveCandidates,
    configured: Boolean(defaultId && byId.get(defaultId)?.available),
    updatedAt: updatedAtValue
  };
}

function providerView(
  providerId: CatalogProviderId,
  provider: ConfigRecord,
  models: TextModelItemView[]
): TextModelProviderView {
  const apiKey = stringValue(provider.apiKey);
  const endpoints = Object.entries(record(provider.endpoints)).flatMap(([endpointId, value]) => {
    const endpoint = record(value);
    const apiBase = stringValue(endpoint.apiBase);
    const protocol = endpoint.protocol;
    if (!apiBase || !isEndpointProtocol(protocol)) return [];
    const endpointApiKey = stringValue(endpoint.apiKey);
    return [{
      endpointId,
      apiBase,
      protocol,
      hasApiKey: Boolean(endpointApiKey),
      apiKeyMasked: maskSecret(endpointApiKey),
      apiKey: ""
    }];
  });
  return {
    provider: providerId,
    configured: models.some((model) => model.available),
    hasApiKey: Boolean(apiKey),
    apiKeyMasked: maskSecret(apiKey),
    apiKey: "",
    ...(stringValue(provider.ownerAccountId) ? { ownerAccountId: stringValue(provider.ownerAccountId)! } : {}),
    endpoints,
    accountManaged: providerId === ACCOUNT_PROVIDER,
    editable: providerId !== ACCOUNT_PROVIDER,
    models
  };
}

function presetView(
  presetId: string,
  preset: ConfigRecord,
  provider: ConfigRecord
): TextModelItemView {
  const endpointId = stringValue(preset.endpoint)!;
  const endpoint = record(record(provider.endpoints)[endpointId]);
  const protocol = endpoint.protocol as ModelEndpointProtocol;
  const source = preset.source as "account" | "byok";
  const providerId = preset.provider as CatalogProviderId;
  const hasCredential = Boolean(stringValue(endpoint.apiKey) ?? stringValue(provider.apiKey));
  const ownerMatches = source === "byok" || (
    stringValue(preset.ownerAccountId)
    && stringValue(preset.ownerAccountId) === stringValue(provider.ownerAccountId)
  );
  return {
    presetId,
    provider: providerId,
    endpointId,
    protocol,
    model: stringValue(preset.model)!,
    source,
    ...(stringValue(preset.ownerAccountId) ? { ownerAccountId: stringValue(preset.ownerAccountId)! } : {}),
    capabilities: arrayValue(preset.capabilities).filter(isModelCapability),
    available: Boolean((hasCredential || API_KEY_OPTIONAL_PROVIDERS.has(providerId)) && ownerMatches)
  };
}

function isCurrentPreset(preset: ConfigRecord, provider: ConfigRecord): boolean {
  const endpointId = stringValue(preset.endpoint);
  const endpoint = record(endpointId ? record(provider.endpoints)[endpointId] : undefined);
  const protocol = endpoint.protocol;
  const capabilities = arrayValue(preset.capabilities);
  return isCatalogProviderId(preset.provider)
    && Boolean(endpointId)
    && Boolean(stringValue(preset.model))
    && (preset.source === "account" || preset.source === "byok")
    && isEndpointProtocol(protocol)
    && capabilities.length > 0
    && capabilities.every((capability) => isModelCapability(capability) && CAPABILITY_PROTOCOLS[capability].has(protocol));
}

function normalizeStoredAssignments(value: unknown): ModelAssignments {
  const root = record(value);
  return {
    byok: normalizeAssignment(root.byok, false),
    account: normalizeAssignment(root.account, true)
  };
}

function normalizeAssignment(value: unknown, ownerAllowed: boolean): ModelAssignment {
  const assignment = record(value);
  const agent = record(assignment.agent);
  return {
    ...(ownerAllowed && stringValue(assignment.ownerAccountId) ? { ownerAccountId: stringValue(assignment.ownerAccountId)! } : {}),
    agent: {
      candidates: arrayValue(agent.candidates).filter((item): item is string => typeof item === "string" && Boolean(item.trim())),
      default: stringValue(agent.default) ?? null
    },
    memorySummary: stringValue(assignment.memorySummary) ?? null,
    memoryEvolution: stringValue(assignment.memoryEvolution) ?? null,
    embedding: stringValue(assignment.embedding) ?? null,
    asr: stringValue(assignment.asr) ?? null,
    imageGeneration: stringValue(assignment.imageGeneration) ?? null
  };
}

function cloneAssignments(assignments: ModelAssignments): ModelAssignments {
  return {
    byok: { ...assignments.byok, agent: { ...assignments.byok.agent, candidates: [...assignments.byok.agent.candidates] } },
    account: { ...assignments.account, agent: { ...assignments.account.agent, candidates: [...assignments.account.agent.candidates] } }
  };
}

function revisionFor(config: ConfigRecord): string {
  return createHash("sha256").update(stableJson({
    providers: config.providers ?? null,
    modelPresets: config.modelPresets ?? null,
    modelAssignments: config.modelAssignments ?? null,
    memmyMemory: config.memmyMemory ?? null,
    agents: { defaults: record(config.agents).defaults ?? null }
  })).digest("hex");
}

function memorySettings(config: ConfigRecord): {
  roleRouting: { summary: "follow" | "fixed"; evolution: "follow" | "fixed" };
  embeddingMode: "cloud" | "local" | "custom";
} {
  const memory = record(config.memmyMemory);
  const routing = record(memory.roleRouting);
  const embedding = record(memory.embedding);
  const appMode = record(config.app).userMode === "account" ? "account" : "byok";
  return {
    roleRouting: {
      summary: routing.summary === "fixed" ? "fixed" : "follow",
      evolution: routing.evolution === "fixed" ? "fixed" : "follow"
    },
    embeddingMode: embedding.mode === "cloud" || embedding.mode === "custom" || embedding.mode === "local"
      ? embedding.mode
      : appMode === "account" ? "cloud" : "local"
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function normalizeApiBase(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function setOptionalSecret(target: ConfigRecord, key: string, input: unknown, previous: unknown): void {
  const next = stringValue(input) ?? stringValue(previous);
  if (next) target[key] = next;
  else delete target[key];
}

function setOptionalRecord(target: ConfigRecord, key: string, input: unknown, previous: unknown): void {
  if (isRecord(input)) target[key] = input;
  else if (isRecord(previous)) target[key] = previous;
  else delete target[key];
}

async function readConfig(configPath: string): Promise<{ content: string | null; config: ConfigRecord }> {
  const content = await readContent(configPath);
  if (!content?.trim()) return { content, config: {} };
  let parsed: unknown;
  try {
    parsed = YAML.parse(content);
  } catch (error) {
    throw new InvalidModelConfigError(`Unable to read model configuration: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) throw new InvalidModelConfigError("Model configuration must be a YAML object");
  return { content, config: parsed };
}

async function readContent(configPath: string): Promise<string | null> {
  try {
    return await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function updatedAt(configPath: string, content: string | null): Promise<string> {
  if (content === null) return new Date(0).toISOString();
  try {
    return (await stat(configPath)).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

function readableIdPart(value: string, maxLength: number): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, maxLength).replace(/-$/g, "");
}

function maskSecret(value: string | undefined): string {
  if (!value) return "";
  if (value.length <= 8) return "••••••••";
  return `${value.slice(0, 3)}••••${value.slice(-4)}`;
}

function record(value: unknown): ConfigRecord {
  return isRecord(value) ? value : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is ConfigRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function isCatalogProviderId(value: unknown): value is CatalogProviderId {
  return typeof value === "string" && [
    "openai", "anthropic", "gemini", "deepseek", "zhipu", "dashscope", "moonshot", "minimax", "qianfan", "volcengine", ACCOUNT_PROVIDER
  ].includes(value);
}

function isEndpointProtocol(value: unknown): value is ModelEndpointProtocol {
  return typeof value === "string" && Object.values(CAPABILITY_PROTOCOLS).some((protocols) => protocols.has(value as ModelEndpointProtocol));
}

function isModelCapability(value: unknown): value is ModelCapability {
  return typeof value === "string" && value in CAPABILITY_PROTOCOLS;
}

function isErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
