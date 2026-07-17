/**
 * Feishu channel connection verification tests.
 *
 * This file verifies that start() actually validates App ID/App Secret against
 * the Feishu auth endpoint and requires event subscription startup, preventing
 * fake "connected" states from arbitrary credential input.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageBus } from "../../../src/core/runtime-messages/index.js";
import { FeishuChannel } from "../../../src/integrations/channels/feishu.js";

const larkSdkMock = vi.hoisted(() => {
  const api: any = {
    AppType: { SelfBuild: 1 },
    Domain: { Feishu: "https://open.feishu.cn", Lark: "https://open.larksuite.com" },
    LoggerLevel: { fatal: "fatal" },
    ws: undefined,
    authResponse: { code: 0, msg: "ok", tenant_access_token: "t-xxx", expire: 7200 },
    wsStartError: null as Error | null,
    wsInstances: [] as any[],
  };
  const runtimeClient = () => ({
    request: vi.fn(async (req: any) => {
      if (typeof req?.url === "string" && req.url.includes("tenant_access_token")) {
        return api.authResponse;
      }
      return { data: { bot: { open_id: "ou_bot" } } };
    }),
    im: { v1: { message: {}, image: {}, file: {}, message_reaction: {}, message_resource: {} } },
  });
  function Client(this: any, opts: any) {
    Object.assign(this, runtimeClient(), { opts });
  }
  function WSClient(this: any, opts: any) {
    this.opts = opts;
    this.on = vi.fn(() => this);
    this.start = vi.fn(async () => {
      if (api.wsStartError) throw api.wsStartError;
    });
    this.close = vi.fn(async () => undefined);
    api.wsInstances.push(this);
  }
  api.Client = vi.fn(Client);
  api.WSClient = vi.fn(WSClient);
  api.EventDispatcher = vi.fn(function EventDispatcher(this: any, opts: any) {
    this.opts = opts;
    this.register = vi.fn(() => this);
    this.invoke = vi.fn(async () => undefined);
  });
  api.reset = () => {
    api.authResponse = { code: 0, msg: "ok", tenant_access_token: "t-xxx", expire: 7200 };
    api.wsStartError = null;
    api.wsInstances = [];
    api.WSClient = vi.fn(WSClient);
    api.Client.mockClear();
    api.EventDispatcher.mockClear();
  };
  return api;
});

vi.mock("@larksuiteoapi/node-sdk", () => larkSdkMock);

afterEach(() => {
  larkSdkMock.reset();
});

describe("Feishu connection verification", () => {
  it("rejects and stays not-running when credentials are invalid", async () => {
    larkSdkMock.authResponse = {
      code: 10003,
      msg: "invalid app_id",
      tenant_access_token: "",
      expire: 0,
    };
    const channel = new FeishuChannel(
      { enabled: true, appId: "wrong", appSecret: "wrong", allowFrom: ["*"] },
      new MessageBus(),
    );

    await expect(channel.start()).rejects.toThrow(/凭证|invalid app_id/);
    expect(channel.isRunning).toBe(false);
  });

  it("rejects when the event-subscription websocket client is unavailable", async () => {
    larkSdkMock.WSClient = undefined;
    const channel = new FeishuChannel(
      { enabled: true, appId: "cli_test", appSecret: "secret", allowFrom: ["*"] },
      new MessageBus(),
    );

    await expect(channel.start()).rejects.toThrow(/事件订阅|websocket/i);
    expect(channel.isRunning).toBe(false);
  });

  it("rejects when the websocket subscription fails to start", async () => {
    larkSdkMock.wsStartError = new Error("ws handshake failed");
    const channel = new FeishuChannel(
      { enabled: true, appId: "cli_test", appSecret: "secret", allowFrom: ["*"] },
      new MessageBus(),
    );

    await expect(channel.start()).rejects.toThrow(/ws handshake failed/);
    expect(channel.isRunning).toBe(false);
  });

  it("marks running only after credentials and websocket both succeed", async () => {
    const channel = new FeishuChannel(
      { enabled: true, appId: "cli_test", appSecret: "secret", allowFrom: ["*"] },
      new MessageBus(),
    );

    await channel.start();

    expect(channel.isRunning).toBe(true);
    expect(larkSdkMock.wsInstances[0].start).toHaveBeenCalled();
  });

  it("rejects when App ID or App Secret is missing", async () => {
    const channel = new FeishuChannel(
      { enabled: true, appId: "", appSecret: "", allowFrom: ["*"] },
      new MessageBus(),
    );

    await expect(channel.start()).rejects.toThrow(/App ID|App Secret/);
    expect(channel.isRunning).toBe(false);
  });
});

describe("Feishu event error isolation", () => {
  it("does not reject when handling an event fails, so the gateway stays up", async () => {
    const channel = new FeishuChannel(
      { enabled: true, appId: "cli_test", appSecret: "secret", allowFrom: ["*"] },
      new MessageBus(),
    );
    vi.spyOn(channel, "onMessage").mockRejectedValue(new Error("feishu send failed with HTTP 400"));
    const reportSpy = vi
      .spyOn(channel as any, "reportEventError")
      .mockImplementation(() => undefined);

    await expect(channel.safeOnMessage({ event: {} })).resolves.toBeUndefined();
    expect(reportSpy).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("400") }),
    );
  });
});
