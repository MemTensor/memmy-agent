import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeDuckDuckGoUrl,
  isDuckDuckGoBotChallenge,
  parseDuckDuckGoHtml,
  WebSearchTool,
} from "../../../../src/core/agent-runtime/tools/web.js";
import { WebSearchConfig } from "../../../../src/config/schema.js";

function tool({
  provider = "brave",
  apiKey = "",
  baseUrl = "",
  userAgent,
}: {
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  userAgent?: string;
} = {}): WebSearchTool {
  return new WebSearchTool({
    config: new WebSearchConfig({ provider, apiKey, baseUrl }),
    userAgent,
  });
}

function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { "content-type": "text/html" },
  });
}

function duckDuckGoHtml(
  results: Array<{ title: string; url: string; snippet: string }> = [
    { title: "Duck Result", url: "https://example.com/duck", snippet: "DuckDuckGo search result" },
  ],
): string {
  return `
    <html>
      <body>
        ${results
          .map(
            (result) => `
              <div class="result">
                <a class="result__a" href="https://duckduckgo.com/l/?uddg=${encodeURIComponent(result.url)}">
                  ${result.title}
                </a>
                <a class="result__snippet">${result.snippet}</a>
              </div>
            `,
          )
          .join("\n")}
      </body>
    </html>
  `;
}

function duckDuckGoLiteHtml(
  results: Array<{ title: string; url: string; snippet: string }> = [
    { title: "Lite Result", url: "https://example.com/lite", snippet: "DuckDuckGo Lite result" },
  ],
): string {
  return `
    <html>
      <body>
        ${results
          .map(
            (result) => `
              <table>
                <tr>
                  <td>
                    <a class='result-link' href="//duckduckgo.com/l/?uddg=${encodeURIComponent(result.url)}">
                      ${result.title}
                    </a>
                  </td>
                </tr>
                <tr><td class='result-snippet'>${result.snippet}</td></tr>
              </table>
            `,
          )
          .join("\n")}
      </body>
    </html>
  `;
}

function stubDuckDuckGo(results?: Array<{ title: string; url: string; snippet: string }>) {
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    expect(href).toContain("html.duckduckgo.com/html");
    expect(href).toContain("q=");
    expect((init?.headers as Record<string, string>)["User-Agent"]).toBeTruthy();
    return htmlResponse(duckDuckGoHtml(results));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.BRAVE_API_KEY;
  delete process.env.SEARXNG_BASE_URL;
  delete process.env.KAGI_API_KEY;
  delete process.env.JINA_API_KEY;
  delete process.env.TAVILY_API_KEY;
});

