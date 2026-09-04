import { createHash } from "node:crypto";

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
  const touchedRouting = Object.prototype.hasOwnProperty.call(patch, "roleRouting");

  if (touchedRouting || Object.prototype.hasOwnProperty.call(patch, "evolution")) {
    syncMemoryRole("evolution", "memoryEvolution", "memory_evolution");
  }
  if (touchedRouting || Object.prototype.hasOwnProperty.call(patch, "summary")) {
    syncMemoryRole("summary", "memorySummary", "memory_summary");
  }
  if (Object.prototype.hasOwnProperty.call(patch, "embedding")) {
    const embedding = record(memory.embedding);
    if (embedding.mode === "custom") {
      const presetId = upsertMemoryCatalogPreset(root, embedding, "embedding");
      if (presetId) assignment.embedding = presetId;
    } else if (embedding.mode === "local") {
      assignment.embedding = null;
    }
  }

  assignments[mode] = assignment;
  root.modelAssignments = assignments;

  function syncMemoryRole(
    role: "summary" | "evolution",
    assignmentKey: "memorySummary" | "memoryEvolution",
    capability: "memory_summary" | "memory_evolution"
  ): void {
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
  const apiBase = stringValue(connection.endpoint)?.replace(/\/+$/, "");
  const model = stringValue(connection.model);
  if (!apiBase || !model) return undefined;

  const providerId = catalogProviderId(connection);
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

function catalogProviderId(connection: Record<string, unknown>): string {
  const source = stringValue(connection.sourceProvider) ?? stringValue(connection.provider) ?? "openai";
  const aliases: Record<string, string> = {
    openai_compatible: "openai",
    google: "gemini",
    qwen: "dashscope",
    kimi: "moonshot",
    baidu: "qianfan",
    doubao: "volcengine"
  };
  const provider = aliases[source] ?? source;
  return [
    "openai", "anthropic", "gemini", "deepseek", "zhipu", "dashscope",
    "moonshot", "minimax", "qianfan", "volcengine"
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
