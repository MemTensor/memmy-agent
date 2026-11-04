import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebFetchTool } from "../../../../src/core/agent-runtime/tools/web.js";
import { withWebDeadline } from "../../../../src/core/agent-runtime/tools/web-request.js";
import { WebFetchConfig } from "../../../../src/config/schema.js";

const target = "https://93.184.216.34/article";
const offline = () => new TypeError("fetch failed", { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) });
const readerBody = () => Response.json({ data: { content: "Reader recovered the article", title: "Article" } });
afterEach(() => vi.unstubAllGlobals());

describe("web_fetch direct failure recovery", () => {
  it("uses the enabled Reader after direct connection fails", async () => {
    const mock = vi.fn().mockRejectedValueOnce(offline()).mockResolvedValueOnce(readerBody());
    vi.stubGlobal("fetch", mock);
    const result = await new WebFetchTool().execute({ url: target });
    expect(result).toContain("Reader recovered the article");
    expect(mock).toHaveBeenCalledTimes(2);
    expect(mock.mock.calls[1][0]).toBe(`https://r.jina.ai/${target}`);
  });

  it("does not repeat direct access when Reader also fails", async () => {
    const mock = vi.fn().mockRejectedValueOnce(offline()).mockRejectedValueOnce(offline());
    vi.stubGlobal("fetch", mock);
    expect(await new WebFetchTool().execute({ url: target })).toContain("ECONNREFUSED");
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("does not use a disabled Reader or retry the failed origin", async () => {
    const mock = vi.fn().mockRejectedValue(offline());
    vi.stubGlobal("fetch", mock);
    const result = await new WebFetchTool(new WebFetchConfig({ useJinaReader: false })).execute({ url: target });
    expect(result).toContain("ECONNREFUSED");
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("keeps ordinary direct reading when Reader is unavailable", async () => {
    const mock = vi.fn()
      .mockResolvedValueOnce(new Response("preflight"))
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response("Direct readable article", { headers: { "content-type": "text/plain" } }));
    vi.stubGlobal("fetch", mock);
    expect(await new WebFetchTool().execute({ url: target })).toContain("Direct readable article");
    expect(mock).toHaveBeenCalledTimes(3);
  });

  it.each(["stop", "timeout"])("does not start Reader after %s during direct access", async (reason) => {
    const parent = new AbortController();
    const mock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      if (reason === "stop") parent.abort();
    }));
    vi.stubGlobal("fetch", mock);
    const tool = new WebFetchTool(new WebFetchConfig({ timeoutS: 0.03 }));
    const result = await tool.execute({ url: target }, { abortSignal: parent.signal });
    expect(result).toContain(reason === "stop" ? "cancelled" : "timeout");
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("does not start readability after Reader is cancelled", async () => {
    const parent = new AbortController();
    const mock = vi.fn().mockResolvedValueOnce(new Response("preflight"))
      .mockImplementationOnce((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
        parent.abort();
      }));
    vi.stubGlobal("fetch", mock);
    expect(await new WebFetchTool().execute({ url: target }, { abortSignal: parent.signal })).toContain("cancelled");
    expect(mock).toHaveBeenCalledTimes(2);
  });
});

describe("web_fetch releases HTTP error responses", () => {
  it.each([400, 503].flatMap((status) => ["text", "image", "reader"].map((route) => ({ status, route }))))("closes stalled $route HTTP $status bodies before the deadline", async ({ route, status }) => {
    const realFetch = globalThis.fetch;
    const responses: Array<{ closed: boolean }> = [];
    const server = createServer((req, res) => {
      const observed = { closed: false };
      responses.push(observed);
      res.once("close", () => { observed.closed = true; });
      if (route === "reader" && req.url === "/direct") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("preflight or fallback");
        return;
      }
      res.writeHead(status, { "content-type": route === "image" ? "image/png" : "text/plain" });
      res.write("unfinished error body");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const port = (server.address() as { port: number }).port;
      // Only transport is redirected to the fixture; production URL validation remains enabled.
      vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) =>
        realFetch(`http://127.0.0.1:${port}/${String(url).startsWith("https://r.jina.ai/") ? "reader" : "direct"}`, init)));
      const tool = new WebFetchTool(new WebFetchConfig({ useJinaReader: route === "reader", timeoutS: 2 }));
      const result = await tool.execute({ url: target });
      expect(String(result)).toContain(route === "reader" ? "preflight or fallback" : `HTTP_${status}`);
      await vi.waitFor(() => {
        expect(responses.length).toBeGreaterThan(0);
        expect(responses.every((response) => response.closed)).toBe(true);
      }, { timeout: 500, interval: 10 });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("operation lifetime cleanup", () => {
  it("aborts an unconsumed request when the operation returns early, without aborting its parent", async () => {
    let closed = false;
    const server = createServer((_req, res) => {
      res.once("close", () => { closed = true; });
      res.writeHead(200);
      res.write("partial response");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const parent = new AbortController();
    try {
      const port = (server.address() as { port: number }).port;
      const result = await withWebDeadline(2, parent.signal, async (signal) => {
        await fetch(`http://127.0.0.1:${port}/`, { signal });
        return "already finished";
      });
      expect(result).toBe("already finished");
      expect(parent.signal.aborted).toBe(false);
      await vi.waitFor(() => expect(closed).toBe(true), { timeout: 500, interval: 10 });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("does not permit a Reader request for an unsafe redirect", async () => {
    const mock = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }));
    vi.stubGlobal("fetch", mock);
    expect(await new WebFetchTool().execute({ url: target })).toContain("Redirect blocked");
    expect(mock).toHaveBeenCalledTimes(1);
  });
});
