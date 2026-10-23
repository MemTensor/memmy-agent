import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSearchTool, WebFetchTool } from "../../../../src/core/agent-runtime/tools/web.js";
import { WebSearchConfig, WebFetchConfig } from "../../../../src/config/schema.js";
import { checkWebStatus, webFailure } from "../../../../src/core/agent-runtime/tools/web-request.js";

afterEach(() => vi.unstubAllGlobals());
describe("real request cancellation", () => {
  it.each([false, true])("closes the server connection on timeout (body stalled=%s)", async (body) => {
    let close!: () => void;
    const closed = new Promise<void>((resolve) => { close = resolve; });
    const server = createServer((_req, res) => {
      res.once("close", close);
      if (body) { res.writeHead(200, { "content-type": "application/json" }); res.write('{"results":'); }
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    try {
      const port = (server.address() as { port: number }).port;
      const tool = new WebSearchTool(new WebSearchConfig({ provider: "searxng", baseUrl: `http://127.0.0.1:${port}`, timeout: 0.2 }));
      expect(await tool.execute({ query: "one" })).toContain("timeout");
      await Promise.race([closed, new Promise((_resolve, reject) => { const timer = setTimeout(() => reject(new Error("connection not closed")), 2000); timer.unref(); })]);
      expect(await tool.execute({ query: "different" })).toContain("cooldown");
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});

describe("web fetch cancellation", () => {
  it("applies timeoutS to preflight and does not start reader fallback", async () => {
    let signal: AbortSignal | undefined;
    const mock = vi.fn((_url: string, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
    });
    vi.stubGlobal("fetch", mock);
    const result = await new WebFetchTool(new WebFetchConfig({ timeoutS: 0.02 })).execute({ url: "https://93.184.216.34/page" });
    expect(result).toContain("timeout");
    expect(signal?.aborted).toBe(true);
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it("does not start network requests for a cancelled fetch", async () => {
    const controller = new AbortController(); controller.abort();
    const mock = vi.fn(); vi.stubGlobal("fetch", mock);
    expect(await new WebFetchTool().execute({ url: "https://93.184.216.34/page" }, { abortSignal: controller.signal })).toContain("cancelled");
    expect(mock).not.toHaveBeenCalled();
  });
  it("preserves safe nested aggregate codes without arbitrary error text", () => {
    const error = webFailure(new TypeError("private", { cause: new AggregateError([Object.assign(new Error("secret"), { code: "ECONNREFUSED" }), Object.assign(new Error(), { code: "ENETUNREACH" })]) }));
    expect(error.code).toBe("ECONNREFUSED,ENETUNREACH");
    expect(error.phase).toBe("connect");
    expect(error.message).not.toContain("secret");
  });
  it("parses a Retry-After HTTP date", () => {
    const date = new Date(Date.now() + 120_000).toUTCString();
    try { checkWebStatus(new Response("", { status: 429, headers: { "retry-after": date } })); }
    catch (error) { expect(webFailure(error).retryAfterMs).toBeGreaterThan(118_000); return; }
    throw new Error("expected rate limit failure");
  });
});
