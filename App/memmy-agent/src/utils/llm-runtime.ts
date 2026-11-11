import type { LLMProvider } from "../providers/base.js";
import type { TurnModelCapabilities } from "../providers/turn-model-capabilities.js";
import type { RuntimeModelCapabilityCatalogState } from "../providers/model-capability-catalog.js";

type RuntimePreparation = (options?: { maxTokens?: number; thinkingEnabled?: boolean }) => Promise<LLMRuntime>;

export class LLMRuntime {
  provider: LLMProvider;
  model: string;
  modelCapabilities?: TurnModelCapabilities;
  capabilityCatalogState?: RuntimeModelCapabilityCatalogState;
  prepare?: RuntimePreparation;

  constructor(provider: LLMProvider, model: string);
  constructor(init: { provider: LLMProvider; model: string; modelCapabilities?: TurnModelCapabilities; capabilityCatalogState?: RuntimeModelCapabilityCatalogState; prepare?: RuntimePreparation });
  constructor(providerOrInit: LLMProvider | { provider: LLMProvider; model: string; modelCapabilities?: TurnModelCapabilities; capabilityCatalogState?: RuntimeModelCapabilityCatalogState; prepare?: RuntimePreparation }, model?: string) {
    if (model !== undefined) {
      this.provider = providerOrInit as LLMProvider;
      this.model = model;
      return;
    }
    const init = providerOrInit as LLMRuntime;
    this.provider = init.provider;
    this.model = init.model;
    this.modelCapabilities = init.modelCapabilities;
    this.capabilityCatalogState = init.capabilityCatalogState;
    this.prepare = init.prepare;
  }
}

export type LLMRuntimeResolver = (modelPreset?: string | null) => LLMRuntime;

export function staticLlmRuntime(provider: LLMProvider, model: string): LLMRuntimeResolver {
  const runtime = new LLMRuntime(provider, model);
  return () => runtime;
}
