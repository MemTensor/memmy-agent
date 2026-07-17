/** Connect channel modal tests. */
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ChannelsClient } from "../../api/channels-client.js";
import type { IntegrationConnection } from "../../integrations/connection-state.js";
import type { IntegrationMeta } from "../../integrations/integration-meta.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { ConnectChannelModal, shouldRefreshAfterChannelConnectStatus } from "../connect-channel-modal.js";

const baseChannel: IntegrationMeta = {
  slug: "wechat",
  name: "WeChat",
  description: "Connect WeChat for messaging workflows.",
  category: "Chat",
  logoUrl: "https://logos.composio.dev/api/wechat",
  permissionLabel: "Messages, channels, and communication data",
  authKind: "qrCode",
  surface: "channel",
  identity: "channel:wechat",
  isChannel: true
};

describe("ConnectChannelModal", () => {
  it("WeChat idle 相位显示扫码连接说明和一键连接按钮，不需要填凭证", () => {
    const html = renderModal(baseChannel, { language: "zh-CN" });

    expect(html).toContain("连接 WeChat");
    expect(html).toContain("使用微信扫码连接此消息渠道");
    expect(html).toContain("rounded-3xl");
    expect(html).not.toContain("Memmy 微信应用 ID");
    expect(html).not.toContain("暂未支持，敬请期待～");
    expect(html).not.toContain("disabled=\"\"");
    expect(html).not.toContain("open a browser window");
    expect(html).not.toContain("complete OAuth");
  });

  it("WeChat pendingQr 相位显示二维码和轮询按钮", () => {
    const html = renderModal(baseChannel, {
      forcedConnectResponse: {
        status: "pendingQr",
        connectionId: "channel-wechat-local",
        qrCodeDataUrl: "data:image/png;base64,abc",
        pollToken: "poll-1"
      }
    });

    expect(html).toContain("data:image/png;base64,abc");
    expect(html).toContain("I&#x27;ve scanned");
    expect(html).toContain("Waiting for WeChat authorization...");
  });

  it("WeChat pendingQr 后不刷新父页面，避免二维码等待态被连接列表覆盖", () => {
    expect(shouldRefreshAfterChannelConnectStatus("pendingQr")).toBe(false);
    expect(shouldRefreshAfterChannelConnectStatus("connected")).toBe(true);
  });

  it("Feishu 表单相位显示 App ID 和 App Secret 输入", () => {
    const html = renderModal({ ...baseChannel, slug: "feishu", name: "Feishu", authKind: "apiKey" });

    expect(html).toContain("Connect Feishu");
    expect(html).toContain("App ID");
    expect(html).toContain("App Secret");
    expect(html).toContain("Connect Feishu");
    expect(html).not.toContain("Scan with WeChat");
  });

  it("DingTalk 表单相位显示 Client ID 和 Client Secret 输入", () => {
    const html = renderModal({ ...baseChannel, slug: "dingtalk", name: "DingTalk", authKind: "apiKey" });

    expect(html).toContain("Connect DingTalk");
    expect(html).toContain("Client ID");
    expect(html).toContain("Client Secret");
    expect(html).not.toContain("Scan with WeChat");
  });

  it("DingTalk 表单相位展示指向钉钉官方教程的外链，教用户获取 Client ID / Secret", () => {
    const html = renderModal({ ...baseChannel, slug: "dingtalk", name: "DingTalk", authKind: "apiKey" });

    expect(html).toContain("https://open.dingtalk.com/document/orgapp/the-creation-and-installation-of-the-application-robot-in-the");
    expect(html).toContain("How to create a DingTalk robot");
    expect(html).toContain("target=\"_blank\"");
  });

  it("Feishu 表单相位展示指向飞书官方教程的外链，教用户获取 App ID / Secret", () => {
    const html = renderModal({ ...baseChannel, slug: "feishu", name: "Feishu", authKind: "apiKey" });

    expect(html).toContain("https://open.feishu.cn/document/develop-process/self-built-application-development-process");
    expect(html).toContain("How to create a Feishu custom app");
    expect(html).toContain("target=\"_blank\"");
    expect(html).not.toContain("open.dingtalk.com");
  });

  it("WeChat 扫码相位不展示教程外链", () => {
    const html = renderModal(baseChannel, { language: "en-US" });

    expect(html).not.toContain("open.dingtalk.com");
    expect(html).not.toContain("open.feishu.cn");
  });

  it("已连接渠道显示管理和断开按钮", () => {
    const html = renderModal(baseChannel, {
      connection: { id: "channel-wechat-local", toolkit: "wechat", status: "connected" }
    });

    expect(html).toContain("Manage WeChat");
    expect(html).toContain("WeChat is connected");
    expect(html).toContain("Disconnect");
  });

  it("Telegram 表单相位显示 Bot Token 输入", () => {
    const html = renderModal({ ...baseChannel, slug: "telegram", name: "Telegram", authKind: "apiKey" });

    expect(html).toContain("Connect Telegram");
    expect(html).toContain("Bot Token");
    expect(html).not.toContain("This channel connection is coming soon");
    expect(html).not.toContain("Scan with WeChat");
  });

  it("Telegram 表单相位展示指向 @BotFather 的外链，教用户获取 Bot Token", () => {
    const html = renderModal({ ...baseChannel, slug: "telegram", name: "Telegram", authKind: "apiKey" });

    expect(html).toContain("https://core.telegram.org/bots/tutorial");
    expect(html).toContain("How to create a Telegram bot and get your Bot Token");
    expect(html).toContain("target=\"_blank\"");
  });

  it("未开放渠道显示待接入态，不调用 OAuth 文案", () => {
    const html = renderModal({ ...baseChannel, slug: "line", name: "LINE", authKind: "none" });

    expect(html).toContain("Connect LINE");
    expect(html).toContain("This channel connection is coming soon; awaiting backend");
    expect(html).toContain("disabled=\"\"");
    expect(html).not.toContain("open a browser window");
  });

  it("Discord 表单相位显示 Bot Token 输入", () => {
    const html = renderModal({ ...baseChannel, slug: "discord", name: "Discord", authKind: "apiKey" });

    expect(html).toContain("Connect Discord");
    expect(html).toContain("Bot Token");
    expect(html).not.toContain("This channel connection is coming soon");
    expect(html).not.toContain("Scan with WeChat");
  });

  it("Discord 表单相位展示指向 Discord 官方开发者门户的外链，教用户获取 Bot Token", () => {
    const html = renderModal({ ...baseChannel, slug: "discord", name: "Discord", authKind: "apiKey" });

    expect(html).toContain("https://docs.discord.com/developers/quick-start/getting-started");
    expect(html).toContain("How to create a Discord bot");
    expect(html).toContain("target=\"_blank\"");
  });

  it("iMessage 渲染 local 相位：权限说明 + 可用连接按钮，无凭证输入", () => {
    const html = renderModal({ ...baseChannel, slug: "imessage", name: "iMessage", authKind: "none" });

    expect(html).toContain("Connect iMessage");
    expect(html).toContain("Full Disk Access");
    expect(html).toContain("Open Full Disk Access");
    expect(html).toContain("Open Automation");
    expect(html).not.toContain("This channel connection is coming soon");
    expect(html).not.toContain("disabled=\"\"");
    expect(html).not.toContain("App ID");
  });
});

function renderModal(
  channel: IntegrationMeta,
  overrides: Partial<Parameters<typeof ConnectChannelModal>[0]> & { connection?: IntegrationConnection; language?: "zh-CN" | "en-US" } = {}
): string {
  const { language, ...modalOverrides } = overrides;
  return renderToString(
    <I18nProvider language={language ?? "en-US"}>
      <ConnectChannelModal
        open
        channel={channel}
        client={createChannelsClient()}
        onClose={vi.fn()}
        onChanged={vi.fn()}
        {...modalOverrides}
      />
    </I18nProvider>
  );
}

function createChannelsClient(): ChannelsClient {
  return {
    listDefinitions: vi.fn(async () => ({ channels: [] })),
    listConnections: vi.fn(async () => ({ connections: [] })),
    connect: vi.fn(async () => ({ status: "connected" as const, connectionId: "channel-test-local" })),
    pollConnect: vi.fn(async () => ({ status: "connected" as const, connectionId: "channel-test-local" })),
    disconnect: vi.fn(async () => undefined)
  };
}
