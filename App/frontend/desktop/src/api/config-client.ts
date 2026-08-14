import type {
  AppSettingsDto,
  EmbeddingMode as ModelEmbeddingMode,
  ModelConfigInput,
  ModelConfigTestCapability,
  ModelConfigTestResult,
  ModelConfigTestSecretTarget,
  ModelConfigView,
  ModelCapability,
  ModelEndpointProtocol,
  ModelProvider,
  AgentApiType,
  OnboardingStateDto,
  PrivacySettingsDto,
  RuntimeConfig,
  ScanPreferences,
  ScanPermission,
  SetImprovementProgramResponse,
  TokenUsageDto
} from "@memmy/local-api-contracts";
import {
  AppSettingsDtoSchema,
  ModelConfigInputSchema,
  ModelConfigTestInputSchema,
  ModelConfigTestResultSchema,
  ModelConfigViewSchema,
  OnboardingStateDtoSchema,
  PatchAppSettingsInputSchema,
  PatchOnboardingInputSchema,
  PatchPrivacyInputSchema,
  PatchScanPreferencesInputSchema,
  PrivacySettingsDtoSchema,
  ScanPreferencesSchema,
  SetImprovementProgramInputSchema,
  SetImprovementProgramResponseSchema,
  TokenUsageDtoSchema
} from "@memmy/local-api-contracts";
import type { PreferredMode } from "../app/routes.js";
import { requestJson } from "./http.js";

const LEGACY_MODEL_WORKSPACE_STORAGE_KEY = "memmy-model-workspace-v1";
export const CLIENT_PRESET_ID_PREFIX = "client-new-preset-";

export interface ModelCatalogTransport {
  read(): Promise<ModelConfigView>;
  write(input: ModelConfigInput): Promise<ModelConfigView>;
}

export interface ModelProviderConfig {
  /** Canonical server-owned catalog. UI writes must use this field and its revision. */
  catalog?: ModelConfigView;
  configRevision?: string;
  providers?: TextModelProviderConfig[];
  defaultModelPreset?: string | null;
  provider: string;
  endpointId?: string;
  protocol?: ModelEndpointProtocol;
  endpoint: string;
  model: string;
  apiKey: string;
  apiKeyMasked: string;
  configured: boolean;
  embedding?: EmbeddingProviderConfig | null;
  memmyMemory?: MemmyMemoryProviderConfig | null;
  asr?: AsrProviderConfig | null;
  imageGen?: ImageGenProviderConfig | null;
}

export interface TextModelConfig {
  presetName?: string;
  draftId?: string;
  model: string;
  isDefault: boolean;
  available: boolean;
}

export interface TextModelProviderConfig {
  provider: string;
  endpoint: string;
  apiType: AgentApiType;
  apiKey: string;
  apiKeyMasked: string;
  configured: boolean;
  accountManaged: boolean;
  editable: boolean;
  models: TextModelConfig[];
}

export interface RoleModelProviderConfig {
  mode?: "follow" | "fixed";
  provider: string;
  endpoint: string;
  model: string;
  apiKey: string;
  apiKeyMasked: string;
  configured: boolean;
}

export interface MemmyMemoryProviderConfig {
  summary: RoleModelProviderConfig;
  evolution: RoleModelProviderConfig;
}

export interface EmbeddingProviderConfig {
  mode: ModelEmbeddingMode;
  endpoint: string;
  model: string;
  apiKey: string;
  apiKeyMasked: string;
  configured: boolean;
}

export interface AsrProviderConfig {
  provider: string;
  endpoint: string;
  model: string;
  apiKey: string;
  apiKeyMasked: string;
  configured: boolean;
}

export interface ImageGenProviderConfig {
  provider: string;
  endpoint: string;
  model: string;
  apiKey: string;
  apiKeyMasked: string;
  configured: boolean;
}

export interface ConfigClient {
  updateSettings(settings: Partial<AppSettingsDto>): Promise<Partial<AppSettingsDto>>;
  updatePrivacy(privacy: Partial<PrivacySettingsDto>): Promise<Partial<PrivacySettingsDto>>;
  updateOnboarding(onboarding: Partial<OnboardingStateDto>): Promise<Partial<OnboardingStateDto>>;
  setImprovementProgram(accepted: boolean): Promise<SetImprovementProgramResponse>;
  getTokenUsage(): Promise<TokenUsageDto>;
  updateScanPermission(permission: ScanPermission): Promise<Partial<OnboardingStateDto>>;
  updateScanPreferences(preferences: Partial<ScanPreferences>): Promise<ScanPreferences>;
  getModelConfig(): Promise<ModelProviderConfig>;
  saveModelCatalog(config: ModelConfigInput | ModelConfigView): Promise<ModelProviderConfig>;
  testModelConfig(config: ModelProviderConfig, capability?: ModelConfigTestCapability, secretTarget?: ModelConfigTestSecretTarget): Promise<ModelConfigTestResult>;
  updatePreferredMode(mode: PreferredMode): Promise<PreferredMode>;
}

