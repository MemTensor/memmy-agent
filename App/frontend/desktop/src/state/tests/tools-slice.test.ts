/** Tools slice tests. */
import { describe, expect, it } from "vitest";
import type { IntegrationConnection } from "../../integrations/connection-state.js";
import type { IntegrationMeta } from "../../integrations/integration-meta.js";
import {
  initialToolsState,
  selectConnectionForIntegration,
  selectStatusPrioritizedIntegrations,
  selectVisibleIntegrations,
  toolsReducer
} from "../tools-slice.js";

const github: IntegrationMeta = {
  slug: "github",
  name: "GitHub",
  description: "Connect GitHub.",
  category: "Platform",
  logoUrl: "https://logos.composio.dev/api/github",
  permissionLabel: "Repos and system data",
  authKind: "oauth",
  surface: "integration",
  identity: "integration:github",
  isChannel: false
};

const slack: IntegrationMeta = {
  ...github,
  slug: "slack",
  name: "Slack",
  category: "Chat",
  logoUrl: "https://logos.composio.dev/api/slack",
  permissionLabel: "Messages and channels",
  identity: "integration:slack"
};

const connection: IntegrationConnection = { id: "conn-github", toolkit: "github", status: "ACTIVE" };

describe("tools-slice", () => {
  it("加载 connections 并按 slug 查询", () => {
    const loading = toolsReducer(initialToolsState, { type: "tools/loadStart" });
    const ready = toolsReducer(loading, {
      type: "tools/loadSuccess",
      connections: [connection]
    });

    expect(ready.status).toBe("ready");
    expect(selectConnectionForIntegration(ready, github)).toEqual(connection);
  });

  it("保存当前打开工具的 surface 和 slug", () => {
    const open = toolsReducer(initialToolsState, { type: "tools/openToolModal", surface: "integration", slug: "github" });
    const closed = toolsReducer(open, { type: "tools/closeModal" });

    expect(open.modal).toEqual({ kind: "integration", slug: "github" });
    expect(closed.modal).toEqual({ kind: "closed" });
  });

  it("同名 Discord 渠道和 Composio 集成按 surface 分开匹配连接态", () => {
    const channelDiscord: IntegrationMeta = {
      ...github,
      slug: "discord",
      name: "Discord",
      category: "Chat",
      surface: "channel",
      identity: "channel:discord",
      isChannel: true
    };
    const integrationDiscord: IntegrationMeta = {
      ...channelDiscord,
      surface: "integration",
      identity: "integration:discord",
      isChannel: false
    };
    const state = toolsReducer(initialToolsState, {
      type: "tools/loadSuccess",
      connections: [
        { id: "conn-discord", toolkit: "discord", status: "ACTIVE", surface: "integration" },
        { id: "channel-discord-local", toolkit: "discord", status: "connected", surface: "channel" }
      ]
    });

    expect(selectConnectionForIntegration(state, integrationDiscord)?.id).toBe("conn-discord");
    expect(selectConnectionForIntegration(state, channelDiscord)?.id).toBe("channel-discord-local");
    expect(toolsReducer(initialToolsState, { type: "tools/openToolModal", surface: "integration", slug: "discord" }).modal).toEqual({
      kind: "integration",
      slug: "discord"
    });
    expect(toolsReducer(initialToolsState, { type: "tools/openToolModal", surface: "channel", slug: "discord" }).modal).toEqual({
      kind: "channel",
      slug: "discord"
    });
  });

  it("按搜索词和类别过滤 catalog", () => {
    expect(selectVisibleIntegrations([github, slack], "git", "All").map((item) => item.slug)).toEqual(["github"]);
    expect(selectVisibleIntegrations([github, slack], "", "Chat").map((item) => item.slug)).toEqual(["slack"]);
  });

  it("有连接状态的工具排在前面，同组保持 catalog 原顺序", () => {
    const state = toolsReducer(initialToolsState, {
      type: "tools/loadSuccess",
      connections: [{ id: "conn-slack", toolkit: "slack", status: "ACTIVE", surface: "integration" }]
    });

    expect(selectStatusPrioritizedIntegrations([github, slack], state).map((item) => item.slug)).toEqual(["slack", "github"]);
    expect(selectStatusPrioritizedIntegrations([github, slack], initialToolsState).map((item) => item.slug)).toEqual(["github", "slack"]);
  });
});
