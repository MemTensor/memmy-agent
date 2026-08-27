import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CATEGORY_TABS,
  AGENT_CHANNEL_DISPLAY_BY_SLUG,
  AgentQueueChannelIcon,
  GenericIntegrationIcon,
  ImChannelTitleIcon,
  IntegrationLogoBadge,
  composioLogoUrl,
  agentChannelDisplay,
  getAllIntegrationMeta,
  getIntegrationMeta,
  guessIntegrationCategory,
  imChannelTitleDisplay
} from "../integration-meta.js";
import { CHANNELS, MANAGED_INTEGRATION_TOOLKITS } from "../toolkit-catalog.js";

describe("integrationMeta", () => {
  it("包含 managed-auth 全表和 6 个渠道", () => {
    expect(MANAGED_INTEGRATION_TOOLKITS).toHaveLength(118);
    expect(CHANNELS).toHaveLength(6);
    expect(getAllIntegrationMeta()).toHaveLength(124);
    expect(getIntegrationMeta("github")?.name).toBe("GitHub");
    expect(getIntegrationMeta("wechat")?.authKind).toBe("qrCode");
  });

  it("使用 Composio 远程 logo CDN", () => {
    const html = renderToString(<IntegrationLogoBadge slug="github" name="GitHub" />);

    expect(composioLogoUrl("github")).toBe("https://logos.composio.dev/api/github");
    expect(html).toContain("https://logos.composio.dev/api/github");
    expect(html).toContain("integration-logo-badge");
    expect(html).toContain("integration-logo-image");
  });

  it("同名 Discord 渠道和 Composio 集成有不同展示身份", () => {
    const metas = getAllIntegrationMeta().filter((item) => item.slug === "discord");
    const channelDiscord = metas.find((item) => item.surface === "channel");
    const integrationDiscord = metas.find((item) => item.surface === "integration");

    expect(channelDiscord?.isChannel).toBe(true);
    expect(integrationDiscord?.isChannel).toBe(false);
    expect(channelDiscord?.identity).toBe("channel:discord");
    expect(integrationDiscord?.identity).toBe("integration:discord");
  });

  it("Discord 渠道使用渠道图标，Discord 集成继续使用 Composio logo", () => {
    const integrationHtml = renderToString(<IntegrationLogoBadge slug="discord" name="Discord" surface="integration" />);

    expect(integrationHtml).toContain("https://logos.composio.dev/api/discord");
    expect(integrationHtml).not.toContain("channel-integration-icon-badge");
  });

  it("logo 加载失败时可渲染通用兜底图标", () => {
    expect(renderToString(<GenericIntegrationIcon name="Unknown" />)).toContain("generic-integration-icon");
  });

  it("iMessage 渠道使用专用图标，不落到通用兜底", () => {
    const html = renderToString(<IntegrationLogoBadge slug="imessage" name="iMessage" surface="channel" />);

    expect(html).toContain("channel-integration-icon-badge");
    expect(html).toContain("channel-integration-icon-imessage");
    expect(html).not.toContain("generic-integration-icon-badge");
  });

  it("飞书、钉钉和微信渠道使用本地品牌 logo，不走 Composio 也不落到通用兜底", () => {
    const cases = [
      renderToString(<IntegrationLogoBadge slug="feishu" name="飞书" surface="channel" />),
      renderToString(<IntegrationLogoBadge slug="dingtalk" name="钉钉" surface="channel" />),
      renderToString(<IntegrationLogoBadge slug="wechat" name="微信" surface="channel" />)
    ];

    for (const html of cases) {
      expect(html).toContain("integration-logo-image");
      expect(html).not.toContain("https://logos.composio.dev");
      expect(html).not.toContain("channel-integration-icon-badge");
      expect(html).not.toContain("generic-integration-icon-badge");
    }
  });

  it("只拆分桌面端支持的 6 个 IM 渠道标题后缀", () => {
    expect([
      "安排发布 · Telegram",
      "安排发布 · 微信",
      "安排发布 · Discord",
      "安排发布 · iMessage",
      "安排发布 · 飞书",
      "安排发布 · DingTalk"
    ].map((title) => imChannelTitleDisplay(title)?.slug)).toEqual([
      "telegram",
      "wechat",
      "discord",
      "imessage",
      "feishu",
      "dingtalk"
    ]);
    expect(imChannelTitleDisplay("安排发布 · Slack")).toBeNull();
    expect(imChannelTitleDisplay("普通 GUI 任务")).toBeNull();
  });

  it("IM 标题图标复用渠道 logo，并使用紧凑尺寸", () => {
    const html = renderToString(<ImChannelTitleIcon slug="wechat" name="微信" />);

    expect(html).toContain("im-channel-title-icon");
    expect(html).toContain('aria-label="微信 logo"');
    expect(html).toContain("h-4 w-4");
    expect(html).toContain("integration-logo-image");
  });

  it("按类别组织方式映射代表 slug", () => {
    expect(CATEGORY_TABS).toEqual(["All", "Chat", "Productivity", "Tools & Automation", "Social", "Platform"]);
    expect(guessIntegrationCategory("slack", "Slack")).toBe("Chat");
    expect(guessIntegrationCategory("googledocs", "Google Docs")).toBe("Productivity");
    expect(guessIntegrationCategory("github", "GitHub")).toBe("Platform");
    expect(guessIntegrationCategory("instagram", "Instagram")).toBe("Social");
  });

  it("为共享队列覆盖 14 个固定 IM 渠道及别名", () => {
    expect(Object.keys(AGENT_CHANNEL_DISPLAY_BY_SLUG)).toEqual([
      "dingtalk",
      "discord",
      "feishu",
      "imessage",
      "matrix",
      "mochat",
      "msteams",
      "qq",
      "signal",
      "slack",
      "telegram",
      "wecom",
      "weixin",
      "whatsapp"
    ]);
    expect(agentChannelDisplay("weixin")).toMatchObject({ logoSlug: "wechat" });
    expect(agentChannelDisplay("msteams")).toMatchObject({ logoSlug: "microsoft_teams" });
    expect(agentChannelDisplay("unknown")).toBeNull();
    expect(renderToString(<AgentQueueChannelIcon channel="weixin" />)).not.toContain("logos.composio.dev");
    expect(renderToString(<AgentQueueChannelIcon channel="msteams" />)).toContain("microsoft_teams");
    expect(renderToString(<AgentQueueChannelIcon channel="imessage" />)).toContain("channel-integration-icon-imessage");
    expect(renderToString(<AgentQueueChannelIcon channel="unknown" />)).toContain("lucide-message-circle");
  });
});
