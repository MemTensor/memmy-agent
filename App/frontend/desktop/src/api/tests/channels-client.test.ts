import type { RuntimeConfig } from "@memmy/local-api-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { channelEndpointPaths, createHttpChannelsClient } from "../channels-client.js";

const config: RuntimeConfig = {
  baseUrl: "http://127.0.0.1:18100",
  localToken: "token"
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("channels-client", () => {
  it("http client 调用本地 channels 路由并携带 runtime token", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      expect(init?.headers).toMatchObject({
        "x-memmy-local-token": "token"
      });

      if (url.endsWith("/api/v1/channels/definitions")) {
        return jsonResponse({
          channels: [
            {
              id: "wechat",
              runtimeChannel: "weixin",
              name: "WeChat",
              authKind: "qrCode",
              enabled: true,
              capabilities: ["receiveText"],
              fields: []
            }
          ]
        });
      }

      if (url.endsWith("/api/v1/channels/connections")) {
        return jsonResponse({
          connections: [
            {
              id: "channel-wechat-local",
              provider: "wechat",
              runtimeChannel: "weixin",
              status: "connected",
              running: true,
              displayName: "WeChat"
            }
          ]
        });
      }

      if (url.endsWith("/api/v1/channels/wechat/connect")) {
        expect(init?.method).toBe("POST");
        return jsonResponse({
          status: "pendingQr",
          connectionId: "channel-wechat-local",
          qrCodeDataUrl: "data:image/png;base64,abc",
          pollToken: "poll-1"
        });
      }

      if (url.endsWith("/api/v1/channels/wechat/connect/poll-1")) {
        return jsonResponse({
          status: "connected",
          connectionId: "channel-wechat-local"
        });
      }

      if (url.endsWith("/api/v1/channels/feishu/disconnect")) {
        expect(init?.method).toBe("POST");
        return jsonResponse({ ok: true });
      }

      return jsonResponse({ error: "not found" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createHttpChannelsClient(config);

    await expect(client.listDefinitions()).resolves.toEqual({
      channels: [
        {
          id: "wechat",
          runtimeChannel: "weixin",
          name: "WeChat",
          authKind: "qrCode",
          enabled: true,
          capabilities: ["receiveText"],
          fields: []
        }
      ]
    });
    await expect(client.listConnections()).resolves.toEqual({
      connections: [
        {
          id: "channel-wechat-local",
          provider: "wechat",
          runtimeChannel: "weixin",
          status: "connected",
          running: true,
          displayName: "WeChat"
        }
      ]
    });
    await expect(client.connect("wechat")).resolves.toEqual({
      status: "pendingQr",
      connectionId: "channel-wechat-local",
      qrCodeDataUrl: "data:image/png;base64,abc",
      pollToken: "poll-1"
    });
    await expect(client.pollConnect("wechat", "poll-1")).resolves.toEqual({
      status: "connected",
      connectionId: "channel-wechat-local"
    });
    await expect(client.disconnect("feishu")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("暴露 channels 后端路径", () => {
    expect(channelEndpointPaths.listDefinitions).toBe("/api/v1/channels/definitions");
    expect(channelEndpointPaths.listConnections).toBe("/api/v1/channels/connections");
    expect(channelEndpointPaths.connect("wechat")).toBe("/api/v1/channels/wechat/connect");
    expect(channelEndpointPaths.pollConnect("wechat", "poll 1")).toBe("/api/v1/channels/wechat/connect/poll%201");
    expect(channelEndpointPaths.disconnect("feishu")).toBe("/api/v1/channels/feishu/disconnect");
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json"
    }
  });
}
