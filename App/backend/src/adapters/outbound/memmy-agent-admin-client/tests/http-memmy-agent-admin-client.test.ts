/** Http memmy agent admin client tests. */
import { createServer, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
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
      if (request.url === "/api/channels/feishu/configure") {
        sendJson(response, { status: "connected", running: true });
        return;
      }
      if (request.url === "/api/channels/weixin/login/start") {
        sendJson(response, { status: "pendingQr", qrCodeDataUrl: "data:image/png;base64,qr", pollToken: "poll-1" });
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
    await expect(client.configureChannel("feishu")).resolves.toEqual({ status: "connected", running: true });
    await expect(client.startWeixinLogin()).resolves.toMatchObject({ status: "pendingQr", pollToken: "poll-1" });
    expect(requests).toEqual([
      { method: "GET", path: "/webui/bootstrap", authorization: undefined },
      { method: "GET", path: "/api/channels/status", authorization: "Bearer boot-token" },
      { method: "POST", path: "/api/channels/feishu/configure", authorization: "Bearer boot-token" },
      { method: "POST", path: "/api/channels/weixin/login/start", authorization: "Bearer boot-token" }
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
