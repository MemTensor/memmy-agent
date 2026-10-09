import type {
    ModelCapability,
    ModelEndpointProtocol,
    ModelSource,
    UserMode
} from "./index.js";

export interface RuntimeCatalogEndpoint {
    apiBase: string;
    protocol: ModelEndpointProtocol;
    apiKey?: string;
    extraHeaders?: Record<string, string>;
    extraBody?: Record<string, unknown>;
}

export const BUILTIN_LOCAL_EMBEDDING_ASSIGNMENT_ID = "memmy-builtin-local-embedding";

export interface RuntimeCatalogProvider {
    apiKey?: string;
    extraHeaders?: Record<string, string>;
    extraBody?: Record<string, unknown>;
    ownerAccountId?: string;
    endpoints?: Record<string, RuntimeCatalogEndpoint>;
}

export interface RuntimeCatalogPreset {
    provider: string;
    endpoint: string;
    model: string;
    source: ModelSource;
    ownerAccountId?: string;
    capabilities: ModelCapability[];
}

export interface RuntimeModelAssignment {
    ownerAccountId?: string;
    agent?: {
        candidates?: string[];
        default?: string | null;
    };
    memorySummary?: string | null;
    memoryEvolution?: string | null;
    embedding?: string | null;
    asr?: string | null;
    imageGeneration?: string | null;
}

export interface RuntimeModelCatalog {
    providers?: Record<string, RuntimeCatalogProvider>;
    modelPresets?: Record<string, RuntimeCatalogPreset>;
    modelAssignments?: {
        byok?: RuntimeModelAssignment;
        account?: RuntimeModelAssignment;
    };
}

export interface CommittedModelSelection {
    presetId: string;
    provider?: string;
    endpointId?: string;
    protocol?: ModelEndpointProtocol;
    model?: string;
    source: ModelSource;
    ownerAccountId: string | null;
}

export interface ActualModelContext {
    presetId: string;
    provider: string;
    endpointId: string;
    protocol: ModelEndpointProtocol;
    model: string;
    source: ModelSource;
    ownerAccountId: string | null;
    capability: ModelCapability;
    capabilities: readonly ModelCapability[];
}

export interface ResolvedProviderSnapshot {
    provider: string;
    endpointId: string;
    protocol: ModelEndpointProtocol;
    apiBase: string;
    apiKey?: string;
    ownerAccountId?: string;
    extraHeaders: Readonly<Record<string, string>>;
    extraBody: Readonly<Record<string, unknown>>;
}

export interface ResolveAssignedModelInput {
    catalog: RuntimeModelCatalog;
    mode: Extract<UserMode, "account" | "byok">;
    activeAccountId?: string | null;
    capability: ModelCapability;
    requestedPreset?: string | null;
    committedSelection?: CommittedModelSelection | null;
}

export type ModelSelectionResolution =
    | {
        ok: true;
        context: Readonly<ActualModelContext>;
        provider: Readonly<ResolvedProviderSnapshot>;
    }
    | {
        ok: false;
        code: "model_selection_unavailable";
    };

const UNAVAILABLE: ModelSelectionResolution = Object.freeze({
    ok: false,
    code: "model_selection_unavailable"
});

const CAPABILITIES = new Set<ModelCapability>([
    "agent", "memory_summary", "memory_evolution", "embedding", "asr", "image_generation"
]);
const PROTOCOLS = new Set<ModelEndpointProtocol>([
    "openai-chat-completions", "openai-responses", "anthropic-messages",
    "gemini-generate-content", "openai-embeddings", "dashscope-input-audio-chat",
    "openai-images", "dashscope-multimodal-generation", "memmy-account"
]);