export function createHttpConfigClient(config: RuntimeConfig): ConfigClient {
  const catalogSnapshots = new Map<string, ModelConfigView>();
  const rememberCatalog = (view: ModelConfigView) => {
    catalogSnapshots.set(view.configRevision, structuredClone(view));
    if (catalogSnapshots.size > 8) catalogSnapshots.delete(catalogSnapshots.keys().next().value!);
    return view;
  };
  return {
    async updateSettings(settings) {
      return requestJson({
        config,
        path: "/api/app/settings",
        schema: AppSettingsDtoSchema,
        init: { method: "PATCH" },
        body: PatchAppSettingsInputSchema.parse(settings)
      });
    },

    async updatePrivacy(privacy) {
      return requestJson({
        config,
        path: "/api/app/privacy",
        schema: PrivacySettingsDtoSchema,
        init: { method: "PATCH" },
        body: PatchPrivacyInputSchema.parse(privacy)
      });
    },

    async updateOnboarding(onboarding) {
      return requestJson({
        config,
        path: "/api/app/onboarding",
        schema: OnboardingStateDtoSchema,
        init: { method: "PATCH" },
        body: PatchOnboardingInputSchema.parse(onboarding)
      });
    },

    async setImprovementProgram(accepted) {
      return requestJson({
        config,
        path: "/api/app/improvement-program",
        schema: SetImprovementProgramResponseSchema,
        init: { method: "PATCH" },
        body: SetImprovementProgramInputSchema.parse({
          improvementProgram: accepted ? "accepted" : "declined"
        })
      });
    },

    async getTokenUsage() {
      return requestJson({
        config,
        path: "/api/app/token-usage",
        schema: TokenUsageDtoSchema
      });
    },

    async updateScanPermission(permission) {
      return this.updateOnboarding({
        scanPermission: permission
      });
    },

    async updateScanPreferences(preferences) {
      return requestJson({
        config,
        path: "/api/app/scan-preferences",
        schema: ScanPreferencesSchema,
        init: { method: "PATCH" },
        body: PatchScanPreferencesInputSchema.parse(preferences)
      });
    },

    async getModelConfig() {
      const response = await requestJson({
        config,
        path: "/api/app/model-config",
        schema: ModelConfigViewSchema
      });

      clearLegacyModelWorkspace();
      rememberCatalog(response);
      return fromModelConfigView(response);
    },

    async saveModelCatalog(modelConfig) {
      const requested = toCatalogInput(modelConfig);
      const response = await persistModelCatalogMutation(modelConfig, {
        read: async () => rememberCatalog(await requestJson({
            config,
            path: "/api/app/model-config",
            schema: ModelConfigViewSchema
          })),
        write: async (input) => rememberCatalog(await requestJson({
            config,
            path: "/api/app/model-config",
            schema: ModelConfigViewSchema,
            init: { method: "PUT" },
            body: ModelConfigInputSchema.parse(input)
          }))
      }, catalogSnapshots.get(requested.configRevision));
      rememberCatalog(response);
      return fromModelConfigView(response);
    },

    async testModelConfig(modelConfig, capability = "chat", secretTarget) {
      return requestJson({
        config,
        path: "/api/app/model-config/test",
        schema: ModelConfigTestResultSchema,
        body: ModelConfigTestInputSchema.parse({
          provider: toModelProvider(modelConfig.provider),
          endpointId: modelConfig.endpointId ?? `connection-test-${secretTarget ?? capability}`,
          protocol: modelConfig.protocol ?? testProtocolFor(modelConfig.provider, capability),
          apiBase: modelConfig.endpoint,
          modelId: modelConfig.model,
          apiKey: modelConfig.apiKey || undefined,
          capability,
          secretTarget
        })
      });
    },

    async updatePreferredMode(mode) {
      await this.updateSettings({ defaultLaunchMode: mode });
      return mode;
    }
  };
}

