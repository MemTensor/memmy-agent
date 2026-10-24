import type {
  ByokTokenUsageClient,
  ByokTokenUsageClientOptions,
  ByokTokenUsageEvent,
  ByokTokenUsageRuntimeConfig,
  FetchLike,
} from "./types.js";
import { MemoryTokenBudgetDtoSchema, type MemoryTokenBudgetDto } from "@memmy/local-api-contracts";

const DEFAULT_TIMEOUT_MS = 5_000;
const EVENT_PATH = "/api/app/byok-token-usage/events";
const MEMORY_BUDGET_PATH = "/api/app/byok-token-usage/memory-budget";

export class HttpByokTokenUsageClient implements ByokTokenUsageClient {
  private readonly baseUrl: string | null;
  private readonly runtimeToken: string | null;
  private readonly runtimeConfigProvider: (() => ByokTokenUsageRuntimeConfig | null) | null;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: ByokTokenUsageClientOptions) {
    this.baseUrl = options.baseUrl ? normalizeBaseUrl(options.baseUrl) : null;
    this.runtimeToken = options.runtimeToken ?? null;
    this.runtimeConfigProvider = options.runtimeConfigProvider ?? null;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async recordEvent(event: ByokTokenUsageEvent, options: { requireRuntime?: boolean } = {}): Promise<void> {
    const runtime = this.resolveRuntimeConfig();
    if (!runtime) {
      if (options.requireRuntime) throw new Error("BYOK token usage runtime is unavailable");
      return;
    }

    const response = await this.fetchImpl(new URL(EVENT_PATH, runtime.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-memmy-local-token": runtime.localToken,
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`BYOK token usage upload failed: ${response.status} ${response.statusText}`);
    }
  }

  async getMemoryBudget(): Promise<MemoryTokenBudgetDto> {
    const runtime = this.resolveRuntimeConfig();
    if (!runtime) throw new Error("BYOK memory budget runtime is unavailable");
    const response = await this.fetchImpl(new URL(MEMORY_BUDGET_PATH, runtime.baseUrl), {
      headers: { "x-memmy-local-token": runtime.localToken },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`BYOK memory budget read failed: ${response.status}`);
    return MemoryTokenBudgetDtoSchema.parse(await response.json());
  }

  private resolveRuntimeConfig(): ByokTokenUsageRuntimeConfig | null {
    const runtime = this.runtimeConfigProvider?.() ?? this.staticRuntimeConfig();
    if (!runtime) return null;

    const baseUrl = stringOrNull(runtime.baseUrl);
    const localToken = stringOrNull(runtime.localToken);
    if (!baseUrl || !localToken) return null;
    return {
      baseUrl: normalizeBaseUrl(baseUrl),
      localToken,
    };
  }

  private staticRuntimeConfig(): ByokTokenUsageRuntimeConfig | null {
    if (!this.baseUrl || !this.runtimeToken) return null;
    return {
      baseUrl: this.baseUrl,
      localToken: this.runtimeToken,
    };
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) {
    throw new Error("BYOK token usage endpoint must be a local backend");
  }
  return url.origin;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