/** Resolves one immutable current-catalog model assignment without guessing another preset or endpoint. */
export function resolveAssignedModel(input: ResolveAssignedModelInput): ModelSelectionResolution {
    const assignment = input.catalog.modelAssignments?.[input.mode];
    if (!isRuntimeAssignment(assignment) || !assignmentOwnerMatches(input.mode, assignment, input.activeAccountId)) {
        return UNAVAILABLE;
    }

    const selectedPreset = selectedPresetForInput(input, assignment);
    if (!selectedPreset) return UNAVAILABLE;
    if (input.requestedPreset !== undefined && !assignmentIncludes(assignment, input.capability, selectedPreset)) {
        return UNAVAILABLE;
    }

    const preset = input.catalog.modelPresets?.[selectedPreset];
    if (!isRuntimePreset(preset) || !preset.capabilities.includes(input.capability)) return UNAVAILABLE;
    if (!sourceAllowed(input.mode, preset.source)) return UNAVAILABLE;
    if (!presetOwnerMatches(preset, input.activeAccountId)) return UNAVAILABLE;
    if (
        input.requestedPreset === undefined
        && !committedSelectionMatches(input.committedSelection, selectedPreset, preset)
    ) return UNAVAILABLE;

    const provider = input.catalog.providers?.[preset.provider];
    const endpoint = isRuntimeProvider(provider) ? provider.endpoints?.[preset.endpoint] : undefined;
    if (!isRuntimeProvider(provider) || !isRuntimeEndpoint(endpoint)) return UNAVAILABLE;
    if (!preset.capabilities.every((capability) => protocolSupportsCapability(endpoint.protocol, capability))) {
        return UNAVAILABLE;
    }
    if (!providerOwnerMatches(preset, provider, input.activeAccountId)) return UNAVAILABLE;

    let extraBody: Readonly<Record<string, unknown>>;
    try {
        extraBody = deepFreeze(structuredClone({
            ...(provider.extraBody ?? {}),
            ...(endpoint.extraBody ?? {})
        }));
    } catch {
        return UNAVAILABLE;
    }

    const capabilities = Object.freeze([...preset.capabilities]);
    const context = Object.freeze({
        presetId: selectedPreset,
        provider: preset.provider,
        endpointId: preset.endpoint,
        protocol: endpoint.protocol,
        model: preset.model,
        source: preset.source,
        ownerAccountId: preset.ownerAccountId ?? null,
        capability: input.capability,
        capabilities
    });
    const providerSnapshot = Object.freeze({
        provider: preset.provider,
        endpointId: preset.endpoint,
        protocol: endpoint.protocol,
        apiBase: endpoint.apiBase,
        ...(endpoint.apiKey ?? provider.apiKey
            ? { apiKey: endpoint.apiKey ?? provider.apiKey }
            : {}),
        ...(provider.ownerAccountId ? { ownerAccountId: provider.ownerAccountId } : {}),
        extraHeaders: Object.freeze({
            ...(provider.extraHeaders ?? {}),
            ...(endpoint.extraHeaders ?? {})
        }),
        extraBody
    });

    return Object.freeze({ ok: true, context, provider: providerSnapshot });
}

function selectedPresetForInput(
    input: ResolveAssignedModelInput,
    assignment: RuntimeModelAssignment
): string | null {
    if (input.requestedPreset !== undefined) return input.requestedPreset?.trim() || null;
    if (input.committedSelection) return input.committedSelection.presetId.trim() || null;
    return assignedPreset(assignment, input.capability);
}

function assignedPreset(assignment: RuntimeModelAssignment, capability: ModelCapability): string | null {
    const preset = capability === "agent"
        ? assignment.agent?.default
        : assignment[assignmentField(capability)];
    return typeof preset === "string" && preset.trim() ? preset.trim() : null;
}

function assignmentIncludes(
    assignment: RuntimeModelAssignment,
    capability: ModelCapability,
    presetId: string
): boolean {
    if (capability === "agent") return assignment.agent?.candidates?.includes(presetId) ?? false;
    return assignedPreset(assignment, capability) === presetId;
}

function assignmentField(
    capability: Exclude<ModelCapability, "agent">
): "memorySummary" | "memoryEvolution" | "embedding" | "asr" | "imageGeneration" {
    switch (capability) {
        case "memory_summary": return "memorySummary";
        case "memory_evolution": return "memoryEvolution";
        case "embedding": return "embedding";
        case "asr": return "asr";
        case "image_generation": return "imageGeneration";
    }
}

function assignmentOwnerMatches(
    mode: "account" | "byok",
    assignment: RuntimeModelAssignment,
    activeAccountId: string | null | undefined
): boolean {
    if (mode === "byok") return true;
    return Boolean(activeAccountId && assignment.ownerAccountId === activeAccountId);
}

function sourceAllowed(mode: "account" | "byok", source: ModelSource): boolean {
    return mode === "account" || source === "byok";
}

function presetOwnerMatches(
    preset: RuntimeCatalogPreset,
    activeAccountId: string | null | undefined
): boolean {
    return preset.source === "byok"
        ? !preset.ownerAccountId
        : Boolean(activeAccountId && preset.ownerAccountId === activeAccountId);
}

