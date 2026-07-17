/** Manifest module. */
import type {
  AgentAdapterCapabilities,
  AgentAdapterDescriptor
} from "./types/adapter.js";
import type { BuiltinAgentKind } from "./types/domain.js";
import type { AgentAdapterPluginManifest } from "./types/plugin.js";

const BUILTIN_AGENT_KINDS = [
  "cursor",
  "codex",
  "claude_code",
  "opencode",
  "openclaw",
  "hermes",
  "workbuddy"
] as const satisfies readonly BuiltinAgentKind[];

/** Parses parse agent adapter plugin manifest. */
export function parseAgentAdapterPluginManifest(
  value: unknown,
  sourceLabel = "agent adapter plugin manifest"
): AgentAdapterPluginManifest {
  const record = requireRecord(value, sourceLabel);
  const capabilities = parseCapabilities(record.capabilities, sourceLabel);

  return {
    id: requireNonEmptyString(record.id, `${sourceLabel}.id`),
    kind: parseAgentKind(record.kind, `${sourceLabel}.kind`),
    displayName: requireNonEmptyString(record.displayName, `${sourceLabel}.displayName`),
    version: requireNonEmptyString(record.version, `${sourceLabel}.version`),
    modulePath: requireNonEmptyString(record.modulePath, `${sourceLabel}.modulePath`),
    enabled: parseOptionalBoolean(record.enabled, true, `${sourceLabel}.enabled`),
    priority: parseOptionalNumber(record.priority, 0, `${sourceLabel}.priority`),
    capabilities
  };
}

/**
 * Derives a lightweight descriptor from the plugin manifest for use by the registry and backend services.
 */
export function createAgentAdapterDescriptor(manifest: AgentAdapterPluginManifest): AgentAdapterDescriptor {
  return {
    id: manifest.id,
    kind: manifest.kind,
    displayName: manifest.displayName,
    version: manifest.version,
    capabilities: manifest.capabilities
  };
}

/**
 * Determines whether the kind is a Memmy built-in Agent; do not use it to reject third-party plugin kinds.
 */
export function isBuiltinAgentKind(value: unknown): value is BuiltinAgentKind {
  return typeof value === "string" && isIncludedBuiltinKind(value);
}

/**
 * Parses the plugin capability declaration.
 */
function parseCapabilities(value: unknown, sourceLabel: string): AgentAdapterCapabilities {
  const record = requireRecord(value, `${sourceLabel}.capabilities`);

  return {
    detect: requireBoolean(record.detect, `${sourceLabel}.capabilities.detect`),
    scan: requireBoolean(record.scan, `${sourceLabel}.capabilities.scan`),
    installSkill: requireBoolean(record.installSkill, `${sourceLabel}.capabilities.installSkill`),
    removeSkill: requireBoolean(record.removeSkill, `${sourceLabel}.capabilities.removeSkill`)
  };
}

/**
 * Parses an open Agent kind, requiring a non-empty string.
 */
function parseAgentKind(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }

  throw new Error(`${label} must be a non-empty string`);
}

/**
 * Parses an optional boolean field, returning the fallback when absent.
 */
function parseOptionalBoolean(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined) {
    return fallback;
  }

  return requireBoolean(value, label);
}

/**
 * Parses an optional number field, returning the fallback when absent.
 */
function parseOptionalNumber(value: unknown, fallback: number, label: string): number {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  throw new Error(`${label} must be a finite number`);
}

/**
 * Requires the input to be a plain object, for subsequent field-level parsing.
 */
function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  throw new Error(`${label} must be an object`);
}

/**
 * Requires the input to be a non-empty string.
 */
function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }

  throw new Error(`${label} must be a non-empty string`);
}

/**
 * Requires the input to be a boolean.
 */
function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  throw new Error(`${label} must be a boolean`);
}

/**
 * Determines whether the string appears in the list of built-in Agent kinds.
 */
function isIncludedBuiltinKind(value: string): value is BuiltinAgentKind {
  return BUILTIN_AGENT_KINDS.includes(value as BuiltinAgentKind);
}
