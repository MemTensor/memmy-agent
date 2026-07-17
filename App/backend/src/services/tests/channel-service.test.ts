/** Channel service tests. */
import { describe, expect, it, vi } from "vitest";
import { createChannelService } from "../channel-service.js";
import type { MemmyAgentAdminClient } from "../../adapters/outbound/memmy-agent-admin-client/index.js";
import type { MemmyConfigWriter } from "../../infrastructure/memmy-config/index.js";

function createHarness() {
  const patchCalls: Array<{ name: string; patch: Record<string, unknown> }> = [];
  const memmyConfigWriter: MemmyConfigWriter = {
    writeAccountModelProjection: vi.fn(async () => undefined),
    writeByokModelProjection: vi.fn(async () => undefined),
    patchChannelConfig: vi.fn(async (name, patch) => {
      patchCalls.push({ name, patch });
    })
  };
  const memmyAgentAdminClient: MemmyAgentAdminClient = {
    getChannelDefinitions: vi.fn(async () => ({ channels: [] })),
    getChannelConnections: vi.fn(async () => ({ connections: [] })),
    configureChannel: vi.fn(async () => ({ status: "connected", running: true })),
    stopChannel: vi.fn(async () => ({ status: "disabled", running: false })),
    startWeixinLogin: vi.fn(async () => ({
      status: "pendingQr",
      qrCodeDataUrl: "data:image/png;base64,qr",
      pollToken: "poll-1"
    })),
    pollWeixinLogin: vi.fn(async () => ({ status: "connected" }))
  };

  return {
    patchCalls,
    memmyConfigWriter,
    memmyAgentAdminClient,
    service: createChannelService({ memmyConfigWriter, memmyAgentAdminClient })
  };
}