/**
 * Persists a catalog mutation without ever sending client-generated preset IDs.
 * New presets are created first, matched to the server UUIDs, then assigned in a revision-safe second write.
 */
export async function persistModelCatalogMutation(
  config: ModelConfigInput | ModelConfigView,
  transport: ModelCatalogTransport,
  baseView?: ModelConfigView
): Promise<ModelConfigView> {
  const requested = toCatalogInput(config);
  const pending = pendingPresets(requested);
  const base = baseView?.configRevision === requested.configRevision ? toCatalogInput(baseView) : undefined;
  if (!pending.length) return writeCatalogIntent(requested, base, transport);

  const phaseOneInput = withoutPendingPresetAssignments(requested, new Set(pending.map((item) => item.clientId)));
  const created = await writeCatalogIntent(phaseOneInput, base, transport);
  const mapping = resolvePendingPresetIds(pending, created);
  if (!assignmentsReferencePending(requested, mapping.keys())) return created;

  const phaseTwo = assignmentPhaseInput(created, requested, mapping);
  const saved = await writeCatalogIntent(phaseTwo, toCatalogInput(created), transport);
  assertResolvedPresetsStillExist(pending, mapping, saved);
  return saved;
}

async function writeCatalogIntent(
  initialIntent: ModelConfigInput,
  initialBase: ModelConfigInput | undefined,
  transport: ModelCatalogTransport
): Promise<ModelConfigView> {
  let intent = structuredClone(initialIntent);
  let base = initialBase ? structuredClone(initialBase) : undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await transport.write(ModelConfigInputSchema.parse(intent));
    } catch (error) {
      if (!isModelConfigChanged(error)) throw error;
      const latest = await transport.read();
      if (!base) throw modelConfigConflict("Cannot rebase model change because its base revision is unavailable");
      if (hasCatalogDefinitionDeletion(base, intent)) {
        throw modelConfigConflict("Model catalog changed while deleting; reload before retrying the deletion");
      }
      intent = rebaseCatalogIntent(base, intent, latest);
      base = toCatalogInput(latest);
    }
  }
  throw modelConfigConflict("Model configuration kept changing; retry the operation");
}

function hasCatalogDefinitionDeletion(base: ModelConfigInput, desired: ModelConfigInput): boolean {
  const desiredProviders = new Map(desired.providers.map((provider) => [provider.provider, provider]));
  for (const baseProvider of base.providers) {
    const desiredProvider = desiredProviders.get(baseProvider.provider);
    if (!desiredProvider) return baseProvider.provider !== "memmy_account";
    const desiredEndpointIds = new Set(desiredProvider.endpoints.map((endpoint) => endpoint.endpointId));
    if (baseProvider.endpoints.some((endpoint) => !desiredEndpointIds.has(endpoint.endpointId))) return true;
  }
  const desiredModels = locatedModels(desired);
  return [...locatedModels(base).keys()].some((modelKey) => !desiredModels.has(modelKey));
}

/** Applies only the user's changes between base and desired onto the latest server catalog. */
export function rebaseCatalogIntent(
  base: ModelConfigInput,
  desired: ModelConfigInput,
  latestView: ModelConfigView
): ModelConfigInput {
  const latest = toCatalogInput(latestView);
  const next = structuredClone(latest);
  const baseProviders = new Map(base.providers.map((provider) => [provider.provider, provider]));
  const desiredProviders = new Map(desired.providers.map((provider) => [provider.provider, provider]));
  const nextProviders = new Map(next.providers.map((provider) => [provider.provider, provider]));

  for (const [providerId, baseProvider] of baseProviders) {
    if (providerId === "memmy_account" || desiredProviders.has(providerId)) continue;
    const latestProvider = nextProviders.get(providerId);
    if (latestProvider && !sameJson(baseProvider, latestProvider)) {
      throw modelConfigConflict(`Provider ${providerId} changed before deletion`);
    }
    nextProviders.delete(providerId);
  }
  for (const [providerId, desiredProvider] of desiredProviders) {
    if (providerId === "memmy_account") continue;
    const baseProvider = baseProviders.get(providerId);
    const latestProvider = nextProviders.get(providerId);
    if (!baseProvider && latestProvider) {
      throw modelConfigConflict(`Provider ${providerId} was concurrently created`);
    }
    const merged = latestProvider ? structuredClone(latestProvider) : {
      provider: desiredProvider.provider,
      endpoints: [],
      models: []
    };
    mergeOptionalField(merged, baseProvider, desiredProvider, latestProvider, "apiKey", `Provider ${providerId} API key`);
    mergeOptionalField(merged, baseProvider, desiredProvider, latestProvider, "extraHeaders", `Provider ${providerId} headers`);
    mergeOptionalField(merged, baseProvider, desiredProvider, latestProvider, "extraBody", `Provider ${providerId} body`);
    assertEndpointDeletionsSafe(baseProvider, desiredProvider, latestProvider, providerId);
    merged.endpoints = rebaseEndpoints(baseProvider?.endpoints ?? [], desiredProvider.endpoints, merged.endpoints);
    nextProviders.set(providerId, merged);
  }
  next.providers = [...nextProviders.values()];
  rebaseModels(base, desired, next);
  next.modelAssignments = rebaseAssignments(base.modelAssignments, desired.modelAssignments, latest.modelAssignments);
  next.configRevision = latest.configRevision;
  return next;
}

