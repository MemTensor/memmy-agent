import type { RuntimeConfigDocument } from "../../runtime-config-writer.js";
import { MigrationError } from "../../types.js";

const MIGRATION_ID = "v1.0.7/0001-normalize-runtime-model-catalog";
const CONNECTION_FIELDS = [
  "provider",
  "vendor",
  "endpoint",
  "apiBase",
  "baseUrl",
  "model",
  "apiKey",
] as const;

type JsonObject = Record<string, unknown>;
type MemoryRole = "summary" | "evolution";
type MemoryRoleRouting = "follow" | "fixed";
type EmbeddingMode = "cloud" | "local" | "custom";

type AgentModelConnection = {
  provider: string;
  endpoint: string;
  model: string;
};

type LegacyMemoryView = {
  activeProfile: "account" | "byok" | null;
  accountProfile: JsonObject | null;
  byokProfile: JsonObject | null;
  roleRouting: JsonObject | null;
  rootSummary: JsonObject | null;
  rootEvolution: JsonObject | null;
  rootEmbedding: JsonObject | null;
  hasLegacyShape: boolean;
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function configError(message: string, cause?: unknown): MigrationError {
  return new MigrationError("migration_config_invalid", message, {
    migrationId: MIGRATION_ID,
    scope: "runtime-config",
    cause,
  });
}

function optionalObject(parent: JsonObject, key: string, fieldPath: string): JsonObject | null {
  if (!hasOwn(parent, key) || parent[key] === null || parent[key] === undefined) return null;
  if (!isObject(parent[key])) throw configError(`${fieldPath} must be an object`);
  return parent[key];
}

function optionalString(parent: JsonObject | null, key: string, fieldPath: string): string | null {
  if (!parent || !hasOwn(parent, key) || parent[key] === null || parent[key] === undefined) {
    return null;
  }
  if (typeof parent[key] !== "string") throw configError(`${fieldPath} must be a string`);
  const value = parent[key].trim();
  return value || null;
}

function profileName(value: unknown): "account" | "byok" | null {
  if (value === undefined || value === null) return null;
  if (value === "account" || value === "byok") return value;
  throw configError("memmyMemory.activeProfile must be account or byok");
}

function roleRoutingValue(
  roleRouting: JsonObject | null,
  role: MemoryRole,
): MemoryRoleRouting | null {
  if (!roleRouting || !hasOwn(roleRouting, role)) return null;
  const value = roleRouting[role];
  if (value === "follow" || value === "fixed") return value;
  throw configError(`memmyMemory.roleRouting.${role} must be follow or fixed`);
}

function embeddingModeValue(embedding: JsonObject | null): EmbeddingMode | null {
  if (!embedding || !hasOwn(embedding, "mode")) return null;
  const value = embedding.mode;
  if (value === "cloud" || value === "local" || value === "custom") return value;
  throw configError("memmyMemory.embedding.mode must be cloud, local, or custom");
}

function memoryProfile(
  profiles: JsonObject | null,
  name: "account" | "byok",
): JsonObject | null {
  return profiles ? optionalObject(profiles, name, `memmyMemory.profiles.${name}`) : null;
}

function memoryRoleConfig(
  container: JsonObject | null,
  role: MemoryRole,
  fieldPath: string,
): JsonObject | null {
  return container ? optionalObject(container, role, `${fieldPath}.${role}`) : null;
}

function readLegacyMemoryView(config: JsonObject): LegacyMemoryView | null {
  const memmyMemory = optionalObject(config, "memmyMemory", "memmyMemory");
  if (!memmyMemory) return null;

  const activeProfile = profileName(memmyMemory.activeProfile);
  const profiles = optionalObject(memmyMemory, "profiles", "memmyMemory.profiles");
  const accountProfile = memoryProfile(profiles, "account");
  const byokProfile = memoryProfile(profiles, "byok");
  const roleRouting = optionalObject(memmyMemory, "roleRouting", "memmyMemory.roleRouting");
  const rootSummary = memoryRoleConfig(memmyMemory, "summary", "memmyMemory");
  const rootEvolution = memoryRoleConfig(memmyMemory, "evolution", "memmyMemory");
  const rootEmbedding = optionalObject(memmyMemory, "embedding", "memmyMemory.embedding");

  roleRoutingValue(roleRouting, "summary");
  roleRoutingValue(roleRouting, "evolution");
  embeddingModeValue(rootEmbedding);

  memoryRoleConfig(accountProfile, "summary", "memmyMemory.profiles.account");
  memoryRoleConfig(accountProfile, "evolution", "memmyMemory.profiles.account");
  optionalObject(accountProfile ?? {}, "embedding", "memmyMemory.profiles.account.embedding");
  memoryRoleConfig(byokProfile, "summary", "memmyMemory.profiles.byok");
  memoryRoleConfig(byokProfile, "evolution", "memmyMemory.profiles.byok");
  optionalObject(byokProfile ?? {}, "embedding", "memmyMemory.profiles.byok.embedding");

  const rootRoleNeedsRouting =
    roleRouting === null && (rootSummary !== null || rootEvolution !== null);
  const rootEmbeddingNeedsMode =
    rootEmbedding !== null && !hasOwn(rootEmbedding, "mode");
  const hasLegacyShape =
    hasOwn(memmyMemory, "activeProfile") ||
    hasOwn(memmyMemory, "profiles") ||
    rootRoleNeedsRouting ||
    rootEmbeddingNeedsMode;

  return {
    activeProfile,
    accountProfile,
    byokProfile,
    roleRouting,
    rootSummary,
    rootEvolution,
    rootEmbedding,
    hasLegacyShape,
  };
}

function normalizeProviderName(value: string): string {
  switch (value.trim().toLowerCase().replaceAll("-", "_")) {
    case "openai":
    case "deepseek":
    case "zhipu":
    case "dashscope":
    case "moonshot":
    case "minimax":
    case "qianfan":
    case "volcengine":
    case "memmy_account":
      return "openai_compatible";
    case "google":
      return "gemini";
    default:
      return value.trim().toLowerCase().replaceAll("-", "_");
  }
}

function normalizedEndpoint(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function resolveAgentModelConnection(config: JsonObject): AgentModelConnection | null {
  const agents = optionalObject(config, "agents", "agents");
  const defaults = agents ? optionalObject(agents, "defaults", "agents.defaults") : null;
  if (!defaults) return null;

  let source = defaults;
  const presetName = optionalString(defaults, "modelPreset", "agents.defaults.modelPreset");
  if (presetName && presetName !== "default") {
    const presets = optionalObject(config, "modelPresets", "modelPresets");
    const preset = presets
      ? optionalObject(presets, presetName, `modelPresets.${presetName}`)
      : null;
    if (preset) source = preset;
  }

  const provider = optionalString(source, "provider", "Agent model provider");
  const model = optionalString(source, "model", "Agent model");
  if (!provider || !model || provider === "auto") return null;

  const providers = optionalObject(config, "providers", "providers");
  const providerConfig = providers
    ? optionalObject(providers, provider, `providers.${provider}`)
    : null;
  const endpoint =
    optionalString(providerConfig, "apiBase", `providers.${provider}.apiBase`) ??
    optionalString(providerConfig, "baseUrl", `providers.${provider}.baseUrl`) ??
    "";

  return {
    provider: normalizeProviderName(provider),
    endpoint: normalizedEndpoint(endpoint),
    model,
  };
}

function roleHasConnectionFields(role: JsonObject | null): boolean {
  return Boolean(role && CONNECTION_FIELDS.some((field) => hasOwn(role, field)));
}

function roleMatchesAgent(
  role: JsonObject | null,
  agentConnection: AgentModelConnection | null,
): boolean {
  if (!role || !roleHasConnectionFields(role)) return true;
  if (!agentConnection) return false;
  const provider = optionalString(role, "provider", "Memory role provider");
  const endpoint =
    optionalString(role, "endpoint", "Memory role endpoint") ??
    optionalString(role, "apiBase", "Memory role apiBase") ??
    optionalString(role, "baseUrl", "Memory role baseUrl");
  const model = optionalString(role, "model", "Memory role model");
  if (!provider || !endpoint || !model) return false;
  return (
    normalizeProviderName(provider) === agentConnection.provider &&
    normalizedEndpoint(endpoint) === agentConnection.endpoint &&
    model === agentConnection.model
  );
}

function legacyRoleForRouting(
  view: LegacyMemoryView,
  role: MemoryRole,
): JsonObject | null {
  const root = role === "summary" ? view.rootSummary : view.rootEvolution;
  const byok = memoryRoleConfig(
    view.byokProfile,
    role,
    "memmyMemory.profiles.byok",
  );
  return byok ?? root;
}

function resolvedRoleRouting(
  view: LegacyMemoryView,
  role: MemoryRole,
  agentConnection: AgentModelConnection | null,
): MemoryRoleRouting {
  const explicit = roleRoutingValue(view.roleRouting, role);
  if (explicit) return explicit;
  if (view.activeProfile === "account") return "follow";
  return roleMatchesAgent(legacyRoleForRouting(view, role), agentConnection)
    ? "follow"
    : "fixed";
}

function fixedRoleConfig(
  view: LegacyMemoryView,
  role: MemoryRole,
): JsonObject | null {
  const root = role === "summary" ? view.rootSummary : view.rootEvolution;
  if (root) return root;
  return memoryRoleConfig(
    view.byokProfile,
    role,
    "memmyMemory.profiles.byok",
  );
}

function embeddingFromProfile(profile: JsonObject | null, fieldPath: string): JsonObject | null {
  return profile ? optionalObject(profile, "embedding", `${fieldPath}.embedding`) : null;
}

function isLocalEmbedding(embedding: JsonObject | null): boolean {
  const provider = optionalString(embedding, "provider", "Memory embedding provider");
  return !embedding || !provider || provider.toLowerCase() === "local";
}

function extractConnectionFields(source: JsonObject | null): JsonObject | null {
  if (!source) return null;
  const connection: JsonObject = {};
  for (const field of CONNECTION_FIELDS) {
    if (hasOwn(source, field)) connection[field] = structuredClone(source[field]);
  }
  return Object.keys(connection).length > 0 ? connection : null;
}

function withoutConnectionFields(source: JsonObject | null): JsonObject {
  if (!source) return {};
  const result = structuredClone(source);
  for (const field of CONNECTION_FIELDS) delete result[field];
  return result;
}

function resolvedEmbeddingMode(
  view: LegacyMemoryView,
  legacyByokEmbedding: JsonObject | null,
): EmbeddingMode {
  const explicit = embeddingModeValue(view.rootEmbedding);
  if (explicit) return explicit;
  if (view.activeProfile === "account") return "cloud";
  return isLocalEmbedding(legacyByokEmbedding) ? "local" : "custom";
}

function mergeEmbedding(view: LegacyMemoryView): JsonObject {
  const profileEmbedding = embeddingFromProfile(
    view.byokProfile,
    "memmyMemory.profiles.byok",
  );
  const legacyByokEmbedding = profileEmbedding ?? view.rootEmbedding;
  const root = {
    ...(profileEmbedding ? withoutConnectionFields(profileEmbedding) : {}),
    ...withoutConnectionFields(view.rootEmbedding),
  };
  const explicitCustom = optionalObject(root, "custom", "memmyMemory.embedding.custom");
  const legacyCustom = isLocalEmbedding(legacyByokEmbedding)
    ? null
    : extractConnectionFields(legacyByokEmbedding);
  const custom =
    explicitCustom || legacyCustom
      ? {
          ...(legacyCustom ?? {}),
          ...(explicitCustom ? structuredClone(explicitCustom) : {}),
        }
      : null;

  const embedding: JsonObject = {
    ...root,
    mode: resolvedEmbeddingMode(view, legacyByokEmbedding),
  };
  if (custom) embedding.custom = custom;
  else delete embedding.custom;
  return embedding;
}

function validAccountProjection(config: JsonObject): boolean {
  const providers = optionalObject(config, "providers", "providers");
  const accountProvider = providers
    ? optionalObject(providers, "memmy_account", "providers.memmy_account")
    : null;
  const app = optionalObject(config, "app", "app");
  const credential =
    optionalString(accountProvider, "apiKey", "providers.memmy_account.apiKey") ??
    optionalString(app, "cloudUuid", "app.cloudUuid");
  if (!credential) return false;

  const presets = optionalObject(config, "modelPresets", "modelPresets");
  const accountPreset = presets
    ? optionalObject(presets, "memmy-account", "modelPresets.memmy-account")
    : null;
  const agents = optionalObject(config, "agents", "agents");
  const defaults = agents ? optionalObject(agents, "defaults", "agents.defaults") : null;

  const presetMatches =
    optionalString(accountPreset, "provider", "modelPresets.memmy-account.provider") ===
      "memmy_account" &&
    optionalString(accountPreset, "model", "modelPresets.memmy-account.model") === "agent_chat";
  const defaultsMatch =
    optionalString(defaults, "provider", "agents.defaults.provider") === "memmy_account" &&
    optionalString(defaults, "model", "agents.defaults.model") === "agent_chat";
  return presetMatches || defaultsMatch;
}

function migrateUserIds(
  config: JsonObject,
  memmyMemory: JsonObject,
  view: LegacyMemoryView,
): void {
  const byokUserId = optionalString(
    view.byokProfile,
    "userId",
    "memmyMemory.profiles.byok.userId",
  );
  const rootUserId = optionalString(memmyMemory, "userId", "memmyMemory.userId");
  memmyMemory.userId = byokUserId ?? rootUserId ?? "local-user";

  let app = optionalObject(config, "app", "app");
  const existingAccountUserId = optionalString(app, "userId", "app.userId");
  if (existingAccountUserId || !validAccountProjection(config)) return;
  const accountUserId = optionalString(
    view.accountProfile,
    "userId",
    "memmyMemory.profiles.account.userId",
  );
  if (!accountUserId) return;
  app = app ? structuredClone(app) : {};
  app.userId = accountUserId;
  config.app = app;
}

function migrateConfig(config: JsonObject): { changed: boolean; config: JsonObject } {
  const view = readLegacyMemoryView(config);
  if (!view || !view.hasLegacyShape) return { changed: false, config };

  const migrated = structuredClone(config);
  const memmyMemory = optionalObject(migrated, "memmyMemory", "memmyMemory");
  if (!memmyMemory) return { changed: false, config };
  const migratedView = readLegacyMemoryView(migrated);
  if (!migratedView) return { changed: false, config };
  const agentConnection = resolveAgentModelConnection(migrated);

  memmyMemory.roleRouting = {
    ...(migratedView.roleRouting ? structuredClone(migratedView.roleRouting) : {}),
    summary: resolvedRoleRouting(migratedView, "summary", agentConnection),
    evolution: resolvedRoleRouting(migratedView, "evolution", agentConnection),
  };

  const summary = fixedRoleConfig(migratedView, "summary");
  const evolution = fixedRoleConfig(migratedView, "evolution");
  if (summary) memmyMemory.summary = structuredClone(summary);
  if (evolution) memmyMemory.evolution = structuredClone(evolution);
  memmyMemory.embedding = mergeEmbedding(migratedView);
  migrateUserIds(migrated, memmyMemory, migratedView);
  delete memmyMemory.activeProfile;
  delete memmyMemory.profiles;
  return { changed: true, config: migrated };
}

export function flattenLegacyMemoryModelConfig(config: RuntimeConfigDocument): void {
  const result = migrateConfig(config);
  if (!result.changed) return;
  for (const key of Object.keys(config)) delete config[key];
  Object.assign(config, result.config);
}
