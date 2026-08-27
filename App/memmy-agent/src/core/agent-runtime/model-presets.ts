import { AgentDefaults, Config, ModelPresetConfig } from "../../config/schema.js";
import { buildProviderSnapshot } from "../../providers/factory.js";

export function defaultSelectionSignature(signature: any[] | null | undefined): any[] | null {
  return Array.isArray(signature) ? signature.slice(0, 2) : null;
}

export function configuredModelPresets(config: Config): Record<string, ModelPresetConfig> {
  return {
    ...(config.modelPresets as Record<string, ModelPresetConfig>),
    default: config.resolvePreset("default"),
  };
}

export function normalizePresetName(name: string | null | undefined, presets: Record<string, ModelPresetConfig>): string {
  if (typeof name !== "string" || !name.trim()) throw new Error("modelPreset must be a non-empty string");
  const trimmed = name.trim();
  if (!(trimmed in presets)) {
    throw new Error(`modelPreset '${trimmed}' not found. Available: ${Object.keys(presets).join(", ") || "(none)"}`);
  }
  return trimmed;
}

export function buildStaticPresetSnapshot(defaults: AgentDefaults): Record<string, any> {
  return {
    model: defaults.model,
    provider: defaults.provider,
    maxTokens: defaults.maxTokens,
    temperature: defaults.temperature,
    reasoningEffort: defaults.reasoningEffort,
  };
}

export function buildRuntimePresetSnapshot(config: Config): Record<string, any> {
  return buildStaticPresetSnapshot(config.agents.defaults);
}

export function makePresetSnapshotLoader(
  config: Config,
  providerSnapshotLoader: ((opts?: any) => Record<string, any>) | null = null,
): (name: string) => Record<string, any> {
  if (providerSnapshotLoader) {
    return (name: string) => providerSnapshotLoader({ presetName: name });
  }
  return (name: string) => buildProviderSnapshot(config, { presetName: name });
}
