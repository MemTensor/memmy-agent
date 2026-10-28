import { createHash } from "node:crypto";
import { WebFailure, webFailure, formatWebFailure, withWebDeadline, webRequest, readWebBody, checkWebStatus, SearchHealth } from "./web-request.js";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { loadConfig, resolveConfigEnvVars } from "../../../config/loader.js";
import { WebFetchConfig, WebSearchConfig } from "../../../config/schema.js";
import { validateUrlTarget } from "../../../security/network.js";
import { buildImageContentBlocks, boundedHeadTail, EXTERNAL_CONTENT_BANNER } from "../../../utils/helpers.js";
import { Tool, type ToolExecutionContext } from "./base.js";

const DEFAULT_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36";
const DUCKDUCKGO_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15";
const DUCKDUCKGO_HTML_ENDPOINT = "https://html.duckduckgo.com/html/";
const DUCKDUCKGO_LITE_ENDPOINT = "https://lite.duckduckgo.com/lite/";
const MAX_REDIRECTS = 5;
const UNTRUSTED_BANNER = EXTERNAL_CONTENT_BANNER;
const TURNDOWN = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

type SearchParams = { query?: string; count?: number; max_results?: number; maxResults?: number };
type FetchParams = {
  url?: string;
  extractMode?: "markdown" | "text";
  extract_mode?: "markdown" | "text";
  maxChars?: number;
  max_chars?: number;
};

type WebFetchTextResult = {
  url: string;
  finalUrl: string;
  status: number;
  contentType?: string;
  extractor: string;
  text: string;
  suffix?: "json" | "txt";
  maxChars: number;
  context?: ToolExecutionContext;
};

function formatWebFetchTextResult(input: WebFetchTextResult): string {
  if (input.context?.formatTextResult) {
    return input.context.formatTextResult(input.text, {
      source: input.finalUrl,
      contentType: input.contentType,
      suffix: input.suffix ?? "txt",
      maxChars: input.maxChars,
    });
  }
  // Standalone callers have no workspace/Runner. Preserve the raw text inside the
  // legacy envelope, but never claim a full file was saved.
  const preview = boundedHeadTail(input.text, input.maxChars);
  return JSON.stringify({
    url: input.url, finalUrl: input.finalUrl, status: input.status,
    content_type: input.contentType, extractor: input.extractor,
    truncated: preview !== input.text, untrusted: true,
    full_content_saved: false, saved_content_complete: null,
    content_complete: preview === input.text,
    text: `${UNTRUSTED_BANNER}\n\n${preview}`,
  });
}

export class WebToolsConfig {
  enable = true;
  proxy: string | null = null;
  userAgent: string | null = null;
  search: WebSearchConfig;
  fetch: WebFetchConfig;

  constructor(init: Record<string, any> = {}) {
    this.enable = init.enable ?? init.enabled ?? true;
    this.proxy = init.proxy ?? null;
    this.userAgent = init.userAgent ?? null;
    this.search =
      init.search instanceof WebSearchConfig ? init.search : new WebSearchConfig(init.search ?? {});
    this.fetch =
      init.fetch instanceof WebFetchConfig ? init.fetch : new WebFetchConfig(init.fetch ?? {});
  }
}

