import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  ModelEndpointProtocolSchema,
  resolveAssignedModel,
  type ActualModelContext,
  type CommittedModelSelection,
  type ModelCapability,
  type ModelEndpointProtocol,
  type ResolveAssignedModelInput,
  type ResolvedProviderSnapshot,
  type RuntimeModelCatalog,
  type UserMode,
} from "@memmy/local-api-contracts";
import YAML from "yaml";
import { getConfigPath, loadConfig, resolveConfigEnvVars } from "../config/loader.js";
import type { Config } from "../config/schema.js";
import { buildProviderSnapshot, type ProviderSnapshot } from "./factory.js";

export type { ActualModelContext, CommittedModelSelection } from "@memmy/local-api-contracts";
export type ModelSelectionMode = Extract<UserMode, "account" | "byok">;

export type ModelSelectionInput = {
  configPath?: string | null;
  mode?: ModelSelectionMode;
  activeAccountId?: string | null;
  capability?: ModelCapability;
  requestedPreset?: string | null;
  committedSelection?: CommittedModelSelection | null;
  /** Compatibility input while legacy sessions are upgraded to committedSelection. */
  sessionPreset?: string | null;
};

export type ModelCatalogItem = ActualModelContext & {
  preset: string;
  isDefault: boolean;
  available: boolean;
};

export type ModelCatalog = {
  items: ModelCatalogItem[];
  defaultPreset: string | null;
  fingerprint: string;
};

export type ResolvedModelSelection = Readonly<ActualModelContext & {
  /** Compatibility alias for existing Agent callers. */
  preset: string;
  snapshot: ProviderSnapshot;
  providerConfig: Readonly<ResolvedProviderSnapshot>;
}>;

export function readModelCatalog(
  configPath: string | null = null,
  input: Pick<ModelSelectionInput, "mode" | "activeAccountId" | "capability"> = {},
): ModelCatalog {
  const config = resolveConfigEnvVars(loadConfig(configPath));
  const scope = runtimeScope(config, input);
  const presetIds = assignedPresetIds(config, scope.mode, scope.capability);
  const defaultResolution = resolveAssignedModel({
    catalog: runtimeCatalog(config),
    ...scope,
  });
  const defaultPreset = defaultResolution.ok ? defaultResolution.context.presetId : null;
  const items = presetIds.flatMap((presetId): ModelCatalogItem[] => {
    const resolution = resolveAssignedModel({
      catalog: runtimeCatalog(config),
      ...scope,
      requestedPreset: presetId,
    });
    return resolution.ok ? [{
      ...resolution.context,
      preset: resolution.context.presetId,
      isDefault: resolution.context.presetId === defaultPreset,
      available: true,
    }] : [];
  });
  return {
    items,
    defaultPreset,
    fingerprint: modelCatalogFingerprint(configPath),
  };
}

export function resolveModelSelection(input: ModelSelectionInput): ResolvedModelSelection | null {
  const config = resolveConfigEnvVars(loadConfig(input.configPath ?? null));
  const scope = runtimeScope(config, input);
  const committedSelection = input.committedSelection
    ?? legacyCommittedSelection(config, input.sessionPreset);
  if (input.sessionPreset && !input.committedSelection && !committedSelection) return null;
  const sharedInput: ResolveAssignedModelInput = {
    catalog: runtimeCatalog(config),
    ...scope,
    ...(Object.prototype.hasOwnProperty.call(input, "requestedPreset")
      ? { requestedPreset: input.requestedPreset }
      : {}),
    ...(committedSelection ? { committedSelection } : {}),
  };
  const resolution = resolveAssignedModel(sharedInput);
  if (!resolution.ok) return null;

  try {
    const snapshot = buildProviderSnapshot(config, {
      presetName: resolution.context.presetId,
      validateCredentials: false,
    });
    return Object.freeze({
      ...resolution.context,
      preset: resolution.context.presetId,
      snapshot,
      providerConfig: resolution.provider,
    });
  } catch {
    return null;
  }
}

export function modelSelectionWire(
  selection: unknown,
): {
  preset_id: string;
  provider: string;
  endpoint_id: string;
  protocol: ModelEndpointProtocol;
  model: string;
  source: ActualModelContext["source"];
  owner_account_id: string | null;
  capabilities: readonly ModelCapability[];
} | null {
  if (!isRecord(selection)) return null;
  if (
    typeof selection.presetId !== "string"
    || typeof selection.provider !== "string"
    || typeof selection.endpointId !== "string"
    || typeof selection.protocol !== "string"
    || typeof selection.model !== "string"
    || (selection.source !== "account" && selection.source !== "byok")
    || (selection.ownerAccountId !== null && typeof selection.ownerAccountId !== "string")
    || !Array.isArray(selection.capabilities)
    || selection.capabilities.some((capability) => typeof capability !== "string")
  ) return null;
  return Object.freeze({
    preset_id: selection.presetId,
    provider: selection.provider,
    endpoint_id: selection.endpointId,
    protocol: selection.protocol as ModelEndpointProtocol,
    model: selection.model,
    source: selection.source,
    owner_account_id: selection.ownerAccountId ?? null,
    capabilities: Object.freeze([...selection.capabilities]) as readonly ModelCapability[],
  });
}