function assertEndpointDeletionsSafe(
  baseProvider: ModelConfigInput["providers"][number] | undefined,
  desiredProvider: ModelConfigInput["providers"][number],
  latestProvider: ModelConfigInput["providers"][number] | undefined,
  providerId: string
): void {
  if (!baseProvider || !latestProvider) return;
  const desiredEndpointIds = new Set(desiredProvider.endpoints.map((endpoint) => endpoint.endpointId));
  for (const baseEndpoint of baseProvider.endpoints) {
    if (desiredEndpointIds.has(baseEndpoint.endpointId)) continue;
    const latestEndpoint = latestProvider.endpoints.find((endpoint) => endpoint.endpointId === baseEndpoint.endpointId);
    if (!latestEndpoint) continue;
    const baseModels = endpointModels(baseProvider.models, baseEndpoint.endpointId);
    const latestModels = endpointModels(latestProvider.models, baseEndpoint.endpointId);
    if (!sameJson(baseEndpoint, latestEndpoint) || !sameJson(baseModels, latestModels)) {
      throw modelConfigConflict(`Endpoint ${providerId}/${baseEndpoint.endpointId} changed before deletion`);
    }
  }
}

function endpointModels(
  models: ModelConfigInput["providers"][number]["models"],
  endpointId: string
): ModelConfigInput["providers"][number]["models"] {
  return models
    .filter((model) => model.endpointId === endpointId)
    .map((model) => structuredClone(model))
    .sort((left, right) => (left.presetId ?? left.model).localeCompare(right.presetId ?? right.model));
}

function rebaseEndpoints(
  base: ModelConfigInput["providers"][number]["endpoints"],
  desired: ModelConfigInput["providers"][number]["endpoints"],
  latest: ModelConfigInput["providers"][number]["endpoints"]
): ModelConfigInput["providers"][number]["endpoints"] {
  const baseById = new Map(base.map((endpoint) => [endpoint.endpointId, endpoint]));
  const desiredById = new Map(desired.map((endpoint) => [endpoint.endpointId, endpoint]));
  const nextById = new Map(latest.map((endpoint) => [endpoint.endpointId, structuredClone(endpoint)]));
  for (const [endpointId] of baseById) {
    if (!desiredById.has(endpointId)) nextById.delete(endpointId);
  }
  for (const [endpointId, desiredEndpoint] of desiredById) {
    const baseEndpoint = baseById.get(endpointId);
    const latestEndpoint = nextById.get(endpointId);
    if (!baseEndpoint) {
      if (latestEndpoint && !sameJson(latestEndpoint, desiredEndpoint)) {
        throw modelConfigConflict(`Endpoint ID ${endpointId} was concurrently created`);
      }
      nextById.set(endpointId, structuredClone(desiredEndpoint));
      continue;
    }
    if (!latestEndpoint) {
      if (!sameJson(baseEndpoint, desiredEndpoint)) {
        throw modelConfigConflict(`Endpoint ${endpointId} was concurrently deleted`);
      }
      continue;
    }
    const merged = structuredClone(latestEndpoint);
    merged.apiBase = mergeIntentValue(baseEndpoint.apiBase, desiredEndpoint.apiBase, latestEndpoint.apiBase, `Endpoint ${endpointId} URL`);
    merged.protocol = mergeIntentValue(baseEndpoint.protocol, desiredEndpoint.protocol, latestEndpoint.protocol, `Endpoint ${endpointId} protocol`);
    mergeOptionalField(merged, baseEndpoint, desiredEndpoint, latestEndpoint, "apiKey", `Endpoint ${endpointId} API key`);
    mergeOptionalField(merged, baseEndpoint, desiredEndpoint, latestEndpoint, "extraHeaders", `Endpoint ${endpointId} headers`);
    mergeOptionalField(merged, baseEndpoint, desiredEndpoint, latestEndpoint, "extraBody", `Endpoint ${endpointId} body`);
    nextById.set(endpointId, merged);
  }
  return [...nextById.values()];
}