export function stripTags(text: string): string {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

export function normalize(text: string): string {
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&nbsp;/g, " ")
    .replace(/&ndash;/g, "-")
    .replace(/&mdash;/g, "--")
    .replace(/&hellip;/g, "...")
    .replace(/&#(\d+);/g, (_match, code) => {
      try {
        return String.fromCodePoint(Number(code));
      } catch {
        return "";
      }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => {
      try {
        return String.fromCodePoint(Number.parseInt(code, 16));
      } catch {
        return "";
      }
    });
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function readHtmlAttribute(tagAttributes: string, name: string): string {
  const match = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i").exec(tagAttributes);
  return match?.[2] ?? "";
}

export function decodeDuckDuckGoUrl(rawUrl: string): string {
  try {
    const normalized = rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl;
    const parsed = new URL(normalized, "https://duckduckgo.com");
    const uddg = parsed.searchParams.get("uddg");
    if (uddg) return uddg;
  } catch {
    // Direct result links are already usable.
  }
  return rawUrl;
}

export function isDuckDuckGoBotChallenge(html: string): boolean {
  if (/\bclass\s*=\s*["'][^"']*\bresult__(?:a|snippet)\b[^"']*["']/i.test(html)) return false;
  if (/\bclass\s*=\s*["'][^"']*\bresult-(?:link|snippet)\b[^"']*["']/i.test(html)) return false;
  return /g-recaptcha|are you a human|id\s*=\s*["']challenge-form["']|name\s*=\s*["']challenge["']/i.test(html);
}

export function parseDuckDuckGoHtml(html: string): Array<Record<string, string>> {
  const results: Array<Record<string, string>> = [];
  const selectors = [
    {
      resultRegex:
        /<a\b(?=[^>]*\bclass\s*=\s*["'][^"']*\bresult__a\b[^"']*["'])([^>]*)>([\s\S]*?)<\/a>/gi,
      nextResultRegex:
        /<a\b(?=[^>]*\bclass\s*=\s*["'][^"']*\bresult__a\b[^"']*["'])[^>]*>/i,
      snippetRegex:
        /<(?:a|div|span)\b(?=[^>]*\bclass\s*=\s*["'][^"']*\bresult__snippet\b[^"']*["'])[^>]*>([\s\S]*?)<\/(?:a|div|span)>/i,
    },
    {
      resultRegex:
        /<a\b(?=[^>]*\bclass\s*=\s*["'][^"']*\bresult-link\b[^"']*["'])([^>]*)>([\s\S]*?)<\/a>/gi,
      nextResultRegex:
        /<a\b(?=[^>]*\bclass\s*=\s*["'][^"']*\bresult-link\b[^"']*["'])[^>]*>/i,
      snippetRegex:
        /<(?:td|a|div|span)\b(?=[^>]*\bclass\s*=\s*["'][^"']*\bresult-snippet\b[^"']*["'])[^>]*>([\s\S]*?)<\/(?:td|a|div|span)>/i,
    },
  ];

  for (const selector of selectors) {
    for (const match of html.matchAll(selector.resultRegex)) {
      const rawAttributes = match[1] ?? "";
      const rawTitle = match[2] ?? "";
      const rawUrl = readHtmlAttribute(rawAttributes, "href");
      const matchEnd = (match.index ?? 0) + match[0].length;
      const trailingHtml = html.slice(matchEnd);
      const nextResultIndex = trailingHtml.search(selector.nextResultRegex);
      const scopedTrailingHtml =
        nextResultIndex >= 0 ? trailingHtml.slice(0, nextResultIndex) : trailingHtml;
      const rawSnippet = selector.snippetRegex.exec(scopedTrailingHtml)?.[1] ?? "";

      const title = decodeHtmlEntities(stripHtml(rawTitle));
      const url = decodeDuckDuckGoUrl(decodeHtmlEntities(rawUrl));
      const body = decodeHtmlEntities(stripHtml(rawSnippet));
      if (title && url) results.push({ title, href: url, body });
    }
    if (results.length) break;
  }

  return results;
}

function cleanUrl(raw: string): string {
  let value = raw.trim();
  let changed = true;
  while (changed && value.length >= 2) {
    changed = false;
    const first = value[0];
    const last = value[value.length - 1];
    if (
      (first === "`" && last === "`") ||
      (first === `"` && last === `"`) ||
      (first === `'` && last === `'`)
    ) {
      value = value.slice(1, -1).trim();
      changed = true;
    }
  }
  return value;
}

export function validateUrl(url: string): [boolean, string] {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return [
        false,
        `Only http/https allowed, got '${parsed.protocol.replace(/:$/, "") || "none"}'`,
      ];
    }
    if (!parsed.hostname) return [false, "Missing domain"];
    return [true, ""];
  } catch (err) {
    return [false, err instanceof Error ? err.message : String(err)];
  }
}

export async function validateUrlSafe(url: string): Promise<[boolean, string]> {
  return validateUrlTarget(url);
}

export async function getWithSafeRedirects(
  url: string,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<[Response | null, string | null]> {
  let current = url;
  for (let i = 0; i <= MAX_REDIRECTS; i += 1) {
    signal?.throwIfAborted();
    const [ok, error] = await validateUrlSafe(current);
    signal?.throwIfAborted();
    if (!ok) return [null, `Redirect blocked: ${error}`];

    const response = await webRequest(current, { headers, redirect: "manual", signal });
    if (response.status < 300 || response.status >= 400) return [response, null];

    const location = response.headers.get("location");
    if (!location) return [response, null];

    await response.body?.cancel().catch(() => {});
    const next = new URL(location, response.url || current).toString();
    const [nextOk, nextError] = await validateUrlSafe(next);
    if (!nextOk) return [null, `Redirect blocked: ${nextError}`];
    current = next;
  }
  return [null, `Too many redirects: exceeded limit of ${MAX_REDIRECTS}`];
}

export async function streamWithSafeRedirects(
  url: string,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<[Response | null, null, string | null]> {
  const [response, error] = await getWithSafeRedirects(url, headers, signal);
  return [response, null, error];
}

export function formatResults(query: string, items: Array<Record<string, any>>, n: number): string {
  if (!items.length) return `No results for: ${query}`;
  const lines = [`Results for: ${query}\n`];
  items.slice(0, n).forEach((item, index) => {
    const title = normalize(stripTags(String(item.title ?? "")));
    const url = String(item.url ?? item.href ?? "");
    const snippet = normalize(
      stripTags(String(item.content ?? item.description ?? item.body ?? item.snippet ?? "")),
    );
    lines.push(`${index + 1}. ${title}\n   ${url}`);
    if (snippet) lines.push(`   ${snippet}`);
  });
  return lines.join("\n");
}

export function toMarkdown(htmlContent: string): string {
  let text = htmlContent.replace(
    /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (match, href, body) => {
      void match;
      return `[${stripTags(String(body))}](${href})`;
    },
  );
  text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (match, level, body) => {
    void match;
    return `\n${"#".repeat(Number(level))} ${stripTags(String(body))}\n`;
  });
  text = text.replace(
    /<li[^>]*>([\s\S]*?)<\/li>/gi,
    (match, body) => {
      void match;
      return `\n- ${stripTags(String(body))}`;
    },
  );
  text = text.replace(/<\/(p|div|section|article)>/gi, "\n\n");
  text = text.replace(/<(br|hr)\s*\/?>/gi, "\n");
  return normalize(stripTags(text));
}

function htmlLooksLikeDocument(contentType: string, rawText: string): boolean {
  const prefix = rawText.slice(0, 512).trimStart().toLowerCase();
  return (
    contentType.includes("text/html") ||
    prefix.startsWith("<!doctype") ||
    prefix.startsWith("<html") ||
    /<body[\s>]/i.test(rawText.slice(0, 2048))
  );
}

function htmlTitle(rawText: string): string {
  return stripTags(rawText.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
}

function basicHtmlCleanup(rawText: string, extractMode: string): { text: string; title: string } {
  const title = htmlTitle(rawText);
  const body = extractMode === "markdown" ? toMarkdown(rawText) : stripTags(rawText);
  return { text: title ? `# ${title}\n\n${body}` : body, title };
}

function extractReadableHtml(
  rawText: string,
  extractMode: string,
): { text: string; title: string; extractor: "readability" | "raw-html" } {
  try {
    const { document } = parseHTML(rawText);
    const parsed = new Readability(document as any, { charThreshold: 0 }).parse();
    if (parsed && (parsed.content || parsed.textContent)) {
      const title = stripTags(parsed.title ?? "") || htmlTitle(rawText);
      const body =
        extractMode === "markdown"
          ? normalize(TURNDOWN.turndown(parsed.content ?? ""))
          : normalize(parsed.textContent ?? stripTags(parsed.content ?? ""));
      return { text: title ? `# ${title}\n\n${body}` : body, title, extractor: "readability" };
    }
  } catch {
    // Fall back to deterministic HTML cleanup below.
  }
  const fallback = basicHtmlCleanup(rawText, extractMode);
  return { ...fallback, extractor: "raw-html" };
}

async function responseJson(response: Response, signal?: AbortSignal): Promise<any> {
  const text = await readWebBody<string>(response, "text", signal);
  try { return text ? JSON.parse(text) : {}; }
  catch (cause) { throw new WebFailure("parse", "Invalid JSON response", "parse", undefined, 0, { cause }); }
}

function searchItems(value: unknown): Array<Record<string, any>> {
  if (!Array.isArray(value) || value.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
    throw new WebFailure("parse", "Unrecognized search response", "parse");
  }
  return value;
}

async function requestJson(url: string, init: RequestInit = {}): Promise<any> {
  const response = await webRequest(url, init);
  try {
    checkWebStatus(response);
    return await responseJson(response, init.signal ?? undefined);
  } finally { await response.body?.cancel().catch(() => {}); }
}

export class WebSearchTool extends Tool {
  static configKey = "web";
  private health = new SearchHealth();
  config: WebSearchConfig;
  configLoader?: (() => WebSearchConfig) | undefined;
  proxy?: string | null;
  userAgent: string;

  constructor(
    init:
      | WebSearchConfig
      | {
          config?: WebSearchConfig;
          configLoader?: () => WebSearchConfig;
          proxy?: string | null;
          userAgent?: string | null;
        }
      | null = {},
  ) {
    super();
    const opts = init instanceof WebSearchConfig ? { config: init } : (init ?? {});
    this.config =
      opts.config instanceof WebSearchConfig ? opts.config : new WebSearchConfig(opts.config ?? {});
    this.configLoader = opts.configLoader;
    this.proxy = opts.proxy ?? null;
    this.userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
  }

  static configCls(): typeof WebToolsConfig {
    return WebToolsConfig;
  }

  static enabled(ctx: any): boolean {
    const web = ctx?.config?.web;
    const search =
      ctx?.config?.webSearch ??
      ctx?.config?.tools?.webSearch;
    return web?.enable ?? web?.enabled ?? search?.enable ?? search?.enabled ?? true;
  }

  static create(ctx: any): Tool {
    const rawWeb = ctx?.config?.web;
    const web = rawWeb instanceof WebToolsConfig ? rawWeb : new WebToolsConfig(rawWeb ?? {});
    const tools = ctx?.config?.tools ?? ctx?.config ?? {};
    const rawConfig = rawWeb ? web.search : (tools.webSearch ?? web.search);
    const config =
      rawConfig instanceof WebSearchConfig ? rawConfig : new WebSearchConfig(rawConfig);
    const configLoader =
      ctx?.providerSnapshotLoader
        ? () => resolveConfigEnvVars(loadConfig()).tools.webSearch
        : undefined;
    return new WebSearchTool({
      config,
      proxy: web.proxy ?? null,
      userAgent: web.userAgent ?? null,
      configLoader,
    });
  }

  get name(): string {
    return "web_search";
  }

  get description(): string {
    return (
      "Search the web. Returns titles, URLs, and snippets. count defaults to 5 (max 10). " +
      "Use web_fetch to read a specific page in full. On service errors, respect retry-after/cooldown; changing keywords cannot fix a network failure. If no configured service is available, explain the limitation instead of repeating searches."
    );
  }

  get readOnly(): boolean {
    return true;
  }

  get exclusive(): boolean {
    return this.effectiveProvider() === "duckduckgo" || this.config.fallbackProviders.some((provider) => provider.trim().toLowerCase() === "duckduckgo");
  }

  get parameters() {
    return {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        count: { type: "integer", description: "Results (1-10)", minimum: 1, maximum: 10 },
      },
      required: ["query"],
    };
  }

  refreshConfig(): void {
    if (!this.configLoader) return;
    try {
      this.config = this.configLoader();
    } catch {
      // Keep the last known-good config if hot reload fails.
    }
  }

  effectiveProvider(): string {
    this.refreshConfig();
    return String(this.config.provider || "brave").trim().toLowerCase();
  }

  async execute(params: SearchParams | string = {}, context?: ToolExecutionContext): Promise<string> {
    this.refreshConfig();
    const query = typeof params === "string" ? params : params.query;
    if (!query) return "Error: missing query";
    const n = Math.min(Math.max(typeof params === "string" ? this.config.maxResults : (params.count ?? params.max_results ?? params.maxResults ?? this.config.maxResults), 1), 10);
    // Snapshot configuration so concurrent calls/hot reload cannot mix credentials or health keys.
    const config = new WebSearchConfig(this.config);
    const primary = String(config.provider || "brave").trim().toLowerCase();
    const providers = [...new Set([primary, ...config.fallbackProviders.map((p) => p.trim().toLowerCase())])];
    try {
      return await withWebDeadline(config.timeout, context?.abortSignal, async (signal) => {
        const failures: string[] = [];
        for (const provider of providers) {
          signal.throwIfAborted();
          const worker = new WebSearchTool({ config: new WebSearchConfig({ ...config, provider,
            apiKey: provider === primary ? config.apiKey : "",
            baseUrl: provider === primary ? config.baseUrl : "",
          }), userAgent: this.userAgent, proxy: this.proxy });
          // Capture environment configuration once per attempt, never use the primary's key for a fallback.
          worker.config.apiKey ||= process.env[`${provider.toUpperCase()}_API_KEY`] || "";
          if (provider === "searxng") worker.config.baseUrl ||= process.env.SEARXNG_BASE_URL || "";
          const key = createHash("sha256").update(JSON.stringify([provider, worker.config.baseUrl, worker.config.apiKey])).digest("hex");
          try {
            const methods: Record<string, (q: string, n: number, signal?: AbortSignal) => Promise<string>> = {
              duckduckgo: worker.searchDuckduckgo, brave: worker.searchBrave, tavily: worker.searchTavily,
              searxng: worker.searchSearxng, jina: worker.searchJina, kagi: worker.searchKagi, olostep: worker.searchOlostep,
            };
            if (!methods[provider]) throw new WebFailure("configuration", "Unknown search provider", "configuration");
            if (provider !== "duckduckgo" && !(provider === "searxng" ? worker.config.baseUrl.trim() : worker.config.apiKey)) {
              throw new WebFailure("configuration", "Missing search credentials or endpoint", "configuration");
            }
            return await this.health.run(key, signal, () => methods[provider].call(worker, query, n, signal));
          } catch (error) {
            if (signal.aborted) throw signal.reason;
            failures.push(formatWebFailure(provider, error));
          }
        }
        return failures.join("\n");
      });
    } catch (error) { return formatWebFailure(primary, error); }
  }

  async searchDuckduckgo(query: string, n: number, signal?: AbortSignal): Promise<string> {
    const raw = await this.duckduckgoText(query, n, signal);
    return formatResults(query, raw, n);
  }

  async duckduckgoText(query: string, n: number, signal?: AbortSignal): Promise<Array<Record<string, string>>> {
    const endpoints = [DUCKDUCKGO_HTML_ENDPOINT, DUCKDUCKGO_LITE_ENDPOINT];
    for (const [index, endpoint] of endpoints.entries()) {
      signal?.throwIfAborted();
      const url = new URL(endpoint);
      url.searchParams.set("q", query);
      url.searchParams.set("kp", "-1");
      const response = await webRequest(url.toString(), {
        signal, method: "GET",
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent": this.userAgent === DEFAULT_USER_AGENT ? DUCKDUCKGO_USER_AGENT : this.userAgent,
        },
      });
      try {
        if (response.status === 202) throw new WebFailure("challenge", "Search blocked by bot-detection challenge", "response", "HTTP_202");
        checkWebStatus(response);
        const html = await readWebBody<string>(response, "text", signal);
        if (isDuckDuckGoBotChallenge(html)) throw new WebFailure("challenge", "Search blocked by bot-detection challenge", "parse");
        const items = parseDuckDuckGoHtml(html).slice(0, n);
        if (!items.length && !/class=["'][^"']*no-results|no results (?:found|for)|no more results/i.test(html)) {
          throw new WebFailure("parse", "Unrecognized search response; cannot determine whether results are empty", "parse");
        }
        return items;
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        const failure = webFailure(error);
        // Only an endpoint-specific challenge/format issue warrants a Lite attempt.
        if (index === 0 && ["challenge", "parse"].includes(failure.category)) continue;
        throw failure;
      } finally { await response.body?.cancel().catch(() => {}); }
    }
    throw new WebFailure("parse", "No usable search response", "parse");
  }

  async searchBrave(query: string, n: number, signal?: AbortSignal): Promise<string> {
    const apiKey = this.config.apiKey || process.env.BRAVE_API_KEY || "";
    if (!apiKey) throw new WebFailure("configuration", "Missing API key", "configuration");
      const data = await requestJson(
        `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${n}`,
        {
          signal, headers: {
            Accept: "application/json",
            "X-Subscription-Token": apiKey,
            "User-Agent": this.userAgent,
          },
        },
      );
      return formatResults(query, searchItems(data.web?.results), n);
  }

  async searchTavily(query: string, n: number, signal?: AbortSignal): Promise<string> {
    const apiKey = this.config.apiKey || process.env.TAVILY_API_KEY || "";
    if (!apiKey) throw new WebFailure("configuration", "Missing API key", "configuration");
      const data = await requestJson("https://api.tavily.com/search", {
        method: "POST",
        signal, headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "User-Agent": this.userAgent,
        },
        body: JSON.stringify({ query, max_results: n }),
      });
      return formatResults(query, searchItems(data.results), n);
  }

  async searchSearxng(query: string, n: number, signal?: AbortSignal): Promise<string> {
    const baseUrl = (this.config.baseUrl || process.env.SEARXNG_BASE_URL || "").trim();
    if (!baseUrl) throw new WebFailure("configuration", "Missing endpoint", "configuration");
    const endpoint = `${baseUrl.replace(/\/+$/, "")}/search`;
    const [isValid, error] = validateUrl(endpoint);
    if (!isValid) throw new WebFailure("configuration", `Invalid SearXNG URL: ${error}`, "configuration");
      const data = await requestJson(`${endpoint}?q=${encodeURIComponent(query)}&format=json`, {
        signal, headers: { "User-Agent": this.userAgent },
      });
      return formatResults(query, searchItems(data.results), n);
  }

  async searchJina(query: string, n: number, signal?: AbortSignal): Promise<string> {
    const apiKey = this.config.apiKey || process.env.JINA_API_KEY || "";
    if (!apiKey) throw new WebFailure("configuration", "Missing API key", "configuration");
      const encoded = encodeURIComponent(query);
      const data = await requestJson(`https://s.jina.ai/${encoded}`, {
        signal, headers: {
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`,
          "User-Agent": this.userAgent,
        },
      });
      const items = searchItems(data.data).slice(0, n).map((item: Record<string, any>) => ({
        title: item.title ?? "",
        url: item.url ?? "",
        content: String(item.content ?? "").slice(0, 500),
      }));
      return formatResults(query, items, n);
  }

  async searchKagi(query: string, n: number, signal?: AbortSignal): Promise<string> {
    const apiKey = this.config.apiKey || process.env.KAGI_API_KEY || "";
    if (!apiKey) throw new WebFailure("configuration", "Missing API key", "configuration");
      const data = await requestJson("https://kagi.com/api/v1/search", {
        method: "POST",
        signal, headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "User-Agent": this.userAgent,
        },
        body: JSON.stringify({ query, limit: n }),
      });
      const items = searchItems(data.data?.search).map((item: Record<string, any>) => ({
        title: item.title ?? "",
        url: item.url ?? "",
        content: item.snippet ?? "",
      }));
      return formatResults(query, items, n);
  }

  async searchOlostep(query: string, n: number, signal?: AbortSignal): Promise<string> {
    const apiKey = this.config.apiKey || process.env.OLOSTEP_API_KEY || "";
    if (!apiKey) throw new WebFailure("configuration", "Missing API key", "configuration");
      const data = await requestJson("https://api.olostep.com/v1/answers", {
        method: "POST",
        signal, headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "User-Agent": this.userAgent,
        },
        body: JSON.stringify({ task: query }),
      });
      const sources = Array.isArray(data.sources) ? data.sources : [];
      const sourceLines = sources.slice(0, n).map((source: Record<string, any>, index: number) => {
        const title = source.title ?? "";
        const url = source.url ?? "";
        if (title && url) return `${index + 1}. ${title} - ${url}`;
        if (url) return `${index + 1}. ${url}`;
        return `${index + 1}. ${title}`;
      });
      return formatResults(
        query,
        [{ title: data.answer || "Olostep answer", url: "", content: sourceLines.join("\n") }],
        n,
      );
  }
}

export class WebFetchTool extends Tool {
  static configKey = "web";
  config: WebFetchConfig;
  proxy?: string | null;
  userAgent: string;
  maxChars: number;

  constructor(
    init:
      | WebFetchConfig
      | {
          config?: WebFetchConfig;
          proxy?: string | null;
          userAgent?: string | null;
          maxChars?: number;
        }
      | null = {},
  ) {
    super();
    const opts = init instanceof WebFetchConfig ? { config: init } : (init ?? {});
    this.config =
      opts.config instanceof WebFetchConfig ? opts.config : new WebFetchConfig(opts.config ?? {});
    this.proxy = opts.proxy ?? null;
    this.userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
    this.maxChars = opts.maxChars ?? this.config.maxChars;
  }

  static configCls(): typeof WebToolsConfig {
    return WebToolsConfig;
  }

  static enabled(ctx: any): boolean {
    const web = ctx?.config?.web;
    const fetchConfig =
      ctx?.config?.webFetch ??
      ctx?.config?.tools?.webFetch;
    return web?.enable ?? web?.enabled ?? fetchConfig?.enable ?? fetchConfig?.enabled ?? true;
  }

  static create(ctx: any): Tool {
    const rawWeb = ctx?.config?.web;
    const web = rawWeb instanceof WebToolsConfig ? rawWeb : new WebToolsConfig(rawWeb ?? {});
    const tools = ctx?.config?.tools ?? ctx?.config ?? {};
    const rawConfig = rawWeb ? web.fetch : (tools.webFetch ?? web.fetch);
    const config = rawConfig instanceof WebFetchConfig ? rawConfig : new WebFetchConfig(rawConfig);
    return new WebFetchTool({
      config,
      proxy: web.proxy ?? null,
      userAgent: web.userAgent ?? null,
    });
  }

  get name(): string {
    return "web_fetch";
  }

  get description(): string {
    return (
      "Fetch a URL and extract readable content (HTML to markdown/text). " +
      "Output is capped at maxChars. Works for most web pages and docs; may fail on login-walled or JS-heavy sites."
    );
  }

  get readOnly(): boolean {
    return true;
  }

  get parameters() {
    return {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch" },
        extractMode: { type: "string", enum: ["markdown", "text"], default: "markdown" },
        maxChars: { type: "integer", minimum: 100 },
      },
      required: ["url"],
    };
  }

  async execute(params: FetchParams | string = {}, context?: ToolExecutionContext): Promise<any> {
    try {
      return await withWebDeadline(this.config.timeoutS, context?.abortSignal, (signal) =>
        this.executeRequest(params, { ...context, abortSignal: signal }));
    } catch (error) { return formatWebFailure("web_fetch", error); }
  }

  private async executeRequest(params: FetchParams | string, context: ToolExecutionContext): Promise<any> {
    const signal = context.abortSignal ?? undefined;
    const rawUrl = typeof params === "string" ? params : params.url;
    if (!rawUrl) return JSON.stringify({ error: "missing url" });
    const url = cleanUrl(rawUrl);
    const extractMode =
      typeof params === "string"
        ? "markdown"
        : (params.extractMode ?? params.extract_mode ?? "markdown");
    const maxChars =
      typeof params === "string"
        ? this.maxChars
        : (params.maxChars ?? params.max_chars ?? this.maxChars);

    const [basicOk, basicError] = validateUrl(url);
    if (!basicOk) return JSON.stringify({ error: `URL validation failed: ${basicError}`, url });
    const [ok, err] = await validateUrlSafe(url);
    if (!ok) return JSON.stringify({ error: `URL validation failed: ${err}`, url });

    let directFailure: WebFailure | undefined;
    let preflight: Response | null = null;
    try {
      const [response, , redirectError] = await streamWithSafeRedirects(url, {
        "User-Agent": this.userAgent,
      }, signal);
      preflight = response;
      if (redirectError) return JSON.stringify({ error: redirectError, url });
      if (!response) return JSON.stringify({ error: "Fetch failed", url });
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.startsWith("image/")) {
        checkWebStatus(response);
        const raw = new Uint8Array(await readWebBody<ArrayBuffer>(response, "arrayBuffer", signal));
        return buildImageContentBlocks(raw, contentType, url, `(Image fetched from: ${url})`);
      }
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      directFailure = webFailure(error);
    } finally {
      await preflight?.body?.cancel().catch(() => {});
    }

    signal?.throwIfAborted();
    if (this.config.useJinaReader) {
      const result = await this.fetchJina(url, maxChars, context);
      if (result !== null) return result;
    }
    signal?.throwIfAborted();
    // Reader uses a different origin. Its failure must not cause a second
    // direct attempt when the preflight already proved direct access failed.
    if (directFailure) throw directFailure;
    return this.fetchReadability(url, extractMode, maxChars, context);
  }

  async fetchJina(
    url: string,
    maxChars: number,
    context?: ToolExecutionContext,
  ): Promise<string | null> {
    const signal = context?.abortSignal ?? undefined;
    let response: Response | null = null;
    try {
      const headers: Record<string, string> = {
        Accept: "application/json",
        "User-Agent": this.userAgent,
      };
      if (process.env.JINA_API_KEY) headers.Authorization = `Bearer ${process.env.JINA_API_KEY}`;
      response = await webRequest(`https://r.jina.ai/${url}`, { headers, signal });
      if (response.status === 429) return null;
      checkWebStatus(response);
      const data = (await responseJson(response, signal)).data ?? {};
      let text = String(data.content ?? "");
      if (!text) return null;
      if (data.title) text = `# ${data.title}\n\n${text}`;
      return formatWebFetchTextResult({
        url,
        finalUrl: data.url ?? url,
        status: response.status,
        extractor: "jina",
        text,
        maxChars,
        context,
      });
    } catch {
      if (signal?.aborted) throw signal.reason;
      return null;
    } finally {
      await response?.body?.cancel().catch(() => {});
    }
  }

  async fetchReadability(
    url: string,
    extractMode: string,
    maxChars: number,
    context?: ToolExecutionContext,
  ): Promise<any> {
    const signal = context?.abortSignal ?? undefined;
    let response: Response | null = null;
    try {
      const [fetchedResponse, redirectError] = await getWithSafeRedirects(url, {
        "User-Agent": this.userAgent,
      }, signal);
      response = fetchedResponse;
      if (redirectError) return JSON.stringify({ error: redirectError, url });
      if (!response) return JSON.stringify({ error: "Fetch failed", url });
      checkWebStatus(response);

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.startsWith("image/")) {
        const raw = new Uint8Array(await readWebBody<ArrayBuffer>(response, "arrayBuffer", signal));
        return buildImageContentBlocks(raw, contentType, url, `(Image fetched from: ${url})`);
      }

      let text: string;
      let extractor: string;
      if (contentType.includes("application/json")) {
        text = await readWebBody<string>(response, "text", signal);
        extractor = "json";
      } else {
        const rawText = await readWebBody<string>(response, "text", signal);
        if (
          htmlLooksLikeDocument(contentType, rawText)
        ) {
          const readable = extractReadableHtml(rawText, extractMode);
          text = readable.text;
          extractor = readable.extractor;
        } else {
          text = rawText;
          extractor = "raw";
        }
      }

      return formatWebFetchTextResult({
        url,
        finalUrl: response.url || url,
        status: response.status,
        contentType,
        extractor,
        text,
        suffix: extractor === "json" ? "json" : "txt",
        maxChars,
        context,
      });
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
      return formatWebFailure("web_fetch", err);
    } finally {
      await response?.body?.cancel().catch(() => {});
    }
  }

  toMarkdown(htmlContent: string): string {
    return toMarkdown(htmlContent);
  }
}
