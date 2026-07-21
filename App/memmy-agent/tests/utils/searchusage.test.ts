import { afterEach, describe, expect, it, vi } from "vitest";
import { buildStatusContent } from "../../src/utils/helpers.js";
import {
  SearchUsageInfo,
  parseTavilyUsage,
  fetchSearchUsage,
} from "../../src/utils/searchusage.js";

const originalFetch = globalThis.fetch;
const originalTavilyKey = process.env.TAVILY_API_KEY;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalTavilyKey == null) delete process.env.TAVILY_API_KEY;
  else process.env.TAVILY_API_KEY = originalTavilyKey;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("SearchUsageInfo.format", () => {
  it("shows unsupported providers as not tracked", () => {
    const text = new SearchUsageInfo({ provider: "duckduckgo", supported: false }).format();

    expect(text).toContain("duckduckgo");
    expect(text).toContain("not available");
  });

  it("shows supported provider errors as unavailable", () => {
    const text = new SearchUsageInfo({
      provider: "tavily",
      supported: true,
      error: "HTTP 401",
    }).format();

    expect(text).toContain("tavily");
    expect(text).toContain("HTTP 401");
    expect(text).toContain("unavailable");
  });

  it("formats full Tavily usage", () => {
    const text = new SearchUsageInfo({
      provider: "tavily",
      supported: true,
      used: 142,
      limit: 1000,
      remaining: 858,
      resetDate: "2026-05-01",
      searchUsed: 120,
      extractUsed: 15,
      crawlUsed: 7,
    }).format();

    expect(text).toContain("tavily");
    expect(text).toContain("142 / 1000");
    expect(text).toContain("858");
    expect(text).toContain("2026-05-01");
    expect(text).toContain("Search: 120");
    expect(text).toContain("Extract: 15");
    expect(text).toContain("Crawl: 7");
  });

  it("formats usage without a limit", () => {
    const text = new SearchUsageInfo({ provider: "tavily", supported: true, used: 50 }).format();
    const usageLine = text.split("\n").find((line) => line.includes("Usage:")) ?? "";

    expect(usageLine).toContain("50 requests");
    expect(usageLine).not.toContain("/");
  });

  it("omits breakdown when breakdown fields are absent", () => {
    const text = new SearchUsageInfo({
      provider: "tavily",
      supported: true,
      used: 10,
      limit: 100,
      remaining: 90,
    }).format();

    expect(text).not.toContain("Breakdown");
  });

  it("formats Brave as unsupported", () => {
    const text = new SearchUsageInfo({ provider: "brave", supported: false }).format();

    expect(text).toContain("brave");
    expect(text).toContain("not available");
  });
});

describe("Tavily usage parsing", () => {
  it("parses a full Tavily response", () => {
    const info = parseTavilyUsage({
      account: {
        current_plan: "Researcher",
        plan_usage: 142,
        plan_limit: 1000,
        search_usage: 120,
        extract_usage: 15,
        crawl_usage: 7,
        map_usage: 0,
        research_usage: 0,
        paygo_usage: 0,
        paygo_limit: null,
      },
    });

    expect(info.provider).toBe("tavily");
    expect(info.supported).toBe(true);
    expect(info.used).toBe(142);
    expect(info.limit).toBe(1000);
    expect(info.remaining).toBe(858);
    expect(info.searchUsed).toBe(120);
    expect(info.extractUsed).toBe(15);
    expect(info.crawlUsed).toBe(7);
  });

  it("computes remaining usage", () => {
    expect(parseTavilyUsage({ account: { plan_usage: 300, plan_limit: 1000 } }).remaining).toBe(
      700,
    );
  });

  it("does not compute negative remaining usage", () => {
    expect(parseTavilyUsage({ account: { plan_usage: 1100, plan_limit: 1000 } }).remaining).toBe(0);
  });

  it("handles an empty response", () => {
    const info = parseTavilyUsage({});

    expect(info.provider).toBe("tavily");
    expect(info.supported).toBe(true);
    expect(info.used).toBeNull();
    expect(info.limit).toBeNull();
  });

  it("leaves missing breakdown fields as null", () => {
    const info = parseTavilyUsage({ account: { plan_usage: 5, plan_limit: 50 } });

    expect(info.searchUsed).toBeNull();
    expect(info.extractUsed).toBeNull();
    expect(info.crawlUsed).toBeNull();
  });
});