interface LocatedModel {
  provider: string;
  model: ModelConfigInput["providers"][number]["models"][number];
}

function rebaseModels(base: ModelConfigInput, desired: ModelConfigInput, next: ModelConfigInput): void {
  const baseModels = locatedModels(base);
  const desiredModels = locatedModels(desired);
  for (const [modelKey, baseModel] of baseModels) {
    if (desiredModels.has(modelKey)) continue;
    const latestModel = locatedModels(next).get(modelKey);
    if (latestModel && !sameLocatedModel(baseModel, latestModel)) {
      throw modelConfigConflict(`Model ${modelKey} changed before deletion`);
    }
    removeModel(next, modelKey);
  }
  for (const [modelKey, desiredModel] of desiredModels) {
    const baseModel = baseModels.get(modelKey);
    const currentModels = locatedModels(next);
    const latestModel = currentModels.get(modelKey);
    if (!baseModel) {
      if (latestModel) throw modelConfigConflict(`Model ${modelKey} was concurrently created`);
      const duplicate = [...currentModels.values()].find((item) => modelTriple(item) === modelTriple(desiredModel));
      if (duplicate) throw modelConfigConflict(`Model ${modelTriple(desiredModel)} was concurrently created`);
      insertModel(next, desiredModel);
      continue;
    }
    if (sameLocatedModel(baseModel, desiredModel)) continue;
    if (!latestModel) throw modelConfigConflict(`Model ${modelKey} was concurrently deleted`);
    removeModel(next, modelKey);
    insertModel(next, mergeLocatedModel(baseModel, desiredModel, latestModel, modelKey));
  }
}

function mergeLocatedModel(base: LocatedModel, desired: LocatedModel, latest: LocatedModel, modelKey: string): LocatedModel {
  const ownerAccountId = mergeIntentValue(
    base.model.ownerAccountId,
    desired.model.ownerAccountId,
    latest.model.ownerAccountId,
    `Model ${modelKey} owner`
  );
  return {
    provider: mergeIntentValue(base.provider, desired.provider, latest.provider, `Model ${modelKey} Provider`),
    model: {
      presetId: desired.model.presetId,
      endpointId: mergeIntentValue(base.model.endpointId, desired.model.endpointId, latest.model.endpointId, `Model ${modelKey} endpoint`),
      model: mergeIntentValue(base.model.model, desired.model.model, latest.model.model, `Model ${modelKey} name`),
      source: mergeIntentValue(base.model.source, desired.model.source, latest.model.source, `Model ${modelKey} source`),
      ...(ownerAccountId ? { ownerAccountId } : {}),
      capabilities: mergeIntentValue(base.model.capabilities, desired.model.capabilities, latest.model.capabilities, `Model ${modelKey} capabilities`)
    }
  };
}

function locatedModels(input: ModelConfigInput): Map<string, LocatedModel> {
  const result = new Map<string, LocatedModel>();
  for (const provider of input.providers) {
    for (const model of provider.models) {
      const located = { provider: provider.provider, model };
      result.set(model.presetId ? `id:${model.presetId}` : `new:${modelTriple(located)}`, located);
    }
  }
  return result;
}

function removeModel(input: ModelConfigInput, modelKey: string): void {
  for (const provider of input.providers) {
    provider.models = provider.models.filter((model) => (
      modelKey.startsWith("id:")
        ? model.presetId !== modelKey.slice(3)
        : `new:${provider.provider}/${model.endpointId}/${model.model}` !== modelKey
    ));
  }
}

function insertModel(input: ModelConfigInput, located: LocatedModel): void {
  const provider = input.providers.find((item) => item.provider === located.provider);
  if (!provider) throw modelConfigConflict(`Target Provider ${located.provider} is unavailable`);
  provider.models.push(structuredClone(located.model));
}

function sameLocatedModel(left: LocatedModel, right: LocatedModel): boolean {
  return left.provider === right.provider && sameJson(left.model, right.model);
}

function modelTriple(item: LocatedModel): string {
  return `${item.provider}/${item.model.endpointId}/${item.model.model}`;
}

