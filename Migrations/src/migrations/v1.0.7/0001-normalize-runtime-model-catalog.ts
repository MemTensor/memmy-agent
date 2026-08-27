import { createHash } from "node:crypto";
import {
  mutateRuntimeConfig,
  mutateRuntimeConfigLockHeld,
  type RuntimeConfigDocument,
} from "../../runtime-config-writer.js";
import { MigrationError, type AgentWorkspaceMigrationContext, type MigrationDefinition, type MigrationResult } from "../../types.js";
import { flattenLegacyMemoryModelConfig } from "./legacy-memory-model-config.js";

const MIGRATION_ID = "v1.0.7/0001-normalize-runtime-model-catalog";

export type CatalogCapability =
  | "agent"
  | "memory_summary"
  | "memory_evolution"
  | "embedding"
  | "asr"
  | "image_generation";

export type LegacyCatalogConnection = {
  provider: string;
  apiBase: string;
  model: string;
  protocol?: string;
  apiKey?: string;
  extraHeaders?: Record<string, unknown>;
  extraBody?: Record<string, unknown>;
};

export type LegacyByokCatalog = Partial<Record<CatalogCapability, LegacyCatalogConnection>>;
type JsonObject = Record<string, unknown>;

const PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  openai_compatible: "openai",
  custom: "openai",
  google: "gemini",
  qwen: "dashscope",
  aliyun: "dashscope",
  kimi: "moonshot",
  baidu: "qianfan",
  doubao: "volcengine",
};

const DEFAULT_PROVIDER_ENDPOINTS: Readonly<Record<string, { apiBase: string; protocol: string }>> = {
  openai: { apiBase: "https://api.openai.com/v1", protocol: "openai-chat-completions" },
  anthropic: { apiBase: "https://api.anthropic.com", protocol: "anthropic-messages" },
  gemini: { apiBase: "https://generativelanguage.googleapis.com/v1beta/openai", protocol: "gemini-generate-content" },
  deepseek: { apiBase: "https://api.deepseek.com", protocol: "openai-chat-completions" },
  zhipu: { apiBase: "https://open.bigmodel.cn/api/paas/v4", protocol: "openai-chat-completions" },
  dashscope: { apiBase: "https://dashscope.aliyuncs.com/compatible-mode/v1", protocol: "openai-chat-completions" },
  moonshot: { apiBase: "https://api.moonshot.ai/v1", protocol: "openai-chat-completions" },
  minimax: { apiBase: "https://api.minimax.io/v1", protocol: "openai-chat-completions" },
  qianfan: { apiBase: "https://qianfan.baidubce.com/v2", protocol: "openai-chat-completions" },
  volcengine: { apiBase: "https://ark.cn-beijing.volces.com/api/v3", protocol: "openai-chat-completions" },
};

const CATALOG_CAPABILITIES = new Set<CatalogCapability>([
  "agent",
  "memory_summary",
  "memory_evolution",
  "embedding",
  "asr",
  "image_generation",
]);

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectAt(parent: JsonObject, key: string): JsonObject | null {
  return isObject(parent[key]) ? parent[key] : null;
}

