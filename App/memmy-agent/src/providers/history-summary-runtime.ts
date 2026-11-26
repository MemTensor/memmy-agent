import { FallbackProvider } from "./fallback-provider.js";
import type { ResolvedModelSelection } from "./model-catalog.js";
import { OpenAICompatProvider } from "./openai-compat-provider.js";
import { memmyAccountApiBase } from "./registry.js";
import { staticLlmRuntime, type LLMRuntimeResolver } from "../utils/llm-runtime.js";
import { LLMProvider, LLMResponse } from "./base.js";
import { HistorySummaryUsageGuard, HistorySummaryUsageBlockedError } from "../integrations/byok-token-usage/history-summary-usage.js";
import { createByokTokenUsageClient, resolveHistorySummaryUsagePath } from "../integrations/byok-token-usage/register.js";
import type { ByokTokenUsageInstallOptions } from "../integrations/byok-token-usage/types.js";

/** History uses the configured text summary model independently of Agent chats. */
export function historySummaryRuntime(selection: ResolvedModelSelection, usageOptions: ByokTokenUsageInstallOptions = {}): LLMRuntimeResolver {
  if (selection.capability !== "memory_summary" || selection.snapshot.provider instanceof FallbackProvider) {
    throw new Error("summary_model_selection_unavailable");
  }
  const provider = selection.snapshot.provider;
  const accountGateway = selection.provider === "memmy_account"
    || isAccountGatewayEndpoint(selection.providerConfig.apiBase);
  if (accountGateway) {
    if (!(provider instanceof OpenAICompatProvider)) throw new Error("summary_model_selection_unavailable");
    // Official aliases hide the underlying model family. Both switches match
    // the gateway's Memory summary protocol. Override only this new runtime.
    provider.extraBody = {
      ...provider.extraBody,
      enable_thinking: false,
      thinking: { type: "disabled" },
    };
  }
  const summaryProvider = selection.source === "byok"
    ? new BudgetedHistorySummaryProvider(provider, selection, new HistorySummaryUsageGuard({
      client: createByokTokenUsageClient(usageOptions), outboxPath: resolveHistorySummaryUsagePath(usageOptions),
    }))
    : provider;
  return staticLlmRuntime(summaryProvider, selection.snapshot.model);
}

class BudgetedHistorySummaryProvider extends LLMProvider {
  constructor(private readonly provider: LLMProvider, private readonly selection: ResolvedModelSelection,
    private readonly usage: HistorySummaryUsageGuard) {
    super();
    this.generation = provider.generation;
  }

  getDefaultModel(): string {
    return this.selection.snapshot.model;
  }

  async chat(args: Parameters<LLMProvider["chat"]>[0]): Promise<LLMResponse> {
    try {
      return await this.usage.run({ presetId: this.selection.presetId,
        provider: this.selection.provider, model: args.model ?? this.selection.snapshot.model }, () => this.provider.chat(args), args.signal);
    } catch (error) {
      if (!(error instanceof HistorySummaryUsageBlockedError)) throw error;
      return new LLMResponse({ content: error.message, finishReason: "error", errorShouldRetry: false,
        errorKind: "history_summary_budget" });
    }
  }
}

function isAccountGatewayEndpoint(apiBase: string): boolean {
  try {
    const endpoint = new URL(apiBase);
    const official = new URL(memmyAccountApiBase());
    return !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash
      && endpoint.origin === official.origin
      && endpoint.pathname.replace(/\/+$/u, "") === official.pathname.replace(/\/+$/u, "");
  } catch {
    return false;
  }
}