function rebaseAssignments(
  base: ModelConfigInput["modelAssignments"],
  desired: ModelConfigInput["modelAssignments"],
  latest: ModelConfigInput["modelAssignments"]
): ModelConfigInput["modelAssignments"] {
  const next = structuredClone(latest);
  for (const mode of ["byok", "account"] as const) {
    next[mode].agent.candidates = mergeIntentValue(
      base[mode].agent.candidates,
      desired[mode].agent.candidates,
      latest[mode].agent.candidates,
      `${mode} Agent candidates`
    );
    next[mode].agent.default = mergeIntentValue(
      base[mode].agent.default,
      desired[mode].agent.default,
      latest[mode].agent.default,
      `${mode} Agent default`
    );
    for (const key of ["memorySummary", "memoryEvolution", "embedding", "asr", "imageGeneration"] as const) {
      next[mode][key] = mergeIntentValue(base[mode][key], desired[mode][key], latest[mode][key], `${mode} ${key} assignment`);
    }
  }
  next.account.ownerAccountId = mergeIntentValue(
    base.account.ownerAccountId,
    desired.account.ownerAccountId,
    latest.account.ownerAccountId,
    "account assignment owner"
  );
  return next;
}

function mergeOptionalField<
  T extends object,
  K extends keyof T
>(target: T, base: T | undefined, desired: T, latest: T | undefined, key: K, label: string): void {
  if (desired[key] === undefined) return;
  Object.assign(target, { [key]: structuredClone(mergeIntentValue(base?.[key], desired[key], latest?.[key], label)) });
}

