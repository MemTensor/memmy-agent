/** Tools page tests. */
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ChannelsClient } from "../../api/channels-client.js";
import type { IntegrationsClient } from "../../api/integrations-client.js";
import { AppProviders } from "../../app/providers.js";
import type { IntegrationConnection } from "../../integrations/connection-state.js";
import { getAllIntegrationMeta } from "../../integrations/integration-meta.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { TaskBusProvider } from "../../lib/task-bus.js";
import { AppStateProvider } from "../../state/app-state.js";
import { initialToolsState, toolsReducer } from "../../state/tools-slice.js";
import { loadConnectionsForPage, shouldLoadConnectionsForPage, ToolsPage, ToolsPageView } from "../tools-page.js";

describe("ToolsPageView", () => {
  it("只读取连接记录，工具网格使用本地静态目录", async () => {
    const connection: IntegrationConnection = { id: "conn-github", toolkit: "github", status: "ACTIVE" };
    const client = createClient([connection]);
    const channelsClient = createChannelsClient([]);

    await expect(loadConnectionsForPage(client, channelsClient)).resolves.toEqual([{ ...connection, surface: "integration" }]);
    expect(client.listCapabilities).not.toHaveBeenCalled();
    expect(client.listConnections).toHaveBeenCalledTimes(1);
    expect(channelsClient.listConnections).toHaveBeenCalledTimes(1);
  });

  it("合并 integrations 和 channels 连接态，渠道状态转换成卡片可读记录", async () => {
    await expect(
      loadConnectionsForPage(
        createClient([{ id: "conn-github", toolkit: "github", status: "ACTIVE" }]),
        createChannelsClient([
          {
            id: "channel-wechat-local",
            provider: "wechat",
            runtimeChannel: "weixin",
            status: "connected",
            running: true,
            displayName: "WeChat"
          }
        ])
      )
    ).resolves.toEqual([
      { id: "conn-github", toolkit: "github", status: "ACTIVE", surface: "integration" },
      { id: "channel-wechat-local", toolkit: "wechat", status: "connected", surface: "channel", lastError: null }
    ]);
  });

  it("只有空闲态会自动拉取 connections，避免错误态反复重试导致提示条抖动", () => {
    expect(shouldLoadConnectionsForPage("idle")).toBe(true);
    expect(shouldLoadConnectionsForPage("error")).toBe(false);
    expect(shouldLoadConnectionsForPage("loading")).toBe(false);
    expect(shouldLoadConnectionsForPage("ready")).toBe(false);
  });

  it("渲染 routed ToolsPage", () => {
    const html = renderToString(
      <AppProviders>
        <ToolsPage />
      </AppProviders>
    );

    expect(html).toContain("工具连接");
  });

  it("渲染渠道 5 项和 managed 全表", () => {
    const html = renderView(initialToolsState);
    const catalog = getAllIntegrationMeta();

    expect(catalog.filter((item) => item.isChannel)).toHaveLength(6);
    expect(catalog.filter((item) => !item.isChannel)).toHaveLength(118);
    expect(html).toContain("Telegram");
    expect(html).toContain("WeChat");
    expect(html).toContain("GitHub");
    expect(html).toContain("integration-card-channel");
    expect(html).toContain("integration-card-integration");
    expect(html).not.toContain("ToolDetailDrawer");
    expect(html).not.toContain("modal-right");
  });

  it("保留 Memmy v2.0 页面骨架，工具卡片使用自动填充的紧凑 icon 网格", () => {
    const html = renderView(initialToolsState);

    expect(html).toContain("app-frame-page-content h-full overflow-y-auto py-6");
    expect(html).toContain('data-tour-anchor="product-tour-tools-content"');
    expect(html).toContain("tools-icon-grid");
    expect(html).not.toContain("w-full max-w-3xl space-y-4");
    expect(html).not.toContain("grid grid-cols-4 gap-3 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-7");
    expect(html).not.toContain("rounded-2xl border border-border-stone/35 bg-background-paper p-3 shadow-sm ring-1 ring-black/5");
  });

  it("搜索框使用搜索图标而不是字母占位", () => {
    const html = renderView(initialToolsState);

    expect(html).toContain("lucide-search");
    expect(html).not.toContain(">S</span>");
  });

  it("搜索过滤 GitHub", () => {
    const html = renderView(initialToolsState, { search: "github" });

    expect(html).toContain("GitHub");
    expect(html).not.toContain("Airtable");
  });

  it("ready 后不按 Cloud 能力清单过滤本地静态工具", () => {
    const state = toolsReducer(initialToolsState, {
      type: "tools/loadSuccess",
      connections: []
    });
    const html = renderView(state);

    expect(html).toContain("GitHub");
    expect(html).toContain("Airtable");
  });

  it("ready 后能力清单为空也继续展示本地静态工具", () => {
    const state = toolsReducer(initialToolsState, {
      type: "tools/loadSuccess",
      connections: []
    });
    const html = renderView(state);

    expect(html).not.toContain("No matching tools");
    expect(html).toContain("GitHub");
    expect(html).toContain("Airtable");
  });

  it("有连接状态的工具在网格中排到无状态工具前面", () => {
    const state = toolsReducer(initialToolsState, {
      type: "tools/loadSuccess",
      connections: [{ id: "conn-github", toolkit: "github", status: "ACTIVE" }]
    });
    const html = renderView(state);

    expect(html.indexOf("GitHub")).toBeLessThan(html.indexOf("Airtable"));
    expect(html).toContain("Connected");
  });

  it("打开 GitHub modal 时显示连接标题", () => {
    const state = toolsReducer(initialToolsState, { type: "tools/openToolModal", surface: "integration", slug: "github" });
    const html = renderView(state);

    expect(html).toContain("Connect GitHub");
    expect(html).toContain("Connect your GitHub account.");
  });

  it("client 初始化前首次打开 GitHub modal 也显示弹窗", () => {
    const state = toolsReducer(initialToolsState, { type: "tools/openToolModal", surface: "integration", slug: "github" });
    const html = renderView(state, { client: null });

    expect(html).toContain("Connect GitHub");
    expect(html).toContain("Connect your GitHub account.");
  });

  it("打开 WeChat modal 时显示一键扫码连接，不走 OAuth integration modal", () => {
    const state = toolsReducer(initialToolsState, { type: "tools/openToolModal", surface: "channel", slug: "wechat" });
    const html = renderView(state);

    expect(html).toContain("Connect WeChat");
    expect(html).toContain("Scan with WeChat to connect this message channel.");
    expect(html).not.toContain("This channel connection is coming soon; awaiting backend");
    expect(html).not.toContain("open a browser window");
  });

  it("同名 Discord 在渠道区和集成区打开不同连接逻辑", () => {
    const integrationState = toolsReducer(initialToolsState, { type: "tools/openToolModal", surface: "integration", slug: "discord" });
    const channelState = toolsReducer(initialToolsState, { type: "tools/openToolModal", surface: "channel", slug: "discord" });
    const integrationHtml = renderView(integrationState);
    const channelHtml = renderView(channelState);

    expect(integrationHtml).toContain("Connect Discord");
    expect(integrationHtml).toContain("Connect your Discord account.");
    expect(integrationHtml).toContain("open a browser window");
    expect(integrationHtml).not.toContain("Bot Token");
    expect(channelHtml).toContain("Connect Discord");
    expect(channelHtml).toContain("Bot Token");
    expect(channelHtml).not.toContain("This channel connection is coming soon; awaiting backend");
    expect(channelHtml).not.toContain("open a browser window");
  });

  it("mock 模式打开 modal 时不显示额外 mock 提示", () => {
    const state = toolsReducer(initialToolsState, { type: "tools/openToolModal", surface: "integration", slug: "github" });
    const html = renderView(state);

    expect(html).not.toContain("border-sky-200 bg-sky-50");
  });
});

