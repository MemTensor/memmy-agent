import { createHash } from "node:crypto";
import { BUILTIN_LOCAL_EMBEDDING_ASSIGNMENT_ID } from "../contracts/index.js";
import { resolveAssignedModel, type RuntimeModelCatalog } from "../contracts/model-catalog-resolver.js";

export function syncMemoryModelCatalog(
  root: Record<string, unknown>,
  memory: Record<string, unknown>,
  patch: Record<string, unknown>
): void {
  const touchesModels = ["roleRouting", "summary", "evolution", "embedding"]
    .some((key) => Object.prototype.hasOwnProperty.call(patch, key));
  if (!touchesModels) return;
  const mode = record(root.app).userMode === "account" ? "account" : "byok";
  const assignments = { ...record(root.modelAssignments) };
  const assignment = { ...record(assignments[mode]) };
  const routing = record(memory.roleRouting);
  if (mode === "account") {
    // Platform accounts expose dedicated summary and evolution models.
    routing.summary = "fixed";
    routing.evolution = "fixed";
  }
  const touchedRouting = Object.prototype.hasOwnProperty.call(patch, "roleRouting");

  const touchedEvolution = Object.prototype.hasOwnProperty.call(patch, "evolution");
  if (touchedRouting || touchedEvolution) {
    syncMemoryRole("evolution", "memoryEvolution", "memory_evolution");
  }
  // A following summary inherits evolution. Refresh its catalog assignment
  // when only the evolution connection changes through the legacy API.
  if (touchedRouting || Object.prototype.hasOwnProperty.call(patch, "summary")
    || (touchedEvolution && routing.summary !== "fixed")) {
    syncMemoryRole("summary", "memorySummary", "memory_summary");
  }
  if (Object.prototype.hasOwnProperty.call(patch, "embedding")) {
    const embedding = record(memory.embedding);
    if (embedding.mode === "custom") {
      const presetId = upsertMemoryCatalogPreset(root, embedding, "embedding");
      if (presetId) assignment.embedding = presetId;
    } else if (embedding.mode === "local") {
      // Account mode uses null for an unavailable selection, not the local model.
      assignment.embedding = mode === "account" ? BUILTIN_LOCAL_EMBEDDING_ASSIGNMENT_ID : null;
      if (mode === "account" && stringValue(record(root.app).userId)) {
        assignment.ownerAccountId = stringValue(record(root.app).userId);
      }
    } else if (embedding.mode === "cloud" && mode === "account") {
      const owner = stringValue(record(root.app).userId);
      assignment.embedding = Object.entries(record(root.modelPresets)).find(([, value]) => {
        const preset = record(value);
        return owner && preset.source === "account" && preset.ownerAccountId === owner
          && Array.isArray(preset.capabilities) && preset.capabilities.includes("embedding");
      })?.[0] ?? null;
    }
  }

  assignments[mode] = assignment;
  root.modelAssignments = assignments;

  function syncMemoryRole(
    role: "summary" | "evolution",
    assignmentKey: "memorySummary" | "memoryEvolution",
    capability: "memory_summary" | "memory_evolution"
  ): void {
    if (mode === "account" && role === "summary") return;
    if (routing[role] !== "fixed") {
      const agent = record(assignment.agent);
      assignment[assignmentKey] = role === "evolution"
        ? stringValue(agent.default) ?? null
        : stringValue(assignment.memoryEvolution) ?? stringValue(agent.default) ?? null;
      return;
    }
    const presetId = upsertMemoryCatalogPreset(root, record(memory[role]), capability);
    if (presetId) assignment[assignmentKey] = presetId;
  }
}