function mergeIntentValue<T>(base: T, desired: T, latest: T, label: string): T {
  if (sameJson(base, desired)) return structuredClone(latest);
  if (sameJson(base, latest) || sameJson(desired, latest)) return structuredClone(desired);
  throw modelConfigConflict(`${label} changed concurrently`);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function modelConfigConflict(message: string): Error & { code: "model_config_changed" } {
  return Object.assign(new Error(message), { code: "model_config_changed" as const });
}

interface PendingPreset {
  clientId: string;
  provider: string;
  endpointId: string;
  model: string;
  source: "account" | "byok";
  capabilities: ModelCapability[];
}

function pendingPresets(input: ModelConfigInput): PendingPreset[] {
  return input.providers.flatMap((provider) => provider.models.flatMap((model) => (
    model.presetId?.startsWith(CLIENT_PRESET_ID_PREFIX)
      ? [{
          clientId: model.presetId,
          provider: provider.provider,
          endpointId: model.endpointId,
          model: model.model,
          source: model.source,
          capabilities: [...model.capabilities]
        }]
      : []
  )));
}

function withoutPendingPresetAssignments(input: ModelConfigInput, pendingIds: ReadonlySet<string>): ModelConfigInput {
  const next = structuredClone(input);
  for (const provider of next.providers) {
    for (const model of provider.models) {
      if (model.presetId && pendingIds.has(model.presetId)) delete model.presetId;
    }
  }
  for (const assignment of [next.modelAssignments.byok, next.modelAssignments.account]) {
    assignment.agent.candidates = assignment.agent.candidates.filter((id) => !pendingIds.has(id));
    if (assignment.agent.default && pendingIds.has(assignment.agent.default)) {
      assignment.agent.default = assignment.agent.candidates[0] ?? null;
    }
    for (const key of ["memorySummary", "memoryEvolution", "embedding", "asr", "imageGeneration"] as const) {
      if (assignment[key] && pendingIds.has(assignment[key]!)) assignment[key] = null;
    }
  }
  return next;
}

function resolvePendingPresetIds(pending: PendingPreset[], view: ModelConfigView): Map<string, string> {
  const mapping = new Map<string, string>();
  for (const item of pending) {
    const matches = view.providers.flatMap((provider) => provider.models).filter((model) => (
      model.provider === item.provider
      && model.endpointId === item.endpointId
      && model.model === item.model
      && model.source === item.source
      && sameStringSet(model.capabilities, item.capabilities)
    ));
    if (matches.length !== 1) {
      throw new Error(`Unable to resolve server preset for ${item.provider}/${item.endpointId}/${item.model}`);
    }
    mapping.set(item.clientId, matches[0]!.presetId);
  }
  return mapping;
}

function assignmentPhaseInput(
  base: ModelConfigView,
  requested: ModelConfigInput,
  mapping: ReadonlyMap<string, string>
): ModelConfigInput {
  const next = toCatalogInput(base);
  for (const mode of ["byok", "account"] as const) {
    const desired = requested.modelAssignments[mode];
    const assignment = next.modelAssignments[mode];
    for (const clientId of desired.agent.candidates) {
      const serverId = mapping.get(clientId);
      if (serverId && !assignment.agent.candidates.includes(serverId)) assignment.agent.candidates.push(serverId);
    }
    if (desired.agent.default) {
      const serverDefault = mapping.get(desired.agent.default);
      if (serverDefault) assignment.agent.default = serverDefault;
    }
    for (const key of ["memorySummary", "memoryEvolution", "embedding", "asr", "imageGeneration"] as const) {
      const serverId = desired[key] ? mapping.get(desired[key]!) : undefined;
      if (serverId) assignment[key] = serverId;
    }
  }
  return next;
}

function assignmentsReferencePending(input: ModelConfigInput, clientIds: Iterable<string>): boolean {
  const pending = new Set(clientIds);
  return [input.modelAssignments.byok, input.modelAssignments.account].some((assignment) => (
    assignment.agent.candidates.some((id) => pending.has(id))
    || Boolean(assignment.agent.default && pending.has(assignment.agent.default))
    || [assignment.memorySummary, assignment.memoryEvolution, assignment.embedding, assignment.asr, assignment.imageGeneration]
      .some((id) => Boolean(id && pending.has(id)))
  ));
}

function assertResolvedPresetsStillExist(
  pending: PendingPreset[],
  mapping: ReadonlyMap<string, string>,
  view: ModelConfigView
): void {
  const byId = new Map(view.providers.flatMap((provider) => provider.models).map((model) => [model.presetId, model]));
  for (const item of pending) {
    const preset = byId.get(mapping.get(item.clientId) ?? "");
    if (
      !preset
      || preset.provider !== item.provider
      || preset.endpointId !== item.endpointId
      || preset.model !== item.model
      || preset.source !== item.source
      || !sameStringSet(preset.capabilities, item.capabilities)
    ) {
      throw new Error(`Created model preset changed before assignment: ${item.provider}/${item.endpointId}/${item.model}`);
    }
  }
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function isModelConfigChanged(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "model_config_changed");
}

function fromModelConfigView(view: ModelConfigView): ModelProviderConfig {
  const selected = findAssignedPreset(view, "byok", "agent") ?? findAssignedPreset(view, "account", "agent");
  const selectedMode = selected?.source === "account" ? "account" : "byok";
  const selectedEndpoint = selected ? findEndpoint(view, selected) : null;
  const embeddingPreset = findAssignedPreset(view, selectedMode, "embedding");
  const embeddingEndpoint = embeddingPreset ? findEndpoint(view, embeddingPreset) : null;
  const summaryPreset = findAssignedPreset(view, selectedMode, "memory_summary");
  const evolutionPreset = findAssignedPreset(view, selectedMode, "memory_evolution");
  const asrPreset = findAssignedPreset(view, selectedMode, "asr");
  const imagePreset = findAssignedPreset(view, selectedMode, "image_generation");
  return {
    catalog: view,
    configRevision: view.configRevision,
    providers: view.providers.map((provider) => ({
      provider: provider.provider,
      endpoint: provider.endpoints[0]?.apiBase ?? "",
      apiType: apiTypeForProtocol(provider.endpoints[0]?.protocol),
      apiKey: provider.apiKey,
      apiKeyMasked: provider.apiKeyMasked,
      configured: provider.configured,
      accountManaged: provider.accountManaged,
      editable: provider.editable,
      models: provider.models.map((model) => ({
        presetName: model.presetId,
        model: model.model,
        isDefault: model.presetId === selected?.presetId,
        available: model.available
      }))
    })),
    defaultModelPreset: selected?.presetId ?? null,
    provider: selected?.provider ?? "openai",
    endpointId: selected?.endpointId,
    protocol: selectedEndpoint?.protocol,
    endpoint: selectedEndpoint?.apiBase ?? "",
    model: selected?.model ?? "",
    apiKey: selectedEndpoint?.apiKey ?? "",
    apiKeyMasked: selectedEndpoint?.apiKeyMasked ?? "",
    configured: view.configured,
    embedding: embeddingPreset && embeddingEndpoint ? {
      mode: "custom",
      endpoint: embeddingEndpoint.apiBase,
      model: embeddingPreset.model,
      apiKey: embeddingEndpoint.apiKey,
      apiKeyMasked: embeddingEndpoint.apiKeyMasked,
      configured: embeddingPreset.available
    } : null,
    memmyMemory: {
      summary: fromPresetRole(view, summaryPreset, selected),
      evolution: fromPresetRole(view, evolutionPreset, selected)
    },
    asr: asrPreset ? fromOptionalPreset(view, asrPreset) : null,
    imageGen: imagePreset ? fromOptionalPreset(view, imagePreset) : null
  };
}

function fromPresetRole(
  view: ModelConfigView,
  preset: ModelConfigView["providers"][number]["models"][number] | null,
  primary: ModelConfigView["providers"][number]["models"][number] | null
): RoleModelProviderConfig {
  const selected = preset ?? primary;
  const endpoint = selected ? findEndpoint(view, selected) : null;
  return {
    mode: preset ? "fixed" : "follow",
    provider: selected?.provider ?? "openai",
    endpoint: endpoint?.apiBase ?? "",
    model: selected?.model ?? "",
    apiKey: endpoint?.apiKey ?? "",
    apiKeyMasked: endpoint?.apiKeyMasked ?? "",
    configured: Boolean(selected?.available)
  };
}

function fromOptionalPreset(view: ModelConfigView, preset: ModelConfigView["providers"][number]["models"][number]) {
  const endpoint = findEndpoint(view, preset);
  return {
    provider: preset.provider,
    endpoint: endpoint?.apiBase ?? "",
    model: preset.model,
    apiKey: endpoint?.apiKey ?? "",
    apiKeyMasked: endpoint?.apiKeyMasked ?? "",
    configured: preset.available
  };
}

function toModelProvider(provider: string): ModelProvider {
  if (provider === "openai") {
    return "openai_compatible";
  }

  return provider === "gemini" ? "google" : (provider as ModelProvider);
}
function toCatalogInput(config: ModelConfigInput | ModelConfigView): ModelConfigInput {
  if (!("configured" in config)) {
    return structuredClone(config);
  }
  return {
    configRevision: config.configRevision,
    providers: config.providers.filter((provider) => provider.editable && !provider.accountManaged).map((provider) => ({
      provider: provider.provider,
      ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
      ...(provider.ownerAccountId ? { ownerAccountId: provider.ownerAccountId } : {}),
      endpoints: provider.endpoints.map((endpoint) => ({
        endpointId: endpoint.endpointId,
        apiBase: endpoint.apiBase,
        protocol: endpoint.protocol,
        ...(endpoint.apiKey ? { apiKey: endpoint.apiKey } : {})
      })),
      models: provider.models.map((model) => ({
        ...(model.presetId ? { presetId: model.presetId } : {}),
        endpointId: model.endpointId,
        model: model.model,
        source: model.source,
        ...(model.ownerAccountId ? { ownerAccountId: model.ownerAccountId } : {}),
        capabilities: [...model.capabilities]
      }))
    })),
    modelAssignments: structuredClone(config.modelAssignments)
  };
}

function findAssignedPreset(view: ModelConfigView, mode: "account" | "byok", capability: ModelCapability) {
  const assignment = view.modelAssignments[mode];
  const id = capability === "agent"
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
  if (!id) return null;
  return view.providers.flatMap((provider) => provider.models).find((preset) => preset.presetId === id) ?? null;
}

function findEndpoint(view: ModelConfigView, preset: ModelConfigView["providers"][number]["models"][number]) {
  return view.providers.find((provider) => provider.provider === preset.provider)
    ?.endpoints.find((endpoint) => endpoint.endpointId === preset.endpointId) ?? null;
}

function apiTypeForProtocol(protocol: ModelEndpointProtocol | undefined): AgentApiType {
  return protocol === "openai-responses" ? "responses" : protocol === "openai-chat-completions" ? "chatCompletions" : "auto";
}

function testProtocolFor(provider: string, capability: ModelConfigTestCapability): ModelEndpointProtocol {
  const canonical = toModelProvider(provider);
  if (canonical === "anthropic") return "anthropic-messages";
  if (canonical === "google") return "gemini-generate-content";
  if (capability === "embedding") return "openai-embeddings";
  if (capability === "asr") return "dashscope-input-audio-chat";
  if (capability === "image") return "openai-images";
  return "openai-chat-completions";
}

function clearLegacyModelWorkspace(): void {
  try {
    if (typeof window !== "undefined") window.localStorage.removeItem(LEGACY_MODEL_WORKSPACE_STORAGE_KEY);
  } catch {
    // A storage denial cannot turn a successful catalog GET into a failure.
  }
}
