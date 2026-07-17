export class SearchUsageInfo {
  provider: string;
  supported: boolean;
  used?: number | null;
  limit?: number | null;
  remaining?: number | null;
  resetDate?: string | null;
  searchUsed?: number | null;
  extractUsed?: number | null;
  crawlUsed?: number | null;
  error?: string | null;

  constructor(init: Partial<SearchUsageInfo> & { provider: string; supported: boolean }) {
    Object.assign(this, init);
    this.provider = init.provider;
    this.supported = init.supported;
    this.resetDate = init.resetDate ?? null;
    this.searchUsed = init.searchUsed ?? null;
    this.extractUsed = init.extractUsed ?? null;
    this.crawlUsed = init.crawlUsed ?? null;
    this.used = init.used ?? null;
    this.limit = init.limit ?? null;
    this.remaining = init.remaining ?? null;
    this.error = init.error ?? null;
  }

  format(): string {
    const lines = [`🔍 Web Search: ${this.provider}`];
    if (!this.supported) {
      lines.push("   Usage tracking: not available for this provider");
      return lines.join("\n");
    }
    if (this.error) {
      lines.push(`   Usage: unavailable (${this.error})`);
      return lines.join("\n");
    }
    if (this.used != null && this.limit != null)
      lines.push(`   Usage: ${this.used} / ${this.limit} requests`);
    else if (this.used != null) lines.push(`   Usage: ${this.used} requests`);
    const breakdown: string[] = [];
    if (this.searchUsed != null) breakdown.push(`Search: ${this.searchUsed}`);
    if (this.extractUsed != null) breakdown.push(`Extract: ${this.extractUsed}`);
    if (this.crawlUsed != null) breakdown.push(`Crawl: ${this.crawlUsed}`);
    if (breakdown.length) lines.push(`   Breakdown: ${breakdown.join(" | ")}`);
    if (this.remaining != null) lines.push(`   Remaining: ${this.remaining} requests`);
    if (this.resetDate) lines.push(`   Resets: ${this.resetDate}`);
    return lines.join("\n");
  }
}

const TAVILY_USAGE_TIMEOUT_MS = 8_000;

export function parseTavilyUsage(data: any): SearchUsageInfo {
  const account = data?.account ?? {};
  const used = account.plan_usage ?? null;
  const limit = account.plan_limit ?? null;
  const remaining = used != null && limit != null ? Math.max(0, limit - used) : null;
  return new SearchUsageInfo({
    provider: "tavily",
    supported: true,
    used,
    limit,
    remaining,
    resetDate: account.reset_date ?? null,
    searchUsed: account.search_usage ?? null,
    extractUsed: account.extract_usage ?? null,
    crawlUsed: account.crawl_usage ?? null,
  });
}

export async function fetchSearchUsage(
  provider: string,
  apiKey?: string | null,
): Promise<SearchUsageInfo> {
  const normalizedProvider = String(provider || "duckduckgo")
    .trim()
    .toLowerCase();
  if (normalizedProvider !== "tavily")
    return new SearchUsageInfo({ provider: normalizedProvider, supported: false });
  const key = apiKey ?? process.env.TAVILY_API_KEY;
  if (!key)
    return new SearchUsageInfo({
      provider: normalizedProvider,
      supported: true,
      error: "TAVILY_API_KEY not configured",
    });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TAVILY_USAGE_TIMEOUT_MS);
  try {
    const response = await fetch("https://api.tavily.com/usage", {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    if (!response.ok)
      return new SearchUsageInfo({
        provider: normalizedProvider,
        supported: true,
        error: `HTTP ${response.status}`,
      });
    return parseTavilyUsage(await response.json());
  } catch (error) {
    if ((error as Error).name === "AbortError")
      return new SearchUsageInfo({
        provider: normalizedProvider,
        supported: true,
        error: "timeout",
      });
    return new SearchUsageInfo({
      provider: normalizedProvider,
      supported: true,
      error: (error as Error).message.slice(0, 80),
    });
  } finally {
    clearTimeout(timeout);
  }
}

export function searchUsageSummary(count: number): string {
  return `${count} searches`;
}
