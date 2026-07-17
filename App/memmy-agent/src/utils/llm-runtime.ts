import type { LLMProvider } from "../providers/base.js";

export class LLMRuntime {
  provider: LLMProvider;
  model: string;

  constructor(provider: LLMProvider, model: string);
  constructor(init: { provider: LLMProvider; model: string });
  constructor(providerOrInit: LLMProvider | { provider: LLMProvider; model: string }, model?: string) {
    if (model !== undefined) {
      this.provider = providerOrInit as LLMProvider;
      this.model = model;
      return;
    }
    const init = providerOrInit as { provider: LLMProvider; model: string };
    this.provider = init.provider;
    this.model = init.model;
  }
}

export type LLMRuntimeResolver = () => LLMRuntime;

export function staticLlmRuntime(provider: LLMProvider, model: string): LLMRuntimeResolver {
  const runtime = new LLMRuntime(provider, model);
  return () => runtime;
}
