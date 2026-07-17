import { LLMProvider, LLMResponse } from "./base.js";

const PRIMARY_FAILURE_THRESHOLD = 3;
const PRIMARY_COOLDOWN_MS = 60_000;
const FALLBACK_ERROR_KINDS = new Set(["timeout", "connection", "server_error", "rate_limit", "overloaded"]);
const NON_FALLBACK_ERROR_KINDS = new Set([
  "authentication",
  "auth",
  "permission",
  "content_filter",
  "refusal",
  "context_length",
  "invalid_request",
]);
const FALLBACK_ERROR_TOKENS = [
  "rate_limit",
  "rate limit",
  "too_many_requests",
  "too many requests",
  "overloaded",
  "server_error",
  "server error",
  "temporarily unavailable",
  "timeout",
  "timed out",
  "connection",
  "insufficient_quota",
  "insufficient quota",
  "quota_exceeded",
  "quota exceeded",
  "quota_exhausted",
  "quota exhausted",
  "billing_hard_limit",
  "insufficient_balance",
  "balance",
  "out of credits",
];
const MISSING = Symbol("missing");

type FallbackPreset = {
  model: string;
  maxTokens?: number | null;
  temperature?: number | null;
  reasoningEffort?: string | null;
};

export class FallbackProvider extends LLMProvider {
  providers: LLMProvider[];
  primary: LLMProvider;
  fallbackPresets: FallbackPreset[];
  providerFactory: (preset: FallbackPreset) => LLMProvider;
  hasFallbacks: boolean;
  primaryFailures = 0;
  primaryTrippedAt: number | null = null;

  constructor(
    providersOrInit:
      | LLMProvider[]
      | {
          primary: LLMProvider;
          fallbackPresets?: FallbackPreset[];
          providerFactory?: (preset: FallbackPreset) => LLMProvider;
        },
  ) {
    super();
    if (Array.isArray(providersOrInit)) {
      const [primary, ...fallbackProviders] = providersOrInit;
      this.primary = primary;
      this.fallbackPresets = fallbackProviders.map((provider) => ({
        model: provider.getDefaultModel(),
      }));
      this.providerFactory = (preset) =>
        fallbackProviders.find((provider) => provider.getDefaultModel() === preset.model) ?? fallbackProviders[0];
      this.providers = providersOrInit;
    } else {
      this.primary = providersOrInit.primary;
      this.fallbackPresets = providersOrInit.fallbackPresets ?? [];
      this.providerFactory = providersOrInit.providerFactory ?? (() => this.primary);
      this.providers = [this.primary];
    }
    this.hasFallbacks = this.fallbackPresets.length > 0;
    this.generation = this.primary.generation;
  }

  get supportsProgressDeltas(): boolean {
    return Boolean((this.primary as any).supportsProgressDeltas);
  }

  getDefaultModel(): string {
    return this.primary.getDefaultModel();
  }

  primaryAvailable(): boolean {
    if (this.primaryTrippedAt == null) return true;
    return Date.now() - this.primaryTrippedAt >= PRIMARY_COOLDOWN_MS;
  }

  async chat(args: any): Promise<LLMResponse> {
    if (!this.hasFallbacks) return this.primary.chat(args);
    return this.tryWithFallback((provider, nextArgs) => provider.chat(nextArgs), args, null);
  }

  async chatStream(args: any): Promise<LLMResponse> {
    if (!this.hasFallbacks) return this.primary.chatStream(args);
    const hasStreamed = [false];
    const originalDelta = args.onContentDelta;
    args.onContentDelta = async (text: string) => {
      if (text) hasStreamed[0] = true;
      await originalDelta?.(text);
    };
    return this.tryWithFallback((provider, nextArgs) => provider.chatStream(nextArgs), args, hasStreamed);
  }

  async tryWithFallback(
    call: (provider: LLMProvider, args: any) => Promise<LLMResponse>,
    args: any,
    hasStreamed: boolean[] | null,
  ): Promise<LLMResponse> {
    const primaryModel = args.model ?? this.primary.getDefaultModel();
    if (this.primaryAvailable()) {
      const response = await call(this.primary, args);
      if (response.finishReason !== "error") {
        this.primaryFailures = 0;
        this.primaryTrippedAt = null;
        return response;
      }
      if (hasStreamed?.[0]) return response;
      if (!FallbackProvider.shouldFallback(response)) return response;
      this.primaryFailures += 1;
      if (this.primaryFailures >= PRIMARY_FAILURE_THRESHOLD) {
        this.primaryTrippedAt = Date.now();
      }
    }

    let lastResponse: LLMResponse | null = null;
    for (const fallback of this.fallbackPresets) {
      if (hasStreamed?.[0]) break;
      let fallbackProvider: LLMProvider;
      try {
        fallbackProvider = this.providerFactory(fallback);
      } catch {
        continue;
      }

      const original = {
        model: Object.prototype.hasOwnProperty.call(args, "model") ? args.model : MISSING,
        maxTokens: Object.prototype.hasOwnProperty.call(args, "maxTokens") ? args.maxTokens : MISSING,
        temperature: Object.prototype.hasOwnProperty.call(args, "temperature") ? args.temperature : MISSING,
        reasoningEffort: Object.prototype.hasOwnProperty.call(args, "reasoningEffort") ? args.reasoningEffort : MISSING,
      };
      args.model = fallback.model;
      args.maxTokens = fallback.maxTokens ?? null;
      args.temperature = fallback.temperature ?? null;
      const reasoning = fallback.reasoningEffort ?? null;
      if (reasoning == null) {
        delete args.reasoningEffort;
      } else {
        args.reasoningEffort = reasoning;
      }
      try {
        const response = await call(fallbackProvider, args);
        if (response.finishReason !== "error") return response;
        lastResponse = response;
      } finally {
        restoreArg(args, "model", original.model);
        restoreArg(args, "maxTokens", original.maxTokens);
        restoreArg(args, "temperature", original.temperature);
        restoreArg(args, "reasoningEffort", original.reasoningEffort);
      }
    }
    return (
      lastResponse ??
      new LLMResponse({
        content: `Primary model '${primaryModel}' circuit open and no fallbacks available`,
        finishReason: "error",
      })
    );
  }

  static shouldFallback(response: LLMResponse): boolean {
    if (response.errorShouldRetry === false) return false;
    const status = response.errorStatusCode;
    const kind = (response.errorKind ?? "").toLowerCase();
    const errorType = (response.errorType ?? "").toLowerCase();
    const code = (response.errorCode ?? "").toLowerCase();
    const text = (response.content ?? "").toLowerCase();
    if (status != null && [400, 401, 403, 404, 422].includes(status)) return false;
    if (NON_FALLBACK_ERROR_KINDS.has(kind)) return false;
    if ([kind, errorType, code].some((value) => [...NON_FALLBACK_ERROR_KINDS].some((token) => value.includes(token)))) {
      return false;
    }
    if (response.errorShouldRetry === true) return true;
    if (status != null && (status === 408 || status === 409 || status === 429 || status >= 500)) return true;
    if (FALLBACK_ERROR_KINDS.has(kind)) return true;
    return [kind, errorType, code, text].some((value) => FALLBACK_ERROR_TOKENS.some((token) => value.includes(token)));
  }

}

function restoreArg(args: any, name: string, value: any): void {
  if (value === MISSING) delete args[name];
  else args[name] = value;
}