function upsertMemoryCatalogPreset(
  root: Record<string, unknown>,
  connection: Record<string, unknown>,
  capability: "memory_summary" | "memory_evolution" | "embedding"
): string | undefined {
  const platformSource = connection.sourceProvider === "memmy_account" || connection.provider === "memmy_account";
  // A form can retain its source marker after editing the actual connection.
  // Request options do not change platform identity; address/model/credentials do.
  if (platformSource && matchesPlatformCatalog(root, connection, capability)) return undefined;
  const apiBase = stringValue(connection.endpoint)?.replace(/\/+$/, "");
  const model = stringValue(connection.model);
  if (!apiBase || !model) return undefined;

  const providerId = catalogProviderId(platformSource ? {
    ...connection,
    sourceProvider: undefined,
    provider: connection.provider === "memmy_account" ? "openai_compatible" : connection.provider,
  } : connection);
  if (platformSource) {
    connection.sourceProvider = providerId;
    if (connection.provider === "memmy_account") connection.provider = "openai_compatible";
    delete connection.actualModelContext;
    delete connection.selectionError;
  }
  const protocol = capability === "embedding"
    ? "openai-embeddings"
    : providerId === "anthropic"
      ? "anthropic-messages"
      : providerId === "gemini"
        ? "gemini-generate-content"
        : "openai-chat-completions";
  const providers = { ...record(root.providers) };
  const provider = { ...record(providers[providerId]) };
  const endpoints = { ...record(provider.endpoints) };
  const apiKey = stringValue(connection.apiKey);
  const extraHeaders = record(connection.extraHeaders);
  const extraBody = record(connection.extraBody);
  let endpointId = Object.entries(endpoints).find(([, value]) => {
    const endpoint = record(value);
    return stringValue(endpoint.apiBase)?.replace(/\/+$/, "") === apiBase
      && endpoint.protocol === protocol
      && (stringValue(endpoint.apiKey) ?? stringValue(provider.apiKey)) === apiKey
      && stableJson(record(endpoint.extraHeaders)) === stableJson(extraHeaders)
      && stableJson(record(endpoint.extraBody)) === stableJson(extraBody);
  })?.[0];
  if (!endpointId) {
    endpointId = uniqueCatalogId(
      `memmy-memory-${shortHash(`${providerId}\0${protocol}\0${apiBase}\0${apiKey ?? ""}\0${stableJson(extraHeaders)}\0${stableJson(extraBody)}`)}`,
      endpoints
    );
    endpoints[endpointId] = {
      apiBase,
      protocol,
      ...(apiKey ? { apiKey } : {}),
      ...(Object.keys(extraHeaders).length ? { extraHeaders } : {}),
      ...(Object.keys(extraBody).length ? { extraBody } : {})
    };
  }
  provider.endpoints = endpoints;
  providers[providerId] = provider;
  root.providers = providers;

  const presets = { ...record(root.modelPresets) };
  let presetId = Object.entries(presets).find(([, value]) => {
    const preset = record(value);
    return preset.source === "byok"
      && preset.provider === providerId
      && preset.endpoint === endpointId
      && preset.model === model;
  })?.[0];
  if (!presetId) {
    presetId = uniqueCatalogId(
      `memmy-memory-${shortHash(`${providerId}\0${endpointId}\0${model}`)}`,
      presets
    );
    presets[presetId] = {
      provider: providerId,
      endpoint: endpointId,
      model,
      source: "byok",
      capabilities: [capability]
    };
  } else {
    const preset = { ...record(presets[presetId]) };
    const capabilities = Array.isArray(preset.capabilities)
      ? preset.capabilities.filter((value): value is string => typeof value === "string")
      : [];
    preset.capabilities = [...new Set([...capabilities, capability])];
    presets[presetId] = preset;
  }
  root.modelPresets = presets;
  return presetId;
}

function matchesPlatformCatalog(
  root: Record<string, unknown>,
  connection: Record<string, unknown>,
  capability: "memory_summary" | "memory_evolution" | "embedding"
): boolean {
  if (!["memmy_account", "openai_compatible", "openai"].includes(String(connection.provider))) return false;
  const activeAccountId = stringValue(record(root.app).userId);
  const field = { memory_summary: "memorySummary", memory_evolution: "memoryEvolution", embedding: "embedding" }[capability];
  // Startup can project a platform connection while the user's selection is
  // BYOK. Validate the platform entries independently without changing that
  // selection; the shared resolver still enforces account ownership/protocol.
  return Object.entries(record(root.modelPresets)).some(([id, raw]) => {
    const preset = record(raw);
    if (preset.source !== "account" || preset.provider !== "memmy_account") return false;
    const platform = resolveAssignedModel({
      catalog: {
        ...root,
        modelAssignments: { account: { ownerAccountId: activeAccountId, [field]: id } },
      } as RuntimeModelCatalog,
      mode: "account",
      activeAccountId,
      capability,
    });
    return platform.ok
      && stringValue(connection.endpoint)?.replace(/\/+$/, "") === platform.provider.apiBase.replace(/\/+$/, "")
      && stringValue(connection.model) === platform.context.model
      && stringValue(connection.apiKey) === stringValue(platform.provider.apiKey);
  });
}

function catalogProviderId(connection: Record<string, unknown>): string {
  const source = stringValue(connection.sourceProvider) ?? stringValue(connection.provider) ?? "openai";
  const aliases: Record<string, string> = {
    openai_compatible: "openai",
    google: "gemini",
    qwen: "dashscope",
    kimi: "moonshot",
    baidu: "qianfan",
    doubao: "volcengine",
    xiaomi: "xiaomi_mimo"
  };
  const provider = aliases[source] ?? source;
  return [
    "openai", "anthropic", "gemini", "deepseek", "zhipu", "dashscope",
    "moonshot", "minimax", "qianfan", "volcengine", "stepfun", "xiaomi_mimo",
    "custom"
  ].includes(provider) ? provider : "openai";
}

function uniqueCatalogId(base: string, values: Record<string, unknown>): string {
  if (!(base in values)) return base;
  let suffix = 2;
  while (`${base}-${suffix}` in values) suffix += 1;
  return `${base}-${suffix}`;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
