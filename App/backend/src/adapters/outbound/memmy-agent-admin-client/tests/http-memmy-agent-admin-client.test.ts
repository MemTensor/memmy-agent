/** Http memmy agent admin client tests. */
import { createServer, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpMemmyAgentAdminClient } from "../http-memmy-agent-admin-client.js";

let server: ReturnType<typeof createServer> | undefined;

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server?.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  server = undefined;
});

describe("http memmy-agent admin client", () => {
  it("starts, reads and stops an assist run, keeping the runtime's reason when it refuses", async () => {
    const bodies: unknown[] = [];
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/webui/bootstrap") return Response.json({ token: "boot-token" });
      expect(init?.headers).toMatchObject({ authorization: "Bearer boot-token" });
      if (path === "/api/webui/assist/runs") {
        bodies.push(JSON.parse(String(init?.body)));
        return bodies.length === 1
          ? Response.json({ chat_id: "chat-1", status: "starting", steps: [], reply: "", error: null }, { status: 202 })
          : Response.json({ chat_id: "chat-2", status: "failed", steps: [], reply: "", error: "model_selection_unavailable" }, { status: 409 });
      }
      if (path === "/api/webui/assist/runs/chat-1") {
        return Response.json({ chat_id: "chat-1", status: "running", steps: [{ text: "运行命令 ls", status: "running" }], reply: "", error: null });
      }
      if (path === "/api/webui/assist/runs/chat-1/stop") {
        expect(init?.method).toBe("POST");
        return Response.json({ chat_id: "chat-1", status: "stopped", steps: [], reply: "", error: null });
      }
      return Response.json({ error: "run_not_found" }, { status: 404 });
    });
    const client = createHttpMemmyAgentAdminClient({ fetchFn: fetchFn as typeof fetch });
    const input = {
      projectId: "local-p1",
      title: "收集版本信息",
      content: "看一下版本",
      assist: { requestId: "r1", threadId: "t1", cloudProjectId: "p1", requesterName: "孙起", requesterId: "1", via: "Codex", attempt: 1, title: "收集版本信息" }
    };

    expect(await client.startAssistRun!(input)).toMatchObject({ chatId: "chat-1", status: "starting" });
    expect(bodies[0]).toMatchObject({ project_id: "local-p1", title: "收集版本信息", content: "看一下版本", assist: { requestId: "r1" } });
    expect(bodies[0]).not.toHaveProperty("chat_id");
    expect(await client.startAssistRun!({ ...input, chatId: "chat-2" })).toMatchObject({ status: "failed", error: "model_selection_unavailable" });
    expect(bodies[1]).toMatchObject({ chat_id: "chat-2" });
    expect(await client.readAssistRun!("chat-1")).toEqual({
      chatId: "chat-1",
      status: "running",
      steps: [{ text: "运行命令 ls", status: "running" }],
      transcript: [],
      reply: "",
      error: null
    });
    expect(await client.readAssistRun!("missing")).toBeNull();
    expect(await client.stopAssistRun!("chat-1")).toMatchObject({ status: "stopped" });
  });

  it("reads authenticated task activity with a timeout and rejects malformed status", async () => {
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/webui/bootstrap") return Response.json({ token: "boot-token" });
      expect(path).toBe("/api/runtime/task-activity");
      expect(init?.headers).toMatchObject({ authorization: "Bearer boot-token" });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Response.json({ busy: true });
    });
    const client = createHttpMemmyAgentAdminClient({ fetchFn: fetchFn as typeof fetch });
    expect(await client.hasActiveTasks!()).toBe(true);
    fetchFn.mockResolvedValueOnce(Response.json({ busy: false }));
    expect(await client.hasActiveTasks!()).toBe(false);
    fetchFn.mockResolvedValueOnce(Response.json({}));
    await expect(client.hasActiveTasks!()).rejects.toThrow();
  });

  it("applies one hard timeout to MCP reload bootstrap and admin requests", async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      signals.push(init?.signal);
      const path = new URL(String(input)).pathname;
      return Response.json(path === "/webui/bootstrap"
        ? { token: "boot-token" }
        : { ok: true, message: "reloaded", requires_restart: false });
    });
    const client = createHttpMemmyAgentAdminClient({ fetchFn: fetchFn as typeof fetch });

    await client.reloadMcpConfig();

    expect(signals).toHaveLength(2);
    expect(signals[0]).toBe(signals[1]);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  it("bootstraps once and calls channel admin routes with bearer auth", async () => {
    const requests: Array<{ method: string | undefined; path: string; authorization: string | undefined }> = [];
    server = createServer((request, response) => {
      requests.push({
        method: request.method,
        path: request.url ?? "",
        authorization: request.headers.authorization
      });

      if (request.url === "/webui/bootstrap") {
        sendJson(response, { token: "boot-token", ws_path: "/", expires_in: 60, model_name: null });
        return;
      }
      if (request.url === "/api/channels/status") {
        sendJson(response, {
          connections: [{ id: "channel-wechat-local", provider: "wechat", runtimeChannel: "weixin", status: "connected", running: true, displayName: "WeChat" }]
        });
        return;
      }
      if (request.url === "/api/sessions/websocket%3Achat-1/environment") {
        sendJson(response, { snapshot: { cwd: "/Users/test/workspace" } });
        return;
      }
      if (request.url === "/api/sessions/websocket%3A127c0697-c224-47e0-a032-684c7c1c2abb/environment") {
        sendJson(response, { snapshot: { cwd: "/Users/test/standalone" } });
        return;
      }
      if (request.url === "/api/channels/feishu/configure") {
        sendJson(response, { status: "connected", running: true });
        return;
      }
      if (request.url === "/api/channels/weixin/login/start") {
        sendJson(response, { status: "pendingQr", qrCodeDataUrl: "data:image/png;base64,qr", pollToken: "poll-1" });
        return;
      }
      if (request.url === "/api/settings/mcp-presets/reload") {
        sendJson(response, { ok: true, message: "MCP config reloaded.", requires_restart: false });
        return;
      }

      response.statusCode = 404;
      response.end();
    });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind to a port");
    const client = createHttpMemmyAgentAdminClient({ baseUrl: `http://127.0.0.1:${address.port}` });

    await expect(client.getChannelConnections()).resolves.toEqual({
      connections: [{ id: "channel-wechat-local", provider: "wechat", runtimeChannel: "weixin", status: "connected", running: true, displayName: "WeChat" }]
    });
    await expect(client.getSessionWorkspace?.("websocket:chat-1")).resolves.toBe("/Users/test/workspace");
    await expect(client.getSessionWorkspace?.("127c0697-c224-47e0-a032-684c7c1c2abb")).resolves.toBe("/Users/test/standalone");
    await expect(client.configureChannel("feishu")).resolves.toEqual({ status: "connected", running: true });
    await expect(client.startWeixinLogin()).resolves.toMatchObject({ status: "pendingQr", pollToken: "poll-1" });
    await expect(client.reloadMcpConfig()).resolves.toEqual({
      ok: true,
      message: "MCP config reloaded.",
      requires_restart: false
    });
    expect(requests).toEqual([
      { method: "GET", path: "/webui/bootstrap", authorization: undefined },
      { method: "GET", path: "/api/channels/status", authorization: "Bearer boot-token" },
      { method: "GET", path: "/api/sessions/websocket%3Achat-1/environment", authorization: "Bearer boot-token" },
      { method: "GET", path: "/api/sessions/websocket%3A127c0697-c224-47e0-a032-684c7c1c2abb/environment", authorization: "Bearer boot-token" },
      { method: "POST", path: "/api/channels/feishu/configure", authorization: "Bearer boot-token" },
      { method: "POST", path: "/api/channels/weixin/login/start", authorization: "Bearer boot-token" },
      { method: "POST", path: "/api/settings/mcp-presets/reload", authorization: "Bearer boot-token" }
    ]);
  });

  it("sends the bootstrap secret as x-memmy-agent-auth when configured", async () => {
    const bootstrapAuthHeaders: Array<string | string[] | undefined> = [];
    server = createServer((request, response) => {
      if (request.url === "/webui/bootstrap") {
        bootstrapAuthHeaders.push(request.headers["x-memmy-agent-auth"]);
        sendJson(response, { token: "boot-token", ws_path: "/", expires_in: 60, model_name: null });
        return;
      }
      if (request.url === "/api/channels/status") {
        sendJson(response, { connections: [] });
        return;
      }

      response.statusCode = 404;
      response.end();
    });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind to a port");
    const client = createHttpMemmyAgentAdminClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      bootstrapSecret: "gateway-secret"
    });

    await expect(client.getChannelConnections()).resolves.toEqual({ connections: [] });
    expect(bootstrapAuthHeaders).toEqual(["gateway-secret"]);
  });

  it("preserves channel admin error body for product-facing diagnostics", async () => {
    server = createServer((request, response) => {
      if (request.url === "/webui/bootstrap") {
        sendJson(response, { token: "boot-token", ws_path: "/", expires_in: 60, model_name: null });
        return;
      }
      if (request.url === "/api/channels/weixin/login/start") {
        response.statusCode = 500;
        response.setHeader("content-type", "text/plain; charset=utf-8");
        response.end("微信渠道还没有配置 Memmy 应用，无法生成授权二维码。");
        return;
      }

      response.statusCode = 404;
      response.end();
    });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind to a port");
    const client = createHttpMemmyAgentAdminClient({ baseUrl: `http://127.0.0.1:${address.port}` });

    await expect(client.startWeixinLogin()).rejects.toThrow("微信渠道还没有配置 Memmy 应用");
  });
});

async function listen(input: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    input.once("error", reject);
    input.listen(0, "127.0.0.1", () => resolve());
  });
}

function sendJson(response: ServerResponse, body: unknown): void {
  response.statusCode = 200;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}