function renderView(
  tools: ReturnType<typeof toolsReducer>,
  options: { search?: string; client?: IntegrationsClient | null; channelsClient?: ChannelsClient | null } = {}
): string {
  return renderToString(
    <TaskBusProvider>
      <AppStateProvider>
        <I18nProvider language="en-US">
          <ToolsPageView
            tools={tools}
            client={options.client === undefined ? createClient([]) : (options.client ?? undefined)}
            channelsClient={options.channelsClient === undefined ? createChannelsClient([]) : (options.channelsClient ?? undefined)}
            search={options.search}
            onSearchChange={() => undefined}
            onCategoryChange={() => undefined}
            onOpenIntegration={() => undefined}
            onModalClose={() => undefined}
            onConnectionsChanged={() => undefined}
          />
        </I18nProvider>
      </AppStateProvider>
    </TaskBusProvider>
  );
}

function createClient(connections: IntegrationConnection[]): IntegrationsClient {
  return {
    authorize: vi.fn(async (slug: string) => ({ connectUrl: `https://backend.composio.dev/api/v3/s/${slug}-test`, connectionId: `conn-${slug}` })),
    listCapabilities: vi.fn(async () => ({ toolkits: ["github"] })),
    listConnections: vi.fn(async () => ({ connections })),
    deleteConnection: vi.fn(async () => undefined)
  };
}

/**
 * Creates a channels client for page tests.
 *
 * @param connections The current channel connection records.
 * @returns A ChannelsClient test instance.
 */
function createChannelsClient(connections: Awaited<ReturnType<ChannelsClient["listConnections"]>>["connections"]): ChannelsClient {
  return {
    listDefinitions: vi.fn(async () => ({ channels: [] })),
    listConnections: vi.fn(async () => ({ connections })),
    connect: vi.fn(async () => ({ status: "connected" as const, connectionId: "channel-test-local" })),
    pollConnect: vi.fn(async () => ({ status: "connected" as const, connectionId: "channel-test-local" })),
    disconnect: vi.fn(async () => undefined)
  };
}