describe("web_search providers", () => {
  it("parses DuckDuckGo HTML results and redirect URLs", () => {
    const html = duckDuckGoHtml([
      {
        title: "Memmy &amp; Agent",
        url: "https://example.com/search?q=memmy&lang=en",
        snippet: "A &lt;typed&gt; result",
      },
    ]);

    const parsed = parseDuckDuckGoHtml(html);
    const lite = parseDuckDuckGoHtml(duckDuckGoLiteHtml());

    expect(parsed).toEqual([
      {
        title: "Memmy & Agent",
        href: "https://example.com/search?q=memmy&lang=en",
        body: "A <typed> result",
      },
    ]);
    expect(lite[0]).toMatchObject({
      title: "Lite Result",
      href: "https://example.com/lite",
      body: "DuckDuckGo Lite result",
    });
    expect(decodeDuckDuckGoUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org")).toBe(
      "https://example.org",
    );
    expect(isDuckDuckGoBotChallenge('<form id="challenge-form"></form>')).toBe(true);
  });

  it("treats DuckDuckGo search as exclusive", () => {
    const search = tool({ provider: "duckduckgo" });

    expect(search.exclusive).toBe(true);
    expect(search.concurrencySafe).toBe(false);
  });

  it("keeps keyed Brave search concurrency safe", () => {
    const search = tool({ provider: "brave", apiKey: "brave-key" });

    expect(search.exclusive).toBe(false);
    expect(search.concurrencySafe).toBe(true);
  });

  it("treats Brave without API key as DuckDuckGo for concurrency", () => {
    const search = tool({ provider: "brave", apiKey: "" });

    expect(search.exclusive).toBe(true);
    expect(search.concurrencySafe).toBe(false);
  });

  it("formats Brave search results", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toContain("brave");
        expect((init.headers as Record<string, string>)["X-Subscription-Token"]).toBe("brave-key");
        expect((init.headers as Record<string, string>)["User-Agent"]).toBe("memmy-search-test");
        return jsonResponse({
          web: {
            results: [
              { title: "Memmy", url: "https://example.com", description: "AI assistant" },
            ],
          },
        });
      }),
    );

    const result = await tool({
      provider: "brave",
      apiKey: "brave-key",
      userAgent: "memmy-search-test",
    }).execute({
      query: "memmy",
      count: 1,
    });

    expect(result).toContain("Memmy");
    expect(result).toContain("https://example.com");
  });

  it("retries Brave rate limits once", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) return jsonResponse({ error: "rate limit" }, 429);
        return jsonResponse({
          web: { results: [{ title: "Recovered", url: "https://example.com", description: "ok" }] },
        });
      }),
    );

    const result = await tool({ provider: "brave", apiKey: "brave-key" }).execute({
      query: "memmy",
      count: 1,
    });

    expect(calls).toBe(2);
    expect(result).toContain("Recovered");
  });

  it("returns a clear Brave rate-limit error after retries", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return jsonResponse({ error: "rate limit" }, 429);
      }),
    );

    const result = await tool({ provider: "brave", apiKey: "brave-key" }).execute({
      query: "memmy",
      count: 1,
    });

    expect(calls).toBe(2);
    expect(result).toContain("Brave search rate limited");
    expect(result).toContain("consecutive web_search");
  });

  it("formats Tavily search results", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toContain("tavily");
        expect(init.method).toBe("POST");
        expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tavily-key");
        expect((init.headers as Record<string, string>)["User-Agent"]).toBe("memmy-search-test");
        return jsonResponse({
          results: [{ title: "OpenClaw", url: "https://openclaw.io", content: "Framework" }],
        });
      }),
    );

    const result = await tool({
      provider: "tavily",
      apiKey: "tavily-key",
      userAgent: "memmy-search-test",
    }).execute({
      query: "openclaw",
    });

    expect(result).toContain("OpenClaw");
    expect(result).toContain("https://openclaw.io");
  });

  it("formats SearXNG search results", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toContain("searx.example");
        expect((init.headers as Record<string, string>)["User-Agent"]).toBe("memmy-search-test");
        return jsonResponse({
          results: [{ title: "Result", url: "https://example.com", content: "SearXNG result" }],
        });
      }),
    );

    const result = await tool({
      provider: "searxng",
      baseUrl: "https://searx.example",
      userAgent: "memmy-search-test",
    }).execute({ query: "test" });

    expect(result).toContain("Result");
  });

  it("formats DuckDuckGo HTML results", async () => {
    stubDuckDuckGo([
      {
        title: "DuckDuckGo Result",
        url: "https://example.com/ddg",
        snippet: "No-key HTML search",
      },
    ]);

    const result = await tool({ provider: "duckduckgo" }).execute({ query: "hello" });

    expect(result).toContain("DuckDuckGo Result");
    expect(result).toContain("https://example.com/ddg");
    expect(result).toContain("No-key HTML search");
  });

  it("falls back to DuckDuckGo Lite when the primary HTML endpoint is challenged", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url.includes("html.duckduckgo.com")) return htmlResponse("<form id='challenge-form'></form>", 202);
        return htmlResponse(duckDuckGoLiteHtml());
      }),
    );

    const result = await tool({ provider: "duckduckgo" }).execute({ query: "hello" });

    expect(calls[0]).toContain("html.duckduckgo.com");
    expect(calls[1]).toContain("lite.duckduckgo.com");
    expect(result).toContain("Lite Result");
    expect(result).toContain("https://example.com/lite");
  });

  it("returns an error when DuckDuckGo search times out", async () => {
    const search = tool({ provider: "duckduckgo" });
    search.config.timeout = 0.01;
    search.duckduckgoText = vi.fn(async () => new Promise<Array<Record<string, string>>>(() => {}));

    const result = await search.execute({ query: "test" });

    expect(result).toContain("Error");
    expect(result).toContain("DuckDuckGo search failed");
  });

  it("falls back to DuckDuckGo when Brave has no key", async () => {
    stubDuckDuckGo();

    const result = await tool({ provider: "brave", apiKey: "" }).execute({ query: "test" });

    expect(result).toContain("Duck Result");
  });

  it("formats Jina search results", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toBe("https://s.jina.ai/test");
        expect((init.headers as Record<string, string>).Authorization).toBe("Bearer jina-key");
        expect((init.headers as Record<string, string>)["User-Agent"]).toBe("memmy-search-test");
        return jsonResponse({
          data: [{ title: "Jina Result", url: "https://jina.ai", content: "AI search" }],
        });
      }),
    );

    const result = await tool({
      provider: "jina",
      apiKey: "jina-key",
      userAgent: "memmy-search-test",
    }).execute({
      query: "test",
    });

    expect(result).toContain("Jina Result");
    expect(result).toContain("https://jina.ai");
  });

  it("path-encodes Jina search queries", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return jsonResponse({
          data: [{ title: "Jina Result", url: "https://jina.ai", content: "AI search" }],
        });
      }),
    );

    await tool({ provider: "jina", apiKey: "jina-key" }).execute({ query: "hello world" });

    expect(calls[0]).toBe("https://s.jina.ai/hello%20world");
  });

  it("falls back to DuckDuckGo when Jina search fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith("https://s.jina.ai/")) return jsonResponse({ error: "unprocessable" }, 422);
        return htmlResponse(duckDuckGoHtml());
      }),
    );

    const result = await tool({ provider: "jina", apiKey: "jina-key" }).execute({ query: "test" });

    expect(result).toContain("Duck Result");
  });

  it("formats Kagi search results", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toContain("kagi.com/api/v1/search");
        expect(init.method).toBe("POST");
        expect((init.headers as Record<string, string>).Authorization).toBe("Bearer kagi-key");
        expect((init.headers as Record<string, string>)["User-Agent"]).toBe("memmy-search-test");
        expect(JSON.parse(String(init.body))).toEqual({ query: "test", limit: 2 });
        return jsonResponse({
          data: {
            search: [{ title: "Kagi Result", url: "https://kagi.com", snippet: "Premium search" }],
            related_search: [{ title: "ignored related search", url: "", snippet: "" }],
          },
        });
      }),
    );

    const result = await tool({
      provider: "kagi",
      apiKey: "kagi-key",
      userAgent: "memmy-search-test",
    }).execute({
      query: "test",
      count: 2,
    });

    expect(result).toContain("Kagi Result");
    expect(result).toContain("https://kagi.com");
    expect(result).not.toContain("ignored related search");
  });

  it("falls back to DuckDuckGo when Kagi has no key", async () => {
    stubDuckDuckGo();

    const result = await tool({ provider: "kagi", apiKey: "" }).execute({ query: "test" });

    expect(result).toContain("Duck Result");
  });

  it("formats Olostep answers and sources", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toBe("https://api.olostep.com/v1/answers");
        expect((init.headers as Record<string, string>).Authorization).toBe("Bearer olostep-key");
        expect(JSON.parse(String(init.body))).toEqual({ task: "test query" });
        return jsonResponse({
          answer: "Mocked Olostep answer",
          sources: [{ title: "Example Source", url: "https://example.com" }],
        });
      }),
    );

    const result = await tool({ provider: "olostep", apiKey: "olostep-key" }).execute({
      query: "test query",
    });

    expect(result).toContain("Mocked Olostep answer");
    expect(result).toContain("Example Source");
    expect(result).toContain("https://example.com");
  });

  it("reports Olostep search errors clearly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("olostep package not installed");
      }),
    );

    const result = await tool({ provider: "olostep", apiKey: "olostep-key" }).execute({
      query: "test query",
    });

    expect(result).toContain("Olostep search error");
    expect(result).toContain("olostep package not installed");
  });

  it("falls back to DuckDuckGo when Olostep has no key", async () => {
    stubDuckDuckGo();

    const result = await tool({ provider: "olostep", apiKey: "" }).execute({ query: "test" });

    expect(result).toContain("Duck Result");
  });

  it("reports unknown providers", async () => {
    const result = await tool({ provider: "unknown" }).execute({ query: "test" });

    expect(result).toContain("unknown");
    expect(result).toContain("Error");
  });

  it("uses Brave as the default provider", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toContain("brave");
        return jsonResponse({ web: { results: [] } });
      }),
    );

    const result = await tool({ provider: "", apiKey: "test-key" }).execute({ query: "test" });

    expect(result).toContain("No results");
  });

  it("falls back to DuckDuckGo when SearXNG has no base URL", async () => {
    stubDuckDuckGo();

    const result = await tool({ provider: "searxng", baseUrl: "" }).execute({ query: "test" });

    expect(result).toContain("Duck Result");
  });

  it("reports invalid SearXNG base URLs", async () => {
    const result = await tool({ provider: "searxng", baseUrl: "not-a-url" }).execute({
      query: "test",
    });

    expect(result).toContain("Error");
  });
});
