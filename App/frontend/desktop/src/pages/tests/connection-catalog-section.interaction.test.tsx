// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { getIntegrationMeta } from "../../integrations/integration-meta.js";
import { initialToolsState } from "../../state/tools-slice.js";
import { ConnectionCatalogSection, type ConnectionCatalogSectionProps } from "../connection-catalog-section.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const github = getIntegrationMeta("github", "integration")!;
const discordTool = getIntegrationMeta("discord", "integration")!;
const discordChannel = getIntegrationMeta("discord", "channel")!;

describe("ConnectionCatalogSection", () => {
  let container: HTMLDivElement;
  let root: Root;
  let props: ConnectionCatalogSectionProps;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    props = {
      kind: "tools", items: [github, discordTool], tools: { ...initialToolsState, status: "ready" },
      search: "", onSearchChange: vi.fn(), filter: "all", onFilterChange: vi.fn(),
      connectedCount: 0, onOpenIntegration: vi.fn(), onRefresh: vi.fn(),
      activeCategory: "All", onCategoryChange: vi.fn()
    };
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  async function render(patch: Partial<ConnectionCatalogSectionProps> = {}, language = "zh-CN") {
    props = { ...props, ...patch };
    await act(async () => root.render(<I18nProvider language={language}><ConnectionCatalogSection {...props} /></I18nProvider>));
  }

  function button(label: string): HTMLButtonElement {
    const found = Array.from(container.querySelectorAll("button")).find((element) => element.textContent === label || element.getAttribute("aria-label") === label);
    if (!found) throw new Error(`Missing button: ${label}`);
    return found;
  }

  async function click(label: string) { await act(async () => button(label).click()); }

  it("places the previous tools-page connect illustration next to the catalog heading", async () => {
    await render();
    const heading = container.querySelector(".extension-catalog-heading")!;
    expect(heading.querySelector("img")?.getAttribute("alt")).toBe("Memmy");
    expect(heading.querySelector("h2")?.textContent).toBe("应用工具");
    await render({ kind: "channels", items: [discordChannel] });
    expect(container.querySelector(".extension-catalog-heading img")?.getAttribute("alt")).toBe("Memmy");
    expect(container.querySelector(".extension-catalog-heading h2")?.textContent).toBe("聊天渠道");
  });

  it("reports search changes and preserves the parent-provided item order", async () => {
    await render({ items: [discordTool, github] });
    const input = container.querySelector<HTMLInputElement>('input[aria-label="搜索应用工具"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "git");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(props.onSearchChange).toHaveBeenCalledExactlyOnceWith("git");
    expect(Array.from(container.querySelectorAll("article")).map((item) => item.getAttribute("aria-label"))).toEqual([
      "Discord · 应用工具", "GitHub · 应用工具"
    ]);
    await render({ search: "git", items: [github] });
    expect(container.querySelectorAll("article")).toHaveLength(1);
    expect(input.value).toBe("git");
  });

  it("reports all and connected filter changes without inventing connection state", async () => {
    await render({ connectedCount: 3 });
    await click("已连接 (3)");
    expect(props.onFilterChange).toHaveBeenCalledExactlyOnceWith("connected");
    expect(button("全部").getAttribute("aria-pressed")).toBe("true");
    await render({ filter: "connected", items: [] });
    expect(button("已连接 (3)").getAttribute("aria-pressed")).toBe("true");
    expect(container.textContent).toContain("暂无已连接项目");
    await click("全部");
    expect(props.onFilterChange).toHaveBeenLastCalledWith("all");
  });

  it("keeps category values intact while displaying Chinese labels only for app tools", async () => {
    await render();
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="工具类别"]')!;
    expect(Array.from(select.options).map((option) => option.textContent)).toContain("效率办公");
    await act(async () => {
      select.value = "Productivity";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(props.onCategoryChange).toHaveBeenCalledExactlyOnceWith("Productivity");
    await render({ kind: "channels", items: [discordChannel] });
    expect(container.querySelector("select")).toBeNull();
    expect(container.querySelector('input[aria-label="搜索聊天渠道"]')).not.toBeNull();
    await render({ kind: "tools", onCategoryChange: undefined });
    expect(container.querySelector("select")).toBeNull();
  });

  it("uses Connect for an app account and passes the original integration object", async () => {
    await render({ items: [github] });
    expect(container.querySelector("article .plugin-marketplace-name")?.textContent).toBe("GitHub");
    expect(container.querySelector("article")?.textContent).toBe("GitHub");
    expect(container.querySelector("article .plugin-marketplace-description")).toBeNull();
    expect(container.textContent).not.toContain("连接 GitHub 账号，在任务中使用");
    expect(container.textContent).not.toContain("安装");
    expect(button("连接GitHub应用工具").querySelector(".lucide-plus")).not.toBeNull();
    await click("连接GitHub应用工具");
    expect(props.onOpenIntegration).toHaveBeenCalledExactlyOnceWith(github);
    await click("查看GitHub应用工具");
    expect(props.onOpenIntegration).toHaveBeenLastCalledWith(github);
  });

  it("separates a connected Discord chat channel from the unconnected Discord app tool", async () => {
    const tools = { ...initialToolsState, status: "ready" as const, connections: [
      { id: "discord-channel", toolkit: "discord", surface: "channel" as const, status: "connected" }
    ] };
    await render({ items: [discordTool], tools, kind: "tools" });
    expect(container.querySelector("article")?.getAttribute("data-surface")).toBe("integration");
    expect(container.querySelector("article [role=status]")).toBeNull();
    await click("连接Discord应用工具");
    expect(props.onOpenIntegration).toHaveBeenNthCalledWith(1, discordTool);
    await render({ items: [discordChannel], kind: "channels", connectedCount: 1 });
    expect(container.querySelector("article")?.getAttribute("data-surface")).toBe("channel");
    expect(container.querySelector("article .plugin-marketplace-name")?.textContent).toBe("Discord");
    expect(container.querySelector("article .plugin-marketplace-description")).toBeNull();
    expect(container.textContent).not.toContain("从 Discord 向 Memmy 发送任务");
    expect(container.querySelector("article .plugin-marketplace-text [role=status]")?.textContent).toBe("已连接");
    expect(button("管理Discord聊天渠道").querySelector(".lucide-ellipsis")).not.toBeNull();
    await click("管理Discord聊天渠道");
    expect(props.onOpenIntegration).toHaveBeenNthCalledWith(2, discordChannel);
  });

  it.each([
    ["pending", "连接中", "管理GitHub应用工具"],
    ["expired", "已过期", "重新连接GitHub应用工具"],
    ["failed", "连接失败", "重新连接GitHub应用工具"]
  ])("shows %s status with the appropriate connection action", async (status, label, action) => {
    await render({ items: [github], tools: { ...initialToolsState, status: "ready", connections: [
      { id: "github-connection", toolkit: "github", status }
    ] } });
    expect(container.querySelector("article .plugin-marketplace-name")?.textContent).toBe("GitHub");
    expect(container.querySelector("article .plugin-marketplace-text [role=status]")?.textContent).toBe(label);
    await click(action);
    expect(props.onOpenIntegration).toHaveBeenCalledExactlyOnceWith(github);
  });

  it("disables connection actions during loading and allows error recovery by refreshing", async () => {
    await render({ loading: true, items: [github] });
    expect(button("连接GitHub应用工具").disabled).toBe(true);
    expect(button("查看GitHub应用工具").disabled).toBe(true);
    expect(button("刷新").disabled).toBe(true);
    await click("连接GitHub应用工具");
    expect(props.onOpenIntegration).not.toHaveBeenCalled();
    await render({ loading: false, error: "连接状态读取失败" });
    expect(container.querySelector("[role=alert]")?.textContent).toBe("连接状态读取失败");
    await click("刷新");
    expect(props.onRefresh).toHaveBeenCalledOnce();
  });

  it.each([
    { kind: "tools" as const, item: github, heading: "App tools", noun: "app tool", searchLabel: "Search app tools" },
    { kind: "channels" as const, item: discordChannel, heading: "Chat channels", noun: "chat channel", searchLabel: "Search chat channels" }
  ])("shows English names and connection actions without repeated descriptions for $kind", async ({ kind, item, heading, noun, searchLabel }) => {
    await render({ kind, items: [item] }, "en-US");
    expect(container.querySelector("h2")?.textContent).toBe(heading);
    expect(container.querySelector("article .plugin-marketplace-name")?.textContent).toBe(item.name);
    expect(container.querySelector("article")?.textContent).toBe(item.name);
    expect(container.querySelector(".plugin-marketplace-description")).toBeNull();
    await click(`Connect ${item.name} ${noun}`);
    expect(props.onOpenIntegration).toHaveBeenCalledExactlyOnceWith(item);
    expect(container.querySelector(`input[aria-label="${searchLabel}"]`)).not.toBeNull();
    if (kind === "tools") expect(container.querySelector("option")?.textContent).toBe("All categories");
    else expect(container.querySelector("select")).toBeNull();
    await render({ tools: { ...initialToolsState, status: "ready", connections: [
      { id: "connected", toolkit: item.slug, surface: item.surface, status: "connected" }
    ] } }, "en-US");
    expect(container.querySelector("article .plugin-marketplace-text [role=status]")?.textContent).toBe("Connected");
    await click(`Manage ${item.name} ${noun}`);
    expect(props.onOpenIntegration).toHaveBeenLastCalledWith(item);
  });
});