describe("channel service", () => {
  it("returns local product channel definitions without Composio capabilities", async () => {
    const { service } = createHarness();

    await expect(service.listDefinitions()).resolves.toEqual({
      channels: expect.arrayContaining([
        expect.objectContaining({
          id: "wechat",
          runtimeChannel: "weixin",
          authKind: "qrCode",
          enabled: true,
          fields: []
        }),
        expect.objectContaining({ id: "feishu", runtimeChannel: "feishu", authKind: "form", enabled: true }),
        expect.objectContaining({
          id: "discord",
          runtimeChannel: "discord",
          authKind: "form",
          enabled: true,
          fields: [{ key: "token", label: "Bot Token", kind: "secret", required: true }]
        }),
        expect.objectContaining({ id: "imessage", runtimeChannel: "imessage", authKind: "local" })
      ])
    });
  });

  it("connects WeChat one-click with the default bridge app id and starts the weixin login session", async () => {
    const { service, patchCalls, memmyAgentAdminClient } = createHarness();

    await expect(service.connect("wechat", {})).resolves.toEqual({
      status: "pendingQr",
      connectionId: "channel-wechat-local",
      qrCodeDataUrl: "data:image/png;base64,qr",
      pollToken: "poll-1"
    });
    expect(patchCalls).toEqual([{ name: "weixin", patch: { enabled: true, appId: "bot", allowFrom: ["*"] } }]);
    expect(memmyAgentAdminClient.startWeixinLogin).toHaveBeenCalledTimes(1);
  });

  it("connects Feishu by writing config and asking memmy-agent to configure the runtime channel", async () => {
    const { service, patchCalls, memmyAgentAdminClient } = createHarness();

    await expect(service.connect("feishu", { appId: "cli_a", appSecret: "secret" })).resolves.toEqual({
      status: "connected",
      connectionId: "channel-feishu-local"
    });
    expect(patchCalls).toEqual([{
      name: "feishu",
      patch: {
        enabled: true,
        appId: "cli_a",
        appSecret: "secret",
        domain: "feishu",
        streaming: true,
        groupPolicy: "mention",
        allowFrom: ["*"]
      }
    }]);
    expect(memmyAgentAdminClient.configureChannel).toHaveBeenCalledWith("feishu");
  });

  it("connects DingTalk by writing clientId/clientSecret and configuring the dingtalk runtime channel", async () => {
    const { service, patchCalls, memmyAgentAdminClient } = createHarness();

    await expect(service.connect("dingtalk", { clientId: "ding_a", clientSecret: "secret" })).resolves.toEqual({
      status: "connected",
      connectionId: "channel-dingtalk-local"
    });
    expect(patchCalls).toEqual([{
      name: "dingtalk",
      patch: {
        enabled: true,
        clientId: "ding_a",
        clientSecret: "secret",
        allowFrom: ["*"]
      }
    }]);
    expect(memmyAgentAdminClient.configureChannel).toHaveBeenCalledWith("dingtalk");
  });

  it("connects Discord by writing the bot token and configuring the discord runtime channel", async () => {
    const { service, patchCalls, memmyAgentAdminClient } = createHarness();

    await expect(service.connect("discord", { token: "bot-token" })).resolves.toEqual({
      status: "connected",
      connectionId: "channel-discord-local"
    });
    expect(patchCalls).toEqual([{
      name: "discord",
      patch: {
        enabled: true,
        token: "bot-token",
        allowFrom: ["*"]
      }
    }]);
    expect(memmyAgentAdminClient.configureChannel).toHaveBeenCalledWith("discord");
  });

  it("rejects Discord connect when the bot token is missing", async () => {
    const { service, patchCalls, memmyAgentAdminClient } = createHarness();

    await expect(service.connect("discord", {})).rejects.toThrow(/token/);
    expect(patchCalls).toEqual([]);
    expect(memmyAgentAdminClient.configureChannel).not.toHaveBeenCalled();
  });

  it("disconnects Discord by disabling config and stopping the runtime channel", async () => {
    const { service, patchCalls, memmyAgentAdminClient } = createHarness();

    await expect(service.disconnect("discord")).resolves.toEqual({ ok: true });
    expect(patchCalls).toEqual([{ name: "discord", patch: { enabled: false } }]);
    expect(memmyAgentAdminClient.stopChannel).toHaveBeenCalledWith("discord");
  });

  it("disconnects DingTalk by disabling config and stopping the runtime channel", async () => {
    const { service, patchCalls, memmyAgentAdminClient } = createHarness();

    await expect(service.disconnect("dingtalk")).resolves.toEqual({ ok: true });
    expect(patchCalls).toEqual([{ name: "dingtalk", patch: { enabled: false } }]);
    expect(memmyAgentAdminClient.stopChannel).toHaveBeenCalledWith("dingtalk");
  });

  it("keeps unsupported channels out of runtime and config side effects", async () => {
    const { service, patchCalls, memmyAgentAdminClient } = createHarness();

    await expect(service.connect("unknown" as any, {})).resolves.toEqual({
      status: "unsupported",
      connectionId: "channel-unknown-local"
    });
    expect(patchCalls).toEqual([]);
    expect(memmyAgentAdminClient.configureChannel).not.toHaveBeenCalled();
  });

  it("connects iMessage via local flow: writes enabled config and configures the runtime channel", async () => {
    const { service, patchCalls, memmyAgentAdminClient } = createHarness();

    const response = await service.connect("imessage", {});

    expect(patchCalls).toContainEqual({
      name: "imessage",
      patch: { enabled: true, allowFrom: ["*"] }
    });
    expect(memmyAgentAdminClient.configureChannel).toHaveBeenCalledWith("imessage");
    expect(response.status).toBe("connected");
    expect(response.connectionId).toBe("channel-imessage-local");
  });

  it("disconnects iMessage by disabling config and stopping the runtime channel", async () => {
    const { service, patchCalls, memmyAgentAdminClient } = createHarness();

    await expect(service.disconnect("imessage")).resolves.toEqual({ ok: true });

    expect(patchCalls).toContainEqual({ name: "imessage", patch: { enabled: false } });
    expect(memmyAgentAdminClient.stopChannel).toHaveBeenCalledWith("imessage");
  });

  it("polls WeChat and disconnects runtime channels", async () => {
    const { service, patchCalls, memmyAgentAdminClient } = createHarness();

    await expect(service.pollConnect("wechat", "poll-1")).resolves.toEqual({
      status: "connected",
      connectionId: "channel-wechat-local"
    });
    await expect(service.disconnect("feishu")).resolves.toEqual({ ok: true });

    expect(memmyAgentAdminClient.pollWeixinLogin).toHaveBeenCalledWith("poll-1");
    expect(patchCalls).toEqual([{ name: "feishu", patch: { enabled: false } }]);
    expect(memmyAgentAdminClient.stopChannel).toHaveBeenCalledWith("feishu");
  });
});
