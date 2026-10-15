import { createHash } from "node:crypto";
import { isPlatformMemoryConnection, record } from "../../platform-memory-connection.js";
import { mutateRuntimeConfig, mutateRuntimeConfigLockHeld, type RuntimeConfigDocument } from "../../runtime-config-writer.js";
import type { MigrationDefinition } from "../../types.js";

const FIELDS: Readonly<Record<string, string>> = {
  memory_summary: "memorySummary", memory_evolution: "memoryEvolution", embedding: "embedding",
};

/** Preserve user-created/edited presets; only remove the original migration's exact shape. */
function duplicateCapability(config: RuntimeConfigDocument, id: string, preset: RuntimeConfigDocument): string | null {
  if (preset.source !== "byok" || preset.provider !== "openai") return null;
  if (Object.keys(preset).some((key) => !["provider", "endpoint", "model", "source", "capabilities"].includes(key))) return null;
  const capability = String(preset.model);
  if (!FIELDS[capability] || !Array.isArray(preset.capabilities)
    || preset.capabilities.length !== 1 || preset.capabilities[0] !== capability) return null;
  const endpointId = String(preset.endpoint);
  const identity = JSON.stringify({ endpointId, model: preset.model, providerId: "openai" });
  const hash = createHash("sha256").update(identity).digest("hex").slice(0, 8);
  const expected = `byok-openai-${capability.replaceAll("_", "-")}-${hash}`;
  const runtimeHash = createHash("sha256").update(`openai\0${endpointId}\0${preset.model}`).digest("hex").slice(0, 16);
  if (id !== expected && id !== `memmy-memory-${runtimeHash}`) return null;
  const provider = record(record(config.providers).openai);
  const endpoint = record(record(provider.endpoints)[endpointId]);
  if (endpoint.protocol !== (capability === "embedding" ? "openai-embeddings" : "openai-chat-completions")) return null;
  if (Object.keys(endpoint).some((key) => !["apiBase", "protocol", "apiKey", "extraHeaders", "extraBody"].includes(key))) return null;
  return isPlatformMemoryConnection(config, capability, {
    provider: "openai", model: preset.model, apiBase: endpoint.apiBase,
    apiKey: endpoint.apiKey ?? provider.apiKey,
    extraHeaders: endpoint.extraHeaders ?? provider.extraHeaders,
    extraBody: endpoint.extraBody ?? provider.extraBody,
  }) ? capability : null;
}

function removeDuplicates(config: RuntimeConfigDocument): void {
  const presets = record(config.modelPresets);
  const removed = new Map<string, string>();
  const endpointsToCheck = new Set<string>();
  for (const [id, raw] of Object.entries(presets)) {
    const preset = record(raw);
    const capability = duplicateCapability(config, id, preset);
    if (!capability) continue;
    removed.set(id, capability);
    endpointsToCheck.add(String(preset.endpoint));
    delete presets[id];
  }
  if (!removed.size) return;
  const assignments = record(config.modelAssignments);
  for (const mode of ["account", "byok"]) {
    const assignment = record(assignments[mode]);
    for (const [id, capability] of removed) {
      const field = FIELDS[capability]!;
      if (assignment[field] !== id) continue;
      const replacement = mode === "account" ? Object.entries(presets).find(([, raw]) => {
        const preset = record(raw);
        return preset.source === "account" && preset.provider === "memmy_account"
          && preset.ownerAccountId === assignment.ownerAccountId
          && preset.model === capability && Array.isArray(preset.capabilities)
          && preset.capabilities.includes(capability);
      })?.[0] : null;
      assignment[field] = replacement ?? null;
    }
  }
  const providers = record(config.providers);
  const provider = record(providers.openai);
  const endpoints = record(provider.endpoints);
  for (const endpointId of endpointsToCheck) {
    if (!Object.values(presets).some((raw) => {
      const preset = record(raw);
      return preset.provider === "openai" && preset.endpoint === endpointId;
    })) delete endpoints[endpointId];
  }
  if (!Object.keys(endpoints).length && Object.keys(provider).every((key) => ["apiKey", "endpoints"].includes(key))) {
    delete providers.openai;
  }
}

export const removePlatformMemoryDuplicatesV124: MigrationDefinition = {
  id: "v1.2.4/0001-remove-platform-memory-duplicates",
  introducedIn: "1.2.4",
  scope: "runtime-config",
  description: "Remove migration-generated copies of platform Memory models from the BYOK catalog",
  async up(context) {
    const options = { createIfMissing: false as const };
    const result = context.runtimeConfigLock
      ? await mutateRuntimeConfigLockHeld(context.runtimeConfigLock, removeDuplicates, options)
      : await mutateRuntimeConfig(context.runtimeConfigFile, removeDuplicates, options);
    if (!result.sourceExists) return { scanned: 0, changed: 0, ignored: 0, deferred: true };
    return { scanned: 1, changed: result.changed ? 1 : 0, ignored: result.changed ? 0 : 1 };
  },
};