describe("fetchSearchUsage", () => {
  it("returns unsupported for duckduckgo", async () => {
    const info = await fetchSearchUsage("duckduckgo");

    expect(info.provider).toBe("duckduckgo");
    expect(info.supported).toBe(false);
  });

  it("returns unsupported for searxng", async () => {
    expect((await fetchSearchUsage("searxng")).supported).toBe(false);
  });

  it("returns unsupported for jina", async () => {
    expect((await fetchSearchUsage("jina")).supported).toBe(false);
  });

  it("returns unsupported for brave", async () => {
    const info = await fetchSearchUsage("brave");

    expect(info.provider).toBe("brave");
    expect(info.supported).toBe(false);
  });

  it("returns unsupported for unknown providers", async () => {
    expect((await fetchSearchUsage("some_unknown_provider")).supported).toBe(false);
  });

  it("returns a Tavily error when no API key is configured", async () => {
    delete process.env.TAVILY_API_KEY;

    const info = await fetchSearchUsage("tavily", null);

    expect(info.provider).toBe("tavily");
    expect(info.supported).toBe(true);
    expect(info.error).toContain("not configured");
  });

  it("fetches Tavily usage successfully", async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json({
        account: {
          current_plan: "Researcher",
          plan_usage: 142,
          plan_limit: 1000,
          search_usage: 120,
          extract_usage: 15,
          crawl_usage: 7,
        },
      }),
    ) as any;

    const info = await fetchSearchUsage("tavily", "test-key");

    expect(info.provider).toBe("tavily");
    expect(info.supported).toBe(true);
    expect(info.error).toBeNull();
    expect(info.used).toBe(142);
    expect(info.limit).toBe(1000);
    expect(info.remaining).toBe(858);
    expect(info.searchUsed).toBe(120);
  });

  it("reports Tavily HTTP errors", async () => {
    globalThis.fetch = vi.fn(async () => new Response("bad", { status: 401 })) as any;

    const info = await fetchSearchUsage("tavily", "bad-key");

    expect(info.supported).toBe(true);
    expect(info.error).toBe("HTTP 401");
  });

  it("reports Tavily network errors", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("timeout");
    }) as any;

    const info = await fetchSearchUsage("tavily", "test-key");

    expect(info.supported).toBe(true);
    expect(info.error).toContain("timeout");
  });

  it("aborts slow Tavily usage requests", async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn((url, init) => {
      void url;
      const signal = (init as RequestInit).signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    }) as any;

    const pending = fetchSearchUsage("tavily", "test-key");
    await vi.advanceTimersByTimeAsync(8_000);
    const info = await pending;

    expect(info.supported).toBe(true);
    expect(info.error).toBe("timeout");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.tavily.com/usage",
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("normalizes provider names case-insensitively", async () => {
    delete process.env.TAVILY_API_KEY;

    const info = await fetchSearchUsage("Tavily", null);

    expect(info.provider).toBe("tavily");
    expect(info.supported).toBe(true);
  });
});

describe("buildStatusContent search usage integration", () => {
  const base = {
    version: "test-version",
    model: "claude-opus-4-5",
    startTime: 1_000_000,
    lastUsage: { prompt_tokens: 1000, completion_tokens: 200 },
    contextWindowTokens: 200_000,
    sessionMsgCount: 5,
    contextTokensEstimate: 3000,
  };

  it("leaves status unchanged when search usage is omitted", () => {
    const content = buildStatusContent(base);

    expect(content).not.toContain("🔍");
    expect(content).not.toContain("Web Search");
  });

  it("leaves status unchanged when search usage is null", () => {
    const content = buildStatusContent({ ...base, searchUsageText: null });

    expect(content).not.toContain("🔍");
  });

  it("appends provided search usage text", () => {
    const content = buildStatusContent({
      ...base,
      searchUsageText: "🔍 Web Search: tavily\n   Usage: 142 / 1000 requests",
    });

    expect(content).toContain("🔍 Web Search: tavily");
    expect(content).toContain("142 / 1000");
  });

  it("keeps existing status fields while adding search usage", () => {
    const content = buildStatusContent({
      ...base,
      searchUsageText: "🔍 Web Search: duckduckgo\n   Usage tracking: not available",
    });

    expect(content).toContain("memmy vtest-version");
    expect(content).toContain("claude-opus-4-5");
    expect(content).toContain("1000 in / 200 out");
    expect(content).toContain("duckduckgo");
  });

  it("includes full Tavily usage in status content", () => {
    const usage = new SearchUsageInfo({
      provider: "tavily",
      supported: true,
      used: 142,
      limit: 1000,
      remaining: 858,
      resetDate: "2026-05-01",
      searchUsed: 120,
      extractUsed: 15,
      crawlUsed: 7,
    }).format();

    const content = buildStatusContent({ ...base, searchUsageText: usage });

    expect(content).toContain("142 / 1000");
    expect(content).toContain("858");
    expect(content).toContain("2026-05-01");
    expect(content).toContain("Search: 120");
  });
});
