import {
  resolveThinkingEnabled,
  resolveThinkingLevel,
  type CloudModelCapability,
} from "@memmy/local-api-contracts";
import type { RuntimeModelCapabilityCatalogState } from "./model-capability-catalog.js";

export function resolveTurnModelCapabilities(input: {
  state: RuntimeModelCapabilityCatalogState;
  model: string;
  /** Presence marks a custom model, including an empty user configuration. */
  customConfig?: Partial<CloudModelCapability>;
  explicitGeneration?: { maxTokens?: number; contextWindowTokens?: number; reasoningEffort?: string | null };
  providerReasoningEffort?: string | null;
  agentReasoningEffort?: string | null;
  /** Pass only user choices; computed frontend defaults are not explicit overrides. */
  sessionThinking?: { enabled?: boolean; level?: string };
}) {
  const capability = input.customConfig !== undefined
    ? input.customConfig
    : input.state.mode === "catalog" ? input.state.catalog.models[input.model] : undefined;
  const explicit = input.explicitGeneration;
  const session = input.sessionThinking;
  const thinking = capability?.thinking;
  const thinkingEnabled = thinking
    ? resolveThinkingEnabled(thinking, session?.enabled)
    : session?.enabled;
  const thinkingLevel = thinking
    ? thinkingEnabled ? resolveThinkingLevel(thinking, session?.level) ?? undefined : undefined
    : thinkingEnabled === false ? undefined : session?.level;
  const reasoningEffort = thinkingEnabled === false
    ? "none"
    : thinkingLevel ?? (thinking ? undefined
      : explicit?.reasoningEffort ?? input.providerReasoningEffort ?? input.agentReasoningEffort ?? undefined);
  const maxTokens = explicit?.maxTokens ?? capability?.maxTokens;
  const contextWindowTokens = explicit?.contextWindowTokens ?? capability?.contextWindowTokens;
  return Object.freeze({
    mode: input.state.mode,
    ...(input.state.mode === "catalog" ? { catalogVersion: input.state.catalog.catalogVersion } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
    ...(capability?.inputModalities ? { inputModalities: Object.freeze([...capability.inputModalities]) } : {}),
    ...(thinkingEnabled !== undefined ? { thinkingEnabled } : {}),
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
  });
}

export type TurnModelCapabilities = ReturnType<typeof resolveTurnModelCapabilities> & {
  /** A task's output allowance, separate from the model/user total limit. */
  taskMaxTokens?: number;
};