function providerOwnerMatches(
    preset: RuntimeCatalogPreset,
    provider: RuntimeCatalogProvider,
    activeAccountId: string | null | undefined
): boolean {
    return preset.source === "byok"
        ? !provider.ownerAccountId
        : Boolean(activeAccountId && provider.ownerAccountId === activeAccountId);
}

function committedSelectionMatches(
    committed: CommittedModelSelection | null | undefined,
    presetId: string,
    preset: RuntimeCatalogPreset
): boolean {
    return !committed || (
        committed.presetId === presetId
        && committed.source === preset.source
        && committed.ownerAccountId === (preset.ownerAccountId ?? null)
    );
}

function isRuntimeAssignment(value: unknown): value is RuntimeModelAssignment {
    if (!isRecord(value)) return false;
    if (value.ownerAccountId !== undefined && typeof value.ownerAccountId !== "string") return false;
    if (value.agent !== undefined) {
        if (!isRecord(value.agent)) return false;
        if (value.agent.candidates !== undefined && (
            !Array.isArray(value.agent.candidates)
            || !value.agent.candidates.every(nonEmptyString)
        )) return false;
        if (value.agent.default !== undefined && value.agent.default !== null && !nonEmptyString(value.agent.default)) {
            return false;
        }
    }
    return ["memorySummary", "memoryEvolution", "embedding", "asr", "imageGeneration"]
        .every((field) => value[field] === undefined || value[field] === null || nonEmptyString(value[field]));
}

function isRuntimePreset(value: unknown): value is RuntimeCatalogPreset {
    return isRecord(value)
        && nonEmptyString(value.provider)
        && nonEmptyString(value.endpoint)
        && nonEmptyString(value.model)
        && (value.source === "account" || value.source === "byok")
        && (value.ownerAccountId === undefined || nonEmptyString(value.ownerAccountId))
        && Array.isArray(value.capabilities)
        && value.capabilities.length > 0
        && value.capabilities.every((capability): capability is ModelCapability => (
            typeof capability === "string" && CAPABILITIES.has(capability as ModelCapability)
        ));
}

function isRuntimeProvider(value: unknown): value is RuntimeCatalogProvider {
    return isRecord(value)
        && (value.apiKey === undefined || typeof value.apiKey === "string")
        && (value.ownerAccountId === undefined || nonEmptyString(value.ownerAccountId))
        && (value.endpoints === undefined || isRecord(value.endpoints))
        && validStringRecord(value.extraHeaders)
        && validUnknownRecord(value.extraBody);
}

function isRuntimeEndpoint(value: unknown): value is RuntimeCatalogEndpoint {
    return isRecord(value)
        && isHttpUrl(value.apiBase)
        && typeof value.protocol === "string"
        && PROTOCOLS.has(value.protocol as ModelEndpointProtocol)
        && (value.apiKey === undefined || typeof value.apiKey === "string")
        && validStringRecord(value.extraHeaders)
        && validUnknownRecord(value.extraBody);
}

function protocolSupportsCapability(
    protocol: ModelEndpointProtocol,
    capability: ModelCapability
): boolean {
    if (protocol === "memmy-account") return true;
    if (capability === "agent") {
        return protocol === "openai-chat-completions"
            || protocol === "openai-responses"
            || protocol === "anthropic-messages"
            || protocol === "gemini-generate-content";
    }
    if (capability === "memory_summary" || capability === "memory_evolution") {
        return protocol === "openai-chat-completions"
            || protocol === "anthropic-messages"
            || protocol === "gemini-generate-content";
    }
    if (capability === "embedding") return protocol === "openai-embeddings";
    if (capability === "asr") return protocol === "dashscope-input-audio-chat";
    return protocol === "openai-images" || protocol === "dashscope-multimodal-generation";
}

function validStringRecord(value: unknown): boolean {
    return value === undefined || (
        isRecord(value) && Object.values(value).every((entry) => typeof entry === "string")
    );
}

function validUnknownRecord(value: unknown): boolean {
    return value === undefined || isRecord(value);
}

function isHttpUrl(value: unknown): value is string {
    if (typeof value !== "string") return false;
    try {
        const parsed = new URL(value);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
        return false;
    }
}

function nonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
    if (typeof value !== "object" || value === null || seen.has(value)) return value;
    seen.add(value);
    for (const child of Object.values(value)) deepFreeze(child, seen);
    return Object.freeze(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