export function persistedModelSelection(
  selection: ActualModelContext,
): ActualModelContext {
  return Object.freeze({
    presetId: selection.presetId,
    provider: selection.provider,
    endpointId: selection.endpointId,
    protocol: selection.protocol,
    model: selection.model,
    source: selection.source,
    ownerAccountId: selection.ownerAccountId ?? null,
    capability: selection.capability,
    capabilities: Object.freeze([...selection.capabilities]),
  });
}

export function committedSelectionFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): CommittedModelSelection | null {
  const value = metadata?.modelSelection;
  if (!isRecord(value)) return null;
  if (typeof value.presetId !== "string" || !value.presetId.trim()) return null;
  if (typeof value.provider !== "string" || !value.provider.trim()) return null;
  if (typeof value.endpointId !== "string" || !value.endpointId.trim()) return null;
  if (typeof value.model !== "string" || !value.model.trim()) return null;
  const protocol = ModelEndpointProtocolSchema.safeParse(value.protocol);
  if (!protocol.success) return null;
  if (value.source !== "account" && value.source !== "byok") return null;
  if (value.ownerAccountId !== null && typeof value.ownerAccountId !== "string") return null;
  return {
    presetId: value.presetId,
    provider: value.provider,
    endpointId: value.endpointId,
    protocol: protocol.data,
    model: value.model,
    source: value.source,
    ownerAccountId: value.ownerAccountId,
  };
}

export function modelCatalogFingerprint(configPath: string | null = null): string {
  const target = path.resolve(configPath ?? getConfigPath());
  let parsed: unknown = {};
  try {
    const content = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
    parsed = content.trim() ? YAML.parse(content) : {};
  } catch {
    return "invalid";
  }
  const config = record(parsed);
  const app = record(config.app);
  const fragment = {
    providers: config.providers ?? null,
    modelPresets: config.modelPresets ?? null,
    modelAssignments: config.modelAssignments ?? null,
    app: {
      userMode: app.userMode ?? null,
      userId: app.userId ?? null,
    },
  };
  return createHash("sha256").update(stableJson(fragment)).digest("hex");
}

function runtimeScope(
  config: Config,
  input: Pick<ModelSelectionInput, "mode" | "activeAccountId" | "capability">,
): Pick<ResolveAssignedModelInput, "mode" | "activeAccountId" | "capability"> {
  return {
    mode: input.mode ?? (config.app.userMode === "account" ? "account" : "byok"),
    activeAccountId: input.activeAccountId ?? optionalString(config.app.userId),
    capability: input.capability ?? "agent",
  };
}

function runtimeCatalog(config: Config): RuntimeModelCatalog {
  const providerIds = new Set(Object.values(config.modelPresets).map((preset) => preset.provider));
  return {
    providers: Object.fromEntries([...providerIds].map((providerId) => {
      const provider = config.providers[providerId] as any;
      return [providerId, omitNullish({
        apiKey: provider?.apiKey,
        ownerAccountId: provider?.ownerAccountId,
        extraHeaders: provider?.extraHeaders,
        extraBody: provider?.extraBody,
        endpoints: Object.fromEntries((Object.entries(provider?.endpoints ?? {}) as Array<[string, any]>).map(([endpointId, endpoint]) => [
          endpointId,
          omitNullish({
            apiBase: endpoint.apiBase,
            protocol: endpoint.protocol,
            apiKey: endpoint.apiKey,
            extraHeaders: endpoint.extraHeaders,
            extraBody: endpoint.extraBody,
          }),
        ])),
      })];
    })),
    modelPresets: Object.fromEntries(Object.entries(config.modelPresets).map(([presetId, preset]) => [
      presetId,
      omitNullish({
        provider: preset.provider,
        endpoint: preset.endpoint,
        model: preset.model,
        source: preset.source,
        ownerAccountId: preset.ownerAccountId,
        capabilities: [...preset.capabilities],
      }),
    ])),
    modelAssignments: {
      byok: runtimeAssignment(config.modelAssignments.byok),
      account: runtimeAssignment(config.modelAssignments.account),
    },
  } as unknown as RuntimeModelCatalog;
}

function runtimeAssignment(assignment: Config["modelAssignments"]["byok"]): Record<string, unknown> {
  return omitNullish({
    ownerAccountId: assignment.ownerAccountId,
    agent: {
      candidates: [...assignment.agent.candidates],
      default: assignment.agent.default,
    },
    memorySummary: assignment.memorySummary,
    memoryEvolution: assignment.memoryEvolution,
    embedding: assignment.embedding,
    asr: assignment.asr,
    imageGeneration: assignment.imageGeneration,
  });
}

function omitNullish<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined));
}

function assignedPresetIds(
  config: Config,
  mode: ModelSelectionMode,
  capability: ModelCapability,
): string[] {
  const assignment = config.modelAssignments[mode];
  if (capability === "agent") return [...assignment.agent.candidates];
  const presetId = capability === "memory_summary"
    ? assignment.memorySummary
    : capability === "memory_evolution"
      ? assignment.memoryEvolution
      : capability === "embedding"
        ? assignment.embedding
        : capability === "asr"
          ? assignment.asr
          : assignment.imageGeneration;
  return presetId ? [presetId] : [];
}

function legacyCommittedSelection(
  config: Config,
  sessionPreset: string | null | undefined,
): CommittedModelSelection | null {
  if (!sessionPreset) return null;
  const preset = config.modelPresets[sessionPreset];
  if (!preset || preset.source !== "byok") return null;
  return {
    presetId: sessionPreset,
    source: "byok",
    ownerAccountId: null,
  };
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
