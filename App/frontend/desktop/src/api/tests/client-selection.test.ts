import type { RuntimeConfig } from "@memmy/local-api-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppClients } from "../client-types.js";

const runtimeConfig: RuntimeConfig = {
  baseUrl: "http://127.0.0.1:18100",
  localToken: "token",
  memory: { baseUrl: "http://127.0.0.1:18960" }
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("frontend API client selection", () => {
  it("requires runtime config and returns real HTTP clients without mock flag", () => {
    expect(() => createAppClients({ runtimeConfig: null })).toThrow("Runtime config is required.");

    const clients = createAppClients({ runtimeConfig });
    expect("isMock" in clients).toBe(false);
    expect(clients.runtimeConfig.memory?.baseUrl).toBe("http://127.0.0.1:18960");
  });

  it("真实模式 integrations 首调失败时不再降级 mock", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "composio_not_configured",
              message: "尚未配置 Composio 鉴权服务",
              requestId: "unknown"
            }
          }),
          { status: 400 }
        )
      )
    );
    const clients = createAppClients({ runtimeConfig });

    await expect(clients.integrations.listConnections()).rejects.toThrow("尚未配置 Composio 鉴权服务");
  });
});
