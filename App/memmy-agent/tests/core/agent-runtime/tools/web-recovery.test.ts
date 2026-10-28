import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSearchTool } from "../../../../src/core/agent-runtime/tools/web.js";
import { WebSearchConfig } from "../../../../src/config/schema.js";

const search = (init: Record<string, unknown> = {}) => new WebSearchTool(new WebSearchConfig({ provider: "duckduckgo", ...init }));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("web search failure recovery", () => {
  it("preserves a nested network error code and phase", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed", { cause: Object.assign(new Error("lookup failed"), { code: "ENOTFOUND" }) })));
    const result = await search().execute({ query: "one" });
    expect(result).toContain("ENOTFOUND");
    expect(result).toContain("network");
    expect(result).toContain("dns");
  });
  it("blocks different queries during service cooldown", async () => {
    const mock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", mock);
    const tool = search();
    await tool.execute({ query: "one" });
    const count = mock.mock.calls.length;
    const result = await tool.execute({ query: "different" });
    expect(mock).toHaveBeenCalledTimes(count);
    expect(result).toContain("cooldown");
  });
  it("aborts the actual fetch on timeout and never starts the Lite endpoint", async () => {
    let signal: AbortSignal | undefined;
    const mock = vi.fn((_url: string, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal!.reason), { once: true }));
    });
    vi.stubGlobal("fetch", mock);
    const result = await search({ timeout: 0.02 }).execute({ query: "one" });
    expect(result).toContain("timeout");
    expect(signal?.aborted).toBe(true);
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it("does not send a request when the user has already cancelled", async () => {
    const mock = vi.fn().mockRejectedValue(new Error("unexpected request"));
    vi.stubGlobal("fetch", mock);
    const controller = new AbortController(); controller.abort();
    const result = await search().execute({ query: "one" }, { abortSignal: controller.signal });
    expect(result).toContain("cancelled");
    expect(mock).not.toHaveBeenCalled();
  });
  it("does not report an unrecognized HTML response as no results", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>upstream maintenance</html>")));
    const result = await search().execute({ query: "one" });
    expect(result).toContain("parse");
    expect(result).not.toContain("No results for");
  });
  it("does not silently change providers when credentials are missing", async () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    const mock = vi.fn(async () => new Response("<html>no results</html>"));
    vi.stubGlobal("fetch", mock);
    try {
      const result = await search({ provider: "brave" }).execute({ query: "one" });
      expect(result).toContain("configuration");
      expect(mock).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });
});

describe("service state and fallback boundaries", () => {
  it("allows one recovery probe and clears failures after success", async () => {
    vi.useFakeTimers();
    const mock = vi.fn().mockRejectedValueOnce(new Error("offline"));
    vi.stubGlobal("fetch", mock);
    const tool = search();
    await tool.execute({ query: "one" });
    await vi.advanceTimersByTimeAsync(5000);
    let release!: (response: Response) => void;
    mock.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const probe = tool.execute({ query: "two" });
    expect(await tool.execute({ query: "three" })).toContain("cooldown");
    expect(mock).toHaveBeenCalledTimes(2);
    release(new Response('<div class="no-results">No results found</div>'));
    expect(await probe).toContain("No results");
    mock.mockResolvedValueOnce(new Response('<div class="no-results">No results found</div>'));
    expect(await tool.execute({ query: "four" })).toContain("No results");
    expect(mock).toHaveBeenCalledTimes(3);
  });
  it("honors Retry-After across different queries", async () => {
    vi.useFakeTimers();
    const mock = vi.fn(async () => new Response("limited", { status: 429, headers: { "retry-after": "120" } }));
    vi.stubGlobal("fetch", mock);
    const tool = search();
    expect(await tool.execute({ query: "one" })).toContain("120s");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await tool.execute({ query: "two" })).toContain("cooldown");
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it("keeps configuration changes independent of an old service failure", async () => {
    const mock = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(new Response('{"web":{"results":[]}}'));
    vi.stubGlobal("fetch", mock);
    const tool = search();
    await tool.execute({ query: "one" });
    tool.config = new WebSearchConfig({ provider: "brave", apiKey: "synthetic" });
    expect(await tool.execute({ query: "two" })).toContain("No results");
    expect(mock).toHaveBeenCalledTimes(2);
  });
  it("never sends the primary credential to an explicitly configured fallback", async () => {
    vi.stubEnv("TAVILY_API_KEY", "fallback-key");
    const mock = vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes("brave")) return new Response("offline", { status: 503 });
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer fallback-key");
      return new Response('{"results":[]}');
    });
    vi.stubGlobal("fetch", mock);
    try {
      expect(await search({ provider: "brave", apiKey: "primary-key", fallbackProviders: ["tavily"] }).execute({ query: "one" })).toContain("No results");
    } finally { vi.unstubAllEnvs(); }
  });
  it("skips a failed fallback during its cooldown", async () => {
    const mock = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", mock);
    const tool = search({ provider: "jina", apiKey: "synthetic", fallbackProviders: ["duckduckgo"] });
    await tool.execute({ query: "one" });
    expect(mock).toHaveBeenCalledTimes(2);
    expect(await tool.execute({ query: "two" })).toContain("cooldown");
    expect(mock).toHaveBeenCalledTimes(2);
  });
  it("does not expose sensitive raw error messages", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("https://user:secret@example.com?api_key=private-token")));
    const result = await search().execute({ query: "one" });
    expect(result).toContain("network");
    expect(result).not.toMatch(/secret|private-token/);
  });
  it("does not penalize a cancelled operation", async () => {
    const controller = new AbortController();
    const mock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    }));
    vi.stubGlobal("fetch", mock);
    const tool = search();
    const result = tool.execute({ query: "one" }, { abortSignal: controller.signal });
    controller.abort();
    expect(await result).toContain("cancelled");
    await Promise.resolve();
    mock.mockResolvedValueOnce(new Response('<div class="no-results">No results found</div>'));
    expect(await tool.execute({ query: "two" })).toContain("No results");
  });
});
