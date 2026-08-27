import type { RuntimeConfig } from "@memmy/local-api-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHttpIntegrationsClient,
  integrationEndpointPaths
} from "../integrations-client.js";

const config: RuntimeConfig = {
  baseUrl: "http://127.0.0.1:18100",
  localToken: "token"
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("integrations-client", () => {
  it("http client 调用本地 capabilities/authorize/list/delete 路由并携带 runtime token", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      expect(init?.headers).toMatchObject({
        "x-memmy-local-token": "token"
      });

      if (url.endsWith("/api/v1/integrations/capabilities")) {
        return jsonResponse({ toolkits: ["github"] });
      }

      if (url.endsWith("/api/v1/integrations/github/authorize")) {
        return jsonResponse({ connectUrl: "https://backend.composio.dev/api/v3/s/github-test", connectionId: "conn-github" });
      }

      if (url.endsWith("/api/v1/integrations/connections")) {
        return jsonResponse({ connections: [{ id: "conn-github", toolkit: "github", status: "ACTIVE" }] });
      }

      if (url.endsWith("/api/v1/integrations/connections/conn-github")) {
        return jsonResponse({ ok: true });
      }

      return jsonResponse({ error: "not found" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createHttpIntegrationsClient(config);

    await expect(client.listCapabilities()).resolves.toEqual({ toolkits: ["github"] });
    await expect(client.authorize("github")).resolves.toEqual({
      connectUrl: "https://backend.composio.dev/api/v3/s/github-test",
      connectionId: "conn-github"
    });
    await expect(client.listConnections()).resolves.toEqual({
      connections: [{ id: "conn-github", toolkit: "github", status: "ACTIVE" }]
    });
    await expect(client.deleteConnection("conn-github")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("http client 真实失败时抛出错误，由 resilient client 决定是否降级", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "missing" }, 404)));
    const client = createHttpIntegrationsClient(config);

    await expect(client.listConnections()).rejects.toThrow("failed with status 404");
  });

  it("暴露 v3 后端占位路径", () => {
    expect(integrationEndpointPaths.listCapabilities).toBe("/api/v1/integrations/capabilities");
    expect(integrationEndpointPaths.authorize("github")).toBe("/api/v1/integrations/github/authorize");
    expect(integrationEndpointPaths.listConnections).toBe("/api/v1/integrations/connections");
    expect(integrationEndpointPaths.deleteConnection("conn 1")).toBe("/api/v1/integrations/connections/conn%201");
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