function stringAt(parent: JsonObject | null, ...keys: string[]): string | null {
  if (!parent) return null;
  for (const key of keys) {
    const value = parent[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function copyAlias(target: JsonObject, current: string, legacy: string): void {
  if (!(current in target) && legacy in target) target[current] = target[legacy];
  delete target[legacy];
}

export function canonicalProviderId(value: string): string {
  const normalized = value.trim().toLowerCase().replaceAll("-", "_");
  return PROVIDER_ALIASES[normalized] ?? normalized;
}

function normalizeApiBase(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function protocolFor(
  provider: string,
  capability: CatalogCapability,
  apiType?: string | null,
): string {
  if (provider === "memmy_account") return "memmy-account";
  if (capability === "embedding") return "openai-embeddings";
  if (capability === "asr") return "dashscope-input-audio-chat";
  if (capability === "image_generation") {
    return provider === "dashscope"
      ? "dashscope-multimodal-generation"
      : "openai-images";
  }
  if (provider === "anthropic") return "anthropic-messages";
  if (provider === "gemini") return "gemini-generate-content";
  const normalizedApiType = apiType?.trim().toLowerCase().replaceAll("_", "-");
  return normalizedApiType === "responses" || normalizedApiType === "openai-responses"
    ? "openai-responses"
    : "openai-chat-completions";
}

function normalizeProtocol(value: string | null, provider: string): string {
  if (!value || value === "auto") return protocolFor(provider, "agent");
  switch (value.trim().toLowerCase().replaceAll("_", "-")) {
    case "chatcompletions":
    case "chat-completions":
    case "openai-chat-completions":
      return "openai-chat-completions";
    case "responses":
    case "openai-responses":
      return "openai-responses";
    default:
      return value.trim();
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function hash(value: string, length = 10): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 36) || "model";
}

function normalizeCredentials(value: JsonObject): void {
  copyAlias(value, "apiKey", "api_key");
  copyAlias(value, "apiBase", "api_base");
  copyAlias(value, "apiType", "api_type");
  copyAlias(value, "extraHeaders", "extra_headers");
  copyAlias(value, "extraBody", "extra_body");
  copyAlias(value, "apiBase", "baseUrl");
}

function mergeMissing(target: JsonObject, source: JsonObject): void {
  for (const [key, value] of Object.entries(source)) {
    if (!(key in target)) target[key] = structuredClone(value);
  }
}

function nextEndpointId(endpoints: JsonObject, preferred: string, identity: string): string {
  if (!(preferred in endpoints)) return preferred;
  const candidate = `${preferred}-${hash(identity, 8)}`;
  if (!(candidate in endpoints)) return candidate;
  let suffix = 2;
  while (`${candidate}-${suffix}` in endpoints) suffix += 1;
  return `${candidate}-${suffix}`;
}

function normalizedAuthValue(key: "apiKey" | "extraHeaders" | "extraBody", value: unknown): unknown {
  if (key === "apiKey") return typeof value === "string" && value ? value : null;
  return isObject(value) && Object.keys(value).length > 0 ? value : null;
}

function effectiveAuth(provider: JsonObject, endpoint: JsonObject): JsonObject {
  return {
    apiKey: normalizedAuthValue("apiKey", endpoint.apiKey ?? provider.apiKey),
    extraHeaders: normalizedAuthValue("extraHeaders", endpoint.extraHeaders ?? provider.extraHeaders),
    extraBody: normalizedAuthValue("extraBody", endpoint.extraBody ?? provider.extraBody),
  };
}

function materializedAuthValue(
  key: "apiKey" | "extraHeaders" | "extraBody",
  value: unknown,
): unknown {
  if (value !== null && value !== undefined) return structuredClone(value);
  return key === "apiKey" ? "" : {};
}

function endpointIdentity(provider: JsonObject, endpoint: JsonObject): string {
  return stableJson({
    protocol: endpoint.protocol,
    apiBase: normalizeApiBase(String(endpoint.apiBase ?? "")),
    auth: effectiveAuth(provider, endpoint),
  });
}

type ProviderCatalogNormalization = {
  defaultEndpoints: Record<string, string>;
  endpointReferences: Record<string, Record<string, string>>;
};

function authValueEquals(left: unknown, right: unknown): boolean {
  return stableJson(left ?? null) === stableJson(right ?? null);
}

function normalizeProviderCatalog(
  config: JsonObject,
  migrationId: string,
): ProviderCatalogNormalization {
  const providers = objectAt(config, "providers") ?? {};
  const normalizedProviders: JsonObject = {};
  const defaultEndpoints: Record<string, string> = {};
  const endpointReferences: Record<string, Record<string, string>> = {};
  const entries = Object.entries(providers).sort(([left], [right]) => {
    const leftCanonical = canonicalProviderId(left) === left ? 0 : 1;
    const rightCanonical = canonicalProviderId(right) === right ? 0 : 1;
    return leftCanonical - rightCanonical;
  });

  for (const [legacyId, rawProvider] of entries) {
    if (!isObject(rawProvider)) {
      throw new MigrationError(
        "migration_config_invalid",
        `Provider ${legacyId} must be an object`,
        { migrationId, scope: "runtime-config" },
      );
    }
    const providerId = canonicalProviderId(legacyId);
    const provider = structuredClone(rawProvider);
    normalizeCredentials(provider);
    const frozenDefault = DEFAULT_PROVIDER_ENDPOINTS[providerId];
    const rawEndpoints = objectAt(provider, "endpoints") ?? {};
    const endpointApiBase = stringAt(provider, "apiBase")
      ?? (Object.keys(rawEndpoints).length === 0 ? frozenDefault?.apiBase ?? null : null);
    const endpointApiType = stringAt(provider, "apiType");
    delete provider.apiBase;
    delete provider.apiType;
    const endpoints: JsonObject = {};
    for (const [endpointId, rawEndpoint] of Object.entries(rawEndpoints)) {
      if (!isObject(rawEndpoint)) {
        throw new MigrationError(
          "migration_config_invalid",
          `Endpoint ${legacyId}/${endpointId} must be an object`,
          { migrationId, scope: "runtime-config" },
        );
      }
      const endpoint = structuredClone(rawEndpoint);
      normalizeCredentials(endpoint);
      const apiBase = stringAt(endpoint, "apiBase");
      if (!apiBase) {
        throw new MigrationError(
          "migration_config_invalid",
          `Endpoint ${legacyId}/${endpointId} is missing apiBase`,
          { migrationId, scope: "runtime-config" },
        );
      }
      endpoint.apiBase = normalizeApiBase(apiBase);
      endpoint.protocol = normalizeProtocol(
        stringAt(endpoint, "protocol", "apiType"),
        providerId,
      );
      delete endpoint.apiType;
      endpoints[endpointId] = endpoint;
    }
    let defaultSourceEndpoint: string | null = Object.keys(endpoints)[0] ?? null;
    if (endpointApiBase) {
      const endpoint: JsonObject = {
        apiBase: normalizeApiBase(endpointApiBase),
        protocol: endpointApiType
          ? protocolFor(providerId, "agent", endpointApiType)
          : frozenDefault?.protocol ?? protocolFor(providerId, "agent"),
      };
      const existing = Object.entries(endpoints).find(([, candidate]) =>
        isObject(candidate) && endpointIdentity(provider, candidate) === endpointIdentity(provider, endpoint),
      );
      const preferred = providerId === "memmy_account" ? "platform" : "chat";
      const endpointId = existing?.[0] ?? nextEndpointId(endpoints, preferred, endpointIdentity(provider, endpoint));
      if (!existing) endpoints[endpointId] = endpoint;
      defaultSourceEndpoint = endpointId;
    }
    provider.endpoints = endpoints;

    const target = isObject(normalizedProviders[providerId])
      ? normalizedProviders[providerId]
      : {};
    const providerDefaults = structuredClone(provider);
    delete providerDefaults.endpoints;
    // Establish the canonical Provider defaults before comparing endpoint auth.
    // Otherwise the first Provider's inherited credentials are materialized as
    // endpoint overrides and later Provider-level key rotation cannot take effect.
    mergeMissing(target, providerDefaults);
    const targetEndpoints = objectAt(target, "endpoints") ?? {};
    target.endpoints = targetEndpoints;
    const references: Record<string, string> = {};
    for (const [endpointId, endpoint] of Object.entries(endpoints)) {
      if (!isObject(endpoint)) continue;
      const sourceAuth = effectiveAuth(provider, endpoint);
      const targetAuth = effectiveAuth(target, {});
      const copy = structuredClone(endpoint);
      for (const key of ["apiKey", "extraHeaders", "extraBody"] as const) {
        if (!authValueEquals(sourceAuth[key], targetAuth[key])) {
          copy[key] = materializedAuthValue(key, sourceAuth[key]);
        }
      }
      const identity = endpointIdentity(provider, endpoint);
      const existingId = Object.entries(targetEndpoints).find(([, candidate]) =>
        isObject(candidate) && endpointIdentity(target, candidate) === identity,
      )?.[0];
      const finalId = existingId
        ?? nextEndpointId(targetEndpoints, endpointId, identity);
      if (existingId) {
        mergeMissing(targetEndpoints[existingId] as JsonObject, copy);
      } else {
        targetEndpoints[finalId] = copy;
      }
      references[endpointId] = finalId;
    }
    endpointReferences[legacyId] = references;
    if (!(providerId in endpointReferences)) endpointReferences[providerId] = references;
    if (defaultSourceEndpoint && references[defaultSourceEndpoint]) {
      defaultEndpoints[legacyId] = references[defaultSourceEndpoint]!;
      defaultEndpoints[providerId] ??= references[defaultSourceEndpoint]!;
    }
    target.endpoints = targetEndpoints;
    normalizedProviders[providerId] = target;
  }
  config.providers = normalizedProviders;
  return { defaultEndpoints, endpointReferences };
}

function defaultAssignment(): JsonObject {
  return {
    agent: { candidates: [], default: null },
    memorySummary: null,
    memoryEvolution: null,
    embedding: null,
    asr: null,
    imageGeneration: null,
  };
}

function ensureAssignments(config: JsonObject): JsonObject {
  const assignments = objectAt(config, "modelAssignments") ?? {};
  for (const namespace of ["byok", "account"] as const) {
    const current = objectAt(assignments, namespace) ?? {};
    const defaults = defaultAssignment();
    mergeMissing(current, defaults);
    const agent = objectAt(current, "agent") ?? {};
    mergeMissing(agent, defaults.agent as JsonObject);
    if (!Array.isArray(agent.candidates)) agent.candidates = [];
    current.agent = agent;
    assignments[namespace] = current;
  }
  config.modelAssignments = assignments;
  return assignments;
}

function assignmentField(capability: CatalogCapability): string | null {
  switch (capability) {
    case "memory_summary": return "memorySummary";
    case "memory_evolution": return "memoryEvolution";
    case "embedding": return "embedding";
    case "asr": return "asr";
    case "image_generation": return "imageGeneration";
    default: return null;
  }
}

function assignPreset(assignments: JsonObject, source: "account" | "byok", capability: CatalogCapability, presetId: string): void {
  const assignment = objectAt(assignments, source) ?? defaultAssignment();
  if (capability === "agent") {
    const agent = objectAt(assignment, "agent") ?? { candidates: [], default: null };
    const candidates = Array.isArray(agent.candidates)
      ? agent.candidates.filter((value): value is string => typeof value === "string")
      : [];
    if (!candidates.includes(presetId)) candidates.push(presetId);
    agent.candidates = candidates;
    if (typeof agent.default !== "string" || !agent.default) agent.default = presetId;
    assignment.agent = agent;
  } else {
    const field = assignmentField(capability)!;
    if (typeof assignment[field] !== "string" || !assignment[field]) assignment[field] = presetId;
  }
  assignments[source] = assignment;
}

function ensureEndpoint(
  provider: JsonObject,
  capability: CatalogCapability,
  connection: LegacyCatalogConnection,
): string {
  const endpoints = objectAt(provider, "endpoints") ?? {};
  const providerApiKey = stringAt(provider, "apiKey");
  if (!providerApiKey && connection.apiKey) provider.apiKey = connection.apiKey;
  const endpoint: JsonObject = {
    apiBase: normalizeApiBase(connection.apiBase),
    protocol: (capability === "agent" || capability.startsWith("memory_")) && connection.protocol
      ? connection.protocol
      : protocolFor(canonicalProviderId(connection.provider), capability),
  };
  if (connection.apiKey && stringAt(provider, "apiKey") !== connection.apiKey) endpoint.apiKey = connection.apiKey;
  if (connection.extraHeaders) endpoint.extraHeaders = structuredClone(connection.extraHeaders);
  if (connection.extraBody) endpoint.extraBody = structuredClone(connection.extraBody);
  const identity = endpointIdentity(provider, endpoint);
  const existing = Object.entries(endpoints).find(([, candidate]) =>
    isObject(candidate) && endpointIdentity(provider, candidate) === identity,
  );
  if (existing) return existing[0];
  const preferred = capability === "agent" || capability.startsWith("memory_")
    ? "chat"
    : capability === "image_generation" ? "image" : capability;
  const endpointId = nextEndpointId(endpoints, preferred, identity);
  endpoints[endpointId] = endpoint;
  provider.endpoints = endpoints;
  return endpointId;
}

function ensurePreset(
  config: JsonObject,
  capability: CatalogCapability,
  connection: LegacyCatalogConnection,
): string {
  const providerId = canonicalProviderId(connection.provider);
  const providers = objectAt(config, "providers") ?? {};
  const provider = isObject(providers[providerId]) ? providers[providerId] : { endpoints: {} };
  providers[providerId] = provider;
  config.providers = providers;
  const endpointId = ensureEndpoint(provider, capability, { ...connection, provider: providerId });
  const presets = objectAt(config, "modelPresets") ?? {};
  const existing = Object.entries(presets).find(([, value]) =>
    isObject(value) &&
    value.provider === providerId &&
    value.endpoint === endpointId &&
    value.model === connection.model &&
    value.source === "byok",
  );
  if (existing && isObject(existing[1])) {
    const capabilities = Array.isArray(existing[1].capabilities)
      ? existing[1].capabilities.filter((value): value is string => typeof value === "string")
      : [];
    if (!capabilities.includes(capability)) capabilities.push(capability);
    existing[1].capabilities = capabilities;
    return existing[0];
  }
  const identity = stableJson({ providerId, endpointId, model: connection.model });
  const base = `byok-${providerId}-${slug(connection.model)}-${hash(identity, 8)}`;
  let presetId = base;
  let suffix = 2;
  while (presetId in presets) presetId = `${base}-${suffix++}`;
  presets[presetId] = {
    provider: providerId,
    endpoint: endpointId,
    model: connection.model,
    source: "byok",
    capabilities: [capability],
  };
  config.modelPresets = presets;
  return presetId;
}

export function mergeLegacyByokCatalog(config: RuntimeConfigDocument, legacy: LegacyByokCatalog): void {
  const assignments = ensureAssignments(config);
  for (const capability of [
    "agent",
    "memory_summary",
    "memory_evolution",
    "embedding",
    "asr",
    "image_generation",
  ] as const) {
    const connection = legacy[capability];
    if (!connection?.provider || !connection.apiBase || !connection.model) continue;
    const presetId = ensurePreset(config, capability, connection);
    assignPreset(assignments, "byok", capability, presetId);
  }
}

function connectionFrom(value: JsonObject | null, fallbackProvider?: string | null): LegacyCatalogConnection | null {
  const provider = stringAt(value, "provider", "vendor") ?? fallbackProvider;
  const apiBase = stringAt(value, "apiBase", "api_base", "baseUrl", "endpoint");
  const model = stringAt(value, "model", "modelId", "model_id");
  if (!provider || !apiBase || !model) return null;
  const apiKey = stringAt(value, "apiKey", "api_key");
  const legacyProtocol = stringAt(value, "protocol", "apiType", "api_type");
  const extraHeaders = value && isObject(value.extraHeaders ?? value.extra_headers)
    ? (value.extraHeaders ?? value.extra_headers) as JsonObject
    : undefined;
  const extraBody = value && isObject(value.extraBody ?? value.extra_body)
    ? (value.extraBody ?? value.extra_body) as JsonObject
    : undefined;
  return {
    provider,
    apiBase,
    model,
    ...(legacyProtocol ? { protocol: normalizeProtocol(legacyProtocol, canonicalProviderId(provider)) } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(extraHeaders ? { extraHeaders } : {}),
    ...(extraBody ? { extraBody } : {}),
  };
}

function providerConnection(config: JsonObject, source: JsonObject | null): LegacyCatalogConnection | null {
  const configuredModel = stringAt(source, "model");
  const qualifiedModel = configuredModel?.includes("/") ? configuredModel.split("/", 2) : null;
  const providerName = stringAt(source, "provider") ?? qualifiedModel?.[0] ?? null;
  const model = qualifiedModel?.[1] || configuredModel;
  if (!providerName || !model || providerName === "auto") return null;
  const providers = objectAt(config, "providers");
  const provider = providers && isObject(providers[providerName]) ? providers[providerName] : null;
  const merged = { ...(provider ?? {}), ...source };
  if (!stringAt(merged, "apiBase", "api_base", "baseUrl", "endpoint")) {
    const frozen = DEFAULT_PROVIDER_ENDPOINTS[canonicalProviderId(providerName)];
    if (frozen) {
      merged.apiBase = frozen.apiBase;
      merged.protocol = stringAt(merged, "apiType", "api_type")
        ? normalizeProtocol(stringAt(merged, "apiType", "api_type"), canonicalProviderId(providerName))
        : frozen.protocol;
    }
  }
  const connection = connectionFrom(merged, providerName);
  return connection ? { ...connection, model } : null;
}

function captureLegacyConnections(config: JsonObject): LegacyByokCatalog {
  const legacy: LegacyByokCatalog = {};
  const agents = objectAt(config, "agents");
  const defaults = agents ? objectAt(agents, "defaults") : null;
  const agent = providerConnection(config, defaults);
  if (agent) legacy.agent = agent;

  const memory = objectAt(config, "memmyMemory");
  const summary = connectionFrom(memory ? objectAt(memory, "summary") : null);
  const evolution = connectionFrom(memory ? objectAt(memory, "evolution") : null);
  if (summary) legacy.memory_summary = summary;
  if (evolution) legacy.memory_evolution = evolution;
  const embedding = memory ? objectAt(memory, "embedding") : null;
  const customEmbedding = embedding && isObject(embedding.custom) ? embedding.custom : embedding;
  const embeddingConnection = stringAt(embedding, "mode") === "local"
    ? null
    : connectionFrom(customEmbedding);
  if (embeddingConnection) legacy.embedding = embeddingConnection;

  const tools = objectAt(config, "tools");
  const asr = tools ? objectAt(tools, "asr") : null;
  const asrConnection = connectionFrom(asr, "dashscope");
  if (asrConnection) legacy.asr = asrConnection;
  const image = tools ? objectAt(tools, "imageGeneration") : null;
  const byokProfile = image && isObject(image.profiles) && isObject(image.profiles.byok)
    ? image.profiles.byok
    : null;
  const imageConnection = connectionFrom(byokProfile ?? image);
  if (imageConnection) legacy.image_generation = imageConnection;
  return legacy;
}

function replaceArrayValue(value: unknown, from: string, to: string): unknown {
  return Array.isArray(value) ? value.map((item) => item === from ? to : item) : value;
}

function rewritePresetReference(
  config: JsonObject,
  from: string,
  replacements: Partial<Record<CatalogCapability, string>>,
): void {
  const agentReplacement = replacements.agent;
  const agents = objectAt(config, "agents");
  const defaults = agents ? objectAt(agents, "defaults") : null;
  if (agentReplacement && defaults) {
    if (defaults.modelPreset === from) defaults.modelPreset = agentReplacement;
    defaults.fallbackModels = replaceArrayValue(defaults.fallbackModels, from, agentReplacement);
  }
  const assignments = objectAt(config, "modelAssignments");
  if (!assignments) return;
  for (const namespace of ["byok", "account"] as const) {
    const assignment = objectAt(assignments, namespace);
    if (!assignment) continue;
    const agent = objectAt(assignment, "agent");
    if (agentReplacement && agent) {
      agent.candidates = replaceArrayValue(agent.candidates, from, agentReplacement);
      if (agent.default === from) agent.default = agentReplacement;
    }
    for (const [capability, field] of [
      ["memory_summary", "memorySummary"],
      ["memory_evolution", "memoryEvolution"],
      ["embedding", "embedding"],
      ["asr", "asr"],
      ["image_generation", "imageGeneration"],
    ] as const) {
      if (assignment[field] === from && replacements[capability]) {
        assignment[field] = replacements[capability];
      }
    }
  }
}

function normalizePresets(
  config: JsonObject,
  normalization: ProviderCatalogNormalization,
  migrationId: string,
): void {
  const { defaultEndpoints, endpointReferences } = normalization;
  const presets = objectAt(config, "modelPresets") ?? {};
  const providers = objectAt(config, "providers") ?? {};
  const assignments = ensureAssignments(config);
  const app = objectAt(config, "app");
  for (const [presetId, rawPreset] of Object.entries(presets)) {
    if (!isObject(rawPreset)) continue;
    const providerValue = stringAt(rawPreset, "provider");
    if (!providerValue) continue;
    const legacyProvider = providerValue;
    const providerId = canonicalProviderId(providerValue);
    rawPreset.provider = providerId;
    delete rawPreset.label;
    const legacyEndpoint = stringAt(rawPreset, "endpoint");
    const endpoint = (legacyEndpoint ? endpointReferences[legacyProvider]?.[legacyEndpoint] : null)
      ?? defaultEndpoints[legacyProvider]
      ?? defaultEndpoints[providerId]
      ?? Object.keys(isObject(providers[providerId]) && isObject(providers[providerId].endpoints)
        ? providers[providerId].endpoints as JsonObject
        : {})[0];
    if (endpoint) rawPreset.endpoint = endpoint;
    const source = rawPreset.source === "account" || providerId === "memmy_account" ? "account" : "byok";
    rawPreset.source = source;
    if (!Array.isArray(rawPreset.capabilities) || rawPreset.capabilities.length === 0) {
      rawPreset.capabilities = ["agent"];
    }
    const provider = isObject(providers[providerId]) ? providers[providerId] : null;
    if (source === "account" && !stringAt(rawPreset, "ownerAccountId")) {
      const owner = stringAt(provider, "ownerAccountId") ?? stringAt(app, "userId");
      if (owner) rawPreset.ownerAccountId = owner;
    }
    const capabilities = rawPreset.capabilities as unknown[];
    if (source === "account" && presetId === "memmy-account") {
      const owner = stringAt(rawPreset, "ownerAccountId");
      if (!owner) {
        throw new MigrationError(
          "migration_config_invalid",
          "Legacy account model preset is missing an owner account ID",
          { migrationId, scope: "runtime-config" },
        );
      }
      const replacements: Partial<Record<CatalogCapability, string>> = {};
      for (const capability of capabilities) {
        if (typeof capability !== "string") continue;
        const typedCapability = capability as CatalogCapability;
        const replacementId = `memmy-account-${hash(owner, 12)}-${capability.replaceAll("_", "-")}`;
        presets[replacementId] = {
          ...structuredClone(rawPreset),
          ownerAccountId: owner,
          capabilities: [capability],
        };
        replacements[typedCapability] = replacementId;
        assignPreset(assignments, "account", typedCapability, replacementId);
      }
      delete presets[presetId];
      rewritePresetReference(config, presetId, replacements);
      continue;
    }
    for (const capability of capabilities) {
      if (typeof capability === "string") assignPreset(assignments, source, capability as CatalogCapability, presetId);
    }
  }
  config.modelPresets = presets;
}

function ensureAccountCatalog(config: JsonObject): void {
  const providers = objectAt(config, "providers");
  const provider = providers && isObject(providers.memmy_account) ? providers.memmy_account : null;
  if (!provider) return;
  const app = objectAt(config, "app");
  const owner = stringAt(provider, "ownerAccountId") ?? stringAt(app, "userId");
  if (!owner) return;
  provider.ownerAccountId = owner;
  const endpoints = objectAt(provider, "endpoints");
  const endpointId = endpoints
    ? Object.entries(endpoints).find(([, endpoint]) =>
        isObject(endpoint) && endpoint.protocol === "memmy-account",
      )?.[0]
    : undefined;
  if (!endpointId) return;
  const assignments = ensureAssignments(config);
  const accountAssignment = objectAt(assignments, "account") ?? defaultAssignment();
  const assignmentOwner = stringAt(accountAssignment, "ownerAccountId");
  const mayAssign = !assignmentOwner || assignmentOwner === owner;
  if (!assignmentOwner) accountAssignment.ownerAccountId = owner;
  assignments.account = accountAssignment;
  const presets = objectAt(config, "modelPresets") ?? {};
  const models: Readonly<Record<CatalogCapability, string>> = {
    agent: "agent_chat",
    memory_summary: "memory_summary",
    memory_evolution: "memory_evolution",
    embedding: "embedding",
    asr: "asr",
    image_generation: "image_gen",
  };
  for (const [capability, model] of Object.entries(models) as Array<[CatalogCapability, string]>) {
    const presetId = `memmy-account-${hash(owner, 12)}-${capability.replaceAll("_", "-")}`;
    const existing = isObject(presets[presetId]) ? presets[presetId] : {};
    presets[presetId] = {
      ...existing,
      provider: "memmy_account",
      endpoint: endpointId,
      model,
      source: "account",
      ownerAccountId: owner,
      capabilities: [capability],
    };
    delete (presets[presetId] as JsonObject).label;
    if (mayAssign) assignPreset(assignments, "account", capability, presetId);
  }
  config.modelPresets = presets;
}

function liftLegacyRoots(config: JsonObject): void {
  const legacyAgent = objectAt(config, "agent");
  let agents = objectAt(config, "agents");
  if (!agents && legacyAgent) {
    agents = { defaults: structuredClone(legacyAgent) };
    config.agents = agents;
  } else if (agents && legacyAgent && !isObject(agents.defaults)) {
    agents.defaults = structuredClone(legacyAgent);
  }
  const rootModel = typeof config.model === "string" && config.model.trim()
    ? config.model.trim()
    : null;
  if (rootModel) {
    agents ??= {};
    const defaults = objectAt(agents, "defaults") ?? {};
    if (!("model" in defaults)) defaults.model = rootModel;
    agents.defaults = defaults;
    config.agents = agents;
  }
  delete config.agent;
  delete config.model;
  const tools = objectAt(config, "tools");
  if (tools) {
    delete tools.my;
    delete tools.myEnabled;
    delete tools.mySet;
  }
}

export function removeLegacyRuntimeModelFields(config: RuntimeConfigDocument): void {
  const memmyMemory = objectAt(config, "memmyMemory");
  if (memmyMemory) {
    for (const key of ["enable", "activeProfile", "profiles", "summary", "evolution", "embedding"]) {
      delete memmyMemory[key];
    }
  }
  const tools = objectAt(config, "tools");
  const imageGeneration = tools ? objectAt(tools, "imageGeneration") : null;
  if (imageGeneration) {
    for (const key of [
      "activeProfile",
      "active_profile",
      "profiles",
      "provider",
      "model",
      "apiKey",
      "api_key",
      "apiBase",
      "api_base",
      "extraHeaders",
      "extra_headers",
      "extraBody",
      "extra_body",
      "default_aspect_ratio",
      "default_image_size",
      "max_images_per_turn",
      "save_dir",
    ]) {
      delete imageGeneration[key];
    }
  }

  removeInvalidByokAccountProjection(config);
}

function removeInvalidByokAccountPresets(config: RuntimeConfigDocument): void {
  const presets = objectAt(config, "modelPresets");
  if (!presets) return;
  for (const [presetId, value] of Object.entries(presets)) {
    if (isObject(value) && value.source === "byok" && value.provider === "memmy_account") {
      delete presets[presetId];
    }
  }
}

/**
 * Removes a broken legacy projection where the managed account provider was
 * copied into the BYOK catalog. Besides being unusable, that projection makes
 * every later catalog PUT fail because account presets are read-only.
 */
function removeInvalidByokAccountProjection(config: RuntimeConfigDocument): void {
  removeInvalidByokAccountPresets(config);

  const assignments = objectAt(config, "modelAssignments");
  const byok = assignments ? objectAt(assignments, "byok") : null;
  if (!byok) return;

  const agent = objectAt(byok, "agent") ?? {};
  const candidates = Array.isArray(agent.candidates)
    ? agent.candidates.filter((presetId): presetId is string => (
        typeof presetId === "string"
        && isValidByokPresetForCapability(config, presetId, "agent")
      ))
    : [];
  const currentDefault = stringAt(agent, "default");
  agent.candidates = [...new Set(candidates)];
  agent.default = currentDefault && candidates.includes(currentDefault)
    ? currentDefault
    : candidates[0] ?? null;
  byok.agent = agent;

  for (const [field, capability] of [
    ["memorySummary", "memory_summary"],
    ["memoryEvolution", "memory_evolution"],
    ["embedding", "embedding"],
    ["asr", "asr"],
    ["imageGeneration", "image_generation"],
  ] as const) {
    const presetId = stringAt(byok, field);
    if (!presetId || !isValidByokPresetForCapability(config, presetId, capability)) {
      byok[field] = null;
    }
  }
}

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function protocolSupportsCapability(
  protocol: unknown,
  capability: CatalogCapability,
): boolean {
  if (typeof protocol !== "string") return false;
  if (capability === "embedding") return protocol === "openai-embeddings";
  if (capability === "asr") return protocol === "dashscope-input-audio-chat";
  if (capability === "image_generation") {
    return protocol === "openai-images" || protocol === "dashscope-multimodal-generation";
  }
  return [
    "openai-chat-completions",
    "openai-responses",
    "anthropic-messages",
    "gemini-generate-content",
  ].includes(protocol);
}

function protocolSupportsProvider(protocol: unknown, provider: string): boolean {
  if (protocol === "anthropic-messages") return provider === "anthropic";
  if (protocol === "gemini-generate-content") return provider === "gemini";
  if (protocol === "dashscope-input-audio-chat" || protocol === "dashscope-multimodal-generation") {
    return provider === "dashscope";
  }
  if (protocol === "memmy-account") return provider === "memmy_account";
  return provider !== "anthropic" && provider !== "gemini" && provider !== "memmy_account";
}

export function isValidByokPresetForCapability(
  config: RuntimeConfigDocument,
  presetId: string,
  capability: CatalogCapability,
): boolean {
  const presets = objectAt(config, "modelPresets");
  const preset = presets && isObject(presets[presetId]) ? presets[presetId] : null;
  if (!preset || preset.source !== "byok") return false;
  const providerId = stringAt(preset, "provider");
  const endpointId = stringAt(preset, "endpoint");
  const model = stringAt(preset, "model");
  const capabilities = Array.isArray(preset.capabilities) ? preset.capabilities : [];
  if (
    !providerId
    || providerId === "memmy_account"
    || !DEFAULT_PROVIDER_ENDPOINTS[providerId]
    || !endpointId
    || !model
    || capabilities.length === 0
    || !capabilities.every((value) => typeof value === "string" && CATALOG_CAPABILITIES.has(value as CatalogCapability))
    || !capabilities.includes(capability)
  ) return false;
  const providers = objectAt(config, "providers");
  const provider = providers && isObject(providers[providerId]) ? providers[providerId] : null;
  const endpoints = provider ? objectAt(provider, "endpoints") : null;
  const endpoint = endpoints && isObject(endpoints[endpointId]) ? endpoints[endpointId] : null;
  return Boolean(
    endpoint
    && isHttpUrl(endpoint.apiBase)
    && capabilities.every((value) => protocolSupportsCapability(endpoint.protocol, value as CatalogCapability))
    && protocolSupportsProvider(endpoint.protocol, providerId),
  );
}

function byokAssignmentReferences(config: RuntimeConfigDocument): Array<[string, CatalogCapability]> {
  const assignments = objectAt(config, "modelAssignments");
  const byok = assignments ? objectAt(assignments, "byok") : null;
  if (!byok) return [];
  const references: Array<[string, CatalogCapability]> = [];
  const agent = objectAt(byok, "agent");
  if (agent && Array.isArray(agent.candidates)) {
    const candidates = agent.candidates;
    const defaultPreset = stringAt(agent, "default");
    if (
      defaultPreset
      && candidates.includes(defaultPreset)
      && candidates.every((value) => typeof value === "string" && value.length > 0)
    ) {
      for (const value of candidates as string[]) references.push([value, "agent"]);
    }
  }
  for (const [field, capability] of [
    ["memorySummary", "memory_summary"],
    ["memoryEvolution", "memory_evolution"],
    ["embedding", "embedding"],
    ["asr", "asr"],
    ["imageGeneration", "image_generation"],
  ] as const) {
    const value = byok[field];
    if (typeof value === "string" && value) references.push([value, capability]);
  }
  return references;
}

export function hasAnyValidByokAssignment(config: RuntimeConfigDocument): boolean {
  return byokAssignmentReferences(config).some(([presetId, capability]) =>
    isValidByokPresetForCapability(config, presetId, capability),
  );
}

export function hasCompleteByokCatalog(config: RuntimeConfigDocument): boolean {
  const references = byokAssignmentReferences(config);
  if (references.length === 0) return false;
  if (!references.every(([presetId, capability]) =>
    isValidByokPresetForCapability(config, presetId, capability))) return false;
  const assignments = objectAt(config, "modelAssignments");
  const byok = assignments ? objectAt(assignments, "byok") : null;
  const agent = byok ? objectAt(byok, "agent") : null;
  const candidates = agent && Array.isArray(agent.candidates) ? agent.candidates : [];
  const defaultPreset = stringAt(agent, "default");
  return candidates.length === 0 || Boolean(defaultPreset && candidates.includes(defaultPreset));
}

function hasCurrentAccountCatalog(config: RuntimeConfigDocument): boolean {
  const providers = objectAt(config, "providers");
  const provider = providers && isObject(providers.memmy_account) ? providers.memmy_account : null;
  const assignments = objectAt(config, "modelAssignments");
  const account = assignments ? objectAt(assignments, "account") : null;
  const owner = stringAt(provider, "ownerAccountId");
  if (!provider || !account || !owner || stringAt(account, "ownerAccountId") !== owner) return false;
  const agent = objectAt(account, "agent");
  const defaultPresetId = stringAt(agent, "default");
  if (!defaultPresetId) return false;
  const presets = objectAt(config, "modelPresets");
  const preset = presets && isObject(presets[defaultPresetId]) ? presets[defaultPresetId] : null;
  if (!preset || preset.source !== "account" || stringAt(preset, "ownerAccountId") !== owner) return false;
  const endpointId = stringAt(preset, "endpoint");
  const endpoints = objectAt(provider, "endpoints");
  const endpoint = endpointId && endpoints && isObject(endpoints[endpointId]) ? endpoints[endpointId] : null;
  return Boolean(endpoint && endpoint.protocol === "memmy-account" && isHttpUrl(endpoint.apiBase));
}

function normalizeRuntimeCatalog(config: RuntimeConfigDocument, migrationId: string): void {
  flattenLegacyMemoryModelConfig(config);
  liftLegacyRoots(config);
  const legacy = captureLegacyConnections(config);
  const assignmentsBefore = objectAt(config, "modelAssignments");
  const accountBefore = assignmentsBefore && isObject(assignmentsBefore.account)
    ? structuredClone(assignmentsBefore.account)
    : null;
  const accountOwnerBefore = stringAt(accountBefore, "ownerAccountId");
  const providersBefore = objectAt(config, "providers");
  const accountProviderBefore = providersBefore && isObject(providersBefore.memmy_account)
    ? providersBefore.memmy_account
    : null;
  const appBefore = objectAt(config, "app");
  const currentOwner = stringAt(accountProviderBefore, "ownerAccountId") ?? stringAt(appBefore, "userId");
  const preserveDormantAccount = Boolean(
    accountBefore && accountOwnerBefore && currentOwner && accountOwnerBefore !== currentOwner,
  );

  removeInvalidByokAccountPresets(config);
  const normalization = normalizeProviderCatalog(config, migrationId);
  normalizePresets(config, normalization, migrationId);
  ensureAccountCatalog(config);
  mergeLegacyByokCatalog(config, legacy);
  removeLegacyRuntimeModelFields(config);
  if (preserveDormantAccount && accountBefore) {
    const assignments = objectAt(config, "modelAssignments") ?? {};
    assignments.account = accountBefore;
    config.modelAssignments = assignments;
  }
  const app = objectAt(config, "app") ?? {};
  if (hasCompleteByokCatalog(config) || hasCurrentAccountCatalog(config)) {
    app.modelCatalogVersion = 1;
  } else {
    delete app.modelCatalogVersion;
  }
  config.app = app;
}

function wrapError(error: unknown, migrationId: string): never {
  if (error instanceof MigrationError) {
    if (error.migrationId === migrationId) throw error;
    throw new MigrationError(error.code, error.message, {
      migrationId,
      scope: "runtime-config",
      cause: error.cause,
    });
  }
  throw new MigrationError("migration_config_invalid", "Unable to normalize runtime model catalog", {
    migrationId,
    scope: "runtime-config",
    cause: error,
  });
}

export async function runRuntimeModelCatalogMigration(
  context: AgentWorkspaceMigrationContext,
  migrationId: string,
): Promise<MigrationResult> {
  try {
    const mutator = (config: RuntimeConfigDocument): void => normalizeRuntimeCatalog(config, migrationId);
    const options = { createIfMissing: false as const };
    const result = context.runtimeConfigLock
      ? await mutateRuntimeConfigLockHeld(context.runtimeConfigLock, mutator, options)
      : await mutateRuntimeConfig(context.runtimeConfigFile, mutator, options);
    if (!result.sourceExists) {
      return { scanned: 0, changed: 0, ignored: 0, deferred: true };
    }
    return result.changed
      ? { scanned: 1, changed: 1, ignored: 0 }
      : { scanned: 1, changed: 0, ignored: 1 };
  } catch (error) {
    wrapError(error, migrationId);
  }
}

export const normalizeRuntimeModelCatalogV107: MigrationDefinition = {
  id: MIGRATION_ID,
  introducedIn: "1.0.7",
  scope: "runtime-config",
  description: "Normalize legacy model settings into the runtime model catalog",
  up: (context) => runRuntimeModelCatalogMigration(context, MIGRATION_ID),
};

export function normalizeRuntimeModelCatalogForTest(
  context: AgentWorkspaceMigrationContext,
): Promise<MigrationResult> {
  return runRuntimeModelCatalogMigration(context, MIGRATION_ID);
}
