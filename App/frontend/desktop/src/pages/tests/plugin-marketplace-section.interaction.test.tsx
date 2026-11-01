// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InstalledPluginSchema } from "@memmy/local-api-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import {
  addPluginCommandToDraft,
  PluginMarketplaceSection,
  pluginComposerCommand,
  type MarketplacePlugin,
  type PluginMarketplaceSectionProps
} from "../plugin-marketplace-section.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const literature: MarketplacePlugin = {
  id: "literature-review",
  name: "文献综述",
  description: "检索文献并完成综述。",
  category: "research",
  defaultInstalled: true,
  requiresOfficialModel: true,
  requiresLogin: true,
  installable: true
};
const office: MarketplacePlugin = {
  id: "office",
  name: "Office",
  description: "生成和处理办公文档。",
  category: "office",
  installable: true
};

function installed(plugin: MarketplacePlugin, state: "active" | "pending_approval" | "disabled" | "failed" = "active"): MarketplacePlugin {
  return {
    ...plugin,
    installed: InstalledPluginSchema.parse({
      id: plugin.id,
      version: "1.0.0",
      manifest: {
        apiVersion: "memmy/v1", id: plugin.id, name: plugin.name, version: "1.0.0",
        runtime: { adapter: "command", config: { command: "runtime.js" } },
        capabilities: [{ id: "run", name: "Run", description: "Run", inputSchema: {}, outputSchema: {}, execution: "job" }],
        permissions: [
          { type: "network", hosts: ["arxiv.org"] },
          { type: "host-service", services: ["file-input", "plugin-data", "artifact-host", "model-inference"] }
        ]
      },
      state,
      approvedPermissions: [], config: {}, lastError: null,
      createdAt: "2026-09-14T00:00:00.000Z", updatedAt: "2026-09-14T00:00:00.000Z"
    })
  };
}

describe("PluginMarketplaceSection", () => {
  let container: HTMLDivElement;
  let root: Root;
  let props: PluginMarketplaceSectionProps;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    props = {
      plugins: [installed(literature), office], officialModelReady: true,
      onInstall: vi.fn(), onUpdate: vi.fn(), onUninstall: vi.fn(), onEnable: vi.fn(), onAddToChat: vi.fn(), onConfigureModel: vi.fn(), onRefresh: vi.fn(), onSignIn: vi.fn()
    };
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  async function render(patch: Partial<PluginMarketplaceSectionProps> = {}, language = "zh-CN") {
    props = { ...props, ...patch };
    await act(async () => root.render(<I18nProvider language={language}><PluginMarketplaceSection {...props} /></I18nProvider>));
  }

  function button(text: string, scope: ParentNode = container): HTMLButtonElement {
    const found = Array.from(scope.querySelectorAll("button")).find((item) => item.textContent === text || item.getAttribute("aria-label") === text);
    if (!found) throw new Error(`Button not found: ${text}`);
    return found;
  }

  async function click(text: string, scope?: ParentNode) {
    await act(async () => button(text, scope).click());
  }

  it.each([
    ["zh-CN", "waiting", "等待更新", "等待任务完成后更新"],
    ["zh-CN", "installing", "更新中", "正在更新…"],
    ["en-US", "waiting", "Queued", "Waiting for tasks to finish before updating"],
    ["en-US", "installing", "Updating", "Updating…"]
  ] as const)("shows a compact %s %s badge with the full explanation available", async (language, state, label, explanation) => {
    const plugin = installed({ ...literature, version: "2.0.0" });
    plugin.installed!.update = { status: state, version: "2.0.0" };
    await render({ plugins: [plugin], signedIn: true }, language);
    const badge = container.querySelector<HTMLElement>(".plugin-marketplace-update-status")!;
    expect(badge.textContent).toBe(label);
    expect(badge.getAttribute("aria-label")).toBe(explanation);
    expect(badge.getAttribute("data-update-state")).toBe(state);
    expect(badge.tabIndex).toBe(0);
    expect(badge.querySelector(".animate-spin") !== null).toBe(state === "installing");
    await act(async () => badge.focus());
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(explanation);
    await act(async () => badge.blur());
    await act(async () => container.querySelector<HTMLButtonElement>(".plugin-marketplace-summary")!.click());
    expect(document.querySelector(".plugin-marketplace-update-note")?.textContent).toBe(explanation);
    expect(document.querySelector(".plugin-marketplace-detail-actions")?.textContent).toContain(label);
  });

  async function search(value: string, label = "搜索任务插件") {
    const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
    if (!input) throw new Error(`Search input not found: ${label}`);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("offers the catalog version as an explicit update for an installed plugin", async () => {
    const plugin = { ...installed(literature), version: "1.1.0" };
    await render({ plugins: [plugin] });
    await click("更新文献综述");
    expect(props.onUpdate).toHaveBeenCalledExactlyOnceWith(plugin);
    expect(props.onInstall).not.toHaveBeenCalled();
  });

  it("does not offer a downgrade when the catalog is older than the installed version", async () => {
    await render({ plugins: [{ ...installed(literature), version: "0.9.0" }] });
    expect(container.querySelector('[aria-label="更新文献综述"]')).toBeNull();
  });

  it("presents task plugins and searches names and descriptions without changing installation counts", async () => {
    await render();
    expect(container.querySelector("h2")?.textContent).toBe("任务插件");
    expect(container.querySelector(".memory-panel__subtitle")?.textContent).toContain("完整任务能力");
    expect(container.querySelector('input[aria-label="搜索任务插件"]')?.getAttribute("placeholder")).toBe("搜索任务插件");
    await search("  oFFicE  ");
    expect(Array.from(container.querySelectorAll("article")).map((item) => item.getAttribute("aria-label"))).toEqual(["Office"]);
    expect(button("已安装 (1)")).toBeDefined();
    await search("检索文献");
    expect(Array.from(container.querySelectorAll("article")).map((item) => item.getAttribute("aria-label"))).toEqual(["文献综述"]);
    expect(button("已安装 (1)")).toBeDefined();
    expect(props.plugins).toHaveLength(2);
    expect(props.onInstall).not.toHaveBeenCalled();
    expect(props.onUninstall).not.toHaveBeenCalled();
  });

  it("intersects search with the installed filter and preserves that filter when search is cleared", async () => {
    await render();
    await search("办公文档");
    expect(container.querySelectorAll("article")).toHaveLength(1);
    await click("已安装 (1)");
    expect(container.querySelectorAll("article")).toHaveLength(0);
    expect(container.textContent).toContain("没有找到匹配的任务插件");
    expect(container.textContent).not.toContain("还没有安装插件");
    expect(button("已安装 (1)").getAttribute("aria-pressed")).toBe("true");
    await search("");
    expect(Array.from(container.querySelectorAll("article")).map((item) => item.getAttribute("aria-label"))).toEqual(["文献综述"]);
    await click("全部");
    expect(container.querySelectorAll("article")).toHaveLength(2);
  });

  it("filters installed plugins without changing the supplied catalog", async () => {
    await render();
    expect(container.querySelectorAll("article")).toHaveLength(2);
    await click("已安装 (1)");
    expect(container.querySelectorAll("article")).toHaveLength(1);
    expect(container.textContent).not.toContain("Office");
    await click("全部");
    expect(container.querySelectorAll("article")).toHaveLength(2);
    expect(props.onInstall).not.toHaveBeenCalled();
  });

  it("requires confirmation to uninstall and waits for the parent to change installation state", async () => {
    await render();
    await click("文献综述更多操作");
    await click("卸载");
    expect(props.onUninstall).not.toHaveBeenCalled();
    expect(document.querySelector("[role=dialog]")?.textContent).toContain("新任务将无法使用此插件");
    await click("取消", document.querySelector("[role=dialog]")!);
    expect(props.onUninstall).not.toHaveBeenCalled();
    await click("文献综述更多操作");
    await click("卸载");
    await click("卸载", document.querySelector("[role=dialog]")!);
    expect(props.onUninstall).toHaveBeenCalledExactlyOnceWith(props.plugins[0]);
    expect(container.querySelector('article [aria-label="将文献综述加入对话"]')).not.toBeNull();
    await render({ plugins: [literature, office] });
    expect(container.querySelector('article [aria-label="将文献综述加入对话"]')).toBeNull();
    expect(button("安装文献综述").disabled).toBe(false);
  });

  it("shows a forthcoming release honestly and never calls install", async () => {
    await render({ plugins: [{ ...office, installable: false }] });
    expect(button("即将上线").disabled).toBe(true);
    await click("即将上线");
    await click("查看Office详情");
    const dialog = document.querySelector("[role=dialog]")!;
    expect(dialog.textContent).toContain("当前尚未提供可安装版本");
    expect(button("即将上线", dialog).disabled).toBe(true);
    await click("即将上线", dialog);
    expect(props.onInstall).not.toHaveBeenCalled();
  });

  it("shows literature review model guidance without blocking custom models", async () => {
    await render({ officialModelReady: false });
    const reviewCard = container.querySelector('article[aria-label="文献综述"]')!;
    expect(reviewCard.textContent).not.toContain("需配置模型");
    expect(reviewCard.querySelector('[aria-label="将文献综述加入对话"]')).not.toBeNull();
    await click("查看文献综述详情");
    expect(document.querySelector("[role=dialog]")?.textContent).toContain("只建议使用自行配置且性能较强的模型");
    await click("加入对话", document.querySelector("[role=dialog]")!);
    expect(props.onConfigureModel).not.toHaveBeenCalled();
    expect(props.onAddToChat).toHaveBeenCalledOnce();
    expect(props.onInstall).not.toHaveBeenCalled();
    expect(document.querySelector("[role=dialog]")).toBeNull();
    expect(button("安装Office", container.querySelector('article[aria-label="Office"]')!).disabled).toBe(false);
  });

  it("installs from a catalog card with one click and no confirmation dialog", async () => {
    await render({ plugins: [office] });
    await click("安装Office");
    expect(props.onInstall).toHaveBeenCalledExactlyOnceWith(office);
    expect(document.querySelector("[role=dialog]")).toBeNull();
    expect(button("安装Office").disabled).toBe(false);
    expect(container.querySelector('article [aria-label="将Office加入对话"]')).toBeNull();
  });

  it("installs from details with one click without fabricating an installed state", async () => {
    await render({ plugins: [literature], officialModelReady: false });
    await click("查看文献综述详情");
    await click("安装文献综述", document.querySelector("[role=dialog]")!);
    expect(props.onInstall).toHaveBeenCalledExactlyOnceWith(literature);
    expect(container.querySelector(".confirm-dialog")).toBeNull();
    expect(button("安装文献综述").disabled).toBe(false);
    expect(container.querySelector('article [aria-label="将文献综述加入对话"]')).toBeNull();
  });

  it.each(["pending_approval", "disabled", "failed"] as const)("retries a %s installation immediately without an approval dialog", async (state) => {
    const plugin = installed(literature, state);
    await render({ plugins: [plugin] });
    expect(button("重试安装文献综述").textContent).toBe("重试安装");
    expect(container.textContent).not.toContain("授权");
    expect(container.querySelector('article [aria-label="将文献综述加入对话"]')).toBeNull();
    await click("重试安装文献综述");
    expect(props.onEnable).toHaveBeenCalledExactlyOnceWith(plugin);
    expect(props.onInstall).not.toHaveBeenCalled();
    expect(document.querySelector("[role=dialog]")).toBeNull();
    expect(container.querySelector('article [aria-label="将文献综述加入对话"]')).toBeNull();
  });

  it("keeps requirements and capability explanations in details without exposing a permission approval flow", async () => {
    await render({ plugins: [installed(literature, "pending_approval")] });
    expect(container.querySelector("article")?.textContent).not.toContain("默认提供");
    expect(container.querySelector("article")?.textContent).not.toContain("需官方模型");
    await click("查看文献综述详情");
    const dialog = document.querySelector("[role=dialog]")!;
    expect(dialog.querySelector("figure")).not.toBeNull();
    expect(dialog.querySelector("figure button")).toBeNull();
    expect(dialog.textContent).toContain("只建议使用自行配置且性能较强的模型");
    expect(dialog.textContent).not.toContain("能力说明");
    expect(dialog.textContent).toContain("根据研究主题检索论文");
    expect(dialog.textContent).toContain("安装未完成");
    expect(dialog.textContent).not.toContain("arxiv.org");
    expect(dialog.textContent).not.toContain("host-service");
    expect(dialog.textContent).not.toContain("授权");
    await click("重试安装文献综述", dialog);
    expect(props.onEnable).toHaveBeenCalledExactlyOnceWith(props.plugins[0]);
    expect(document.querySelector("[role=dialog]")).toBeNull();
  });

  it("disables lifecycle actions while the parent is processing a mutation", async () => {
    await render({ busyId: literature.id });
    expect(button("安装Office").disabled).toBe(true);
    expect(button("文献综述更多操作").disabled).toBe(true);
    expect(button("刷新").disabled).toBe(true);
    await click("安装Office");
    expect(props.onInstall).not.toHaveBeenCalled();
  });

  it("disables installation, activation and an already-open confirmation while refreshing", async () => {
    await render();
    await click("文献综述更多操作");
    await click("卸载");
    await render({ loading: true });
    expect(button("卸载", document.querySelector("[role=dialog]")!).disabled).toBe(true);
    await click("卸载", document.querySelector("[role=dialog]")!);
    expect(props.onUninstall).not.toHaveBeenCalled();
    await click("取消", document.querySelector("[role=dialog]")!);
    expect(button("安装Office").disabled).toBe(true);
    expect(button("文献综述更多操作").disabled).toBe(true);
    await render({ plugins: [installed(literature, "pending_approval"), office] });
    expect(button("重试安装文献综述").disabled).toBe(true);
    await click("重试安装文献综述");
    expect(props.onEnable).not.toHaveBeenCalled();
    expect(document.querySelector("[role=dialog]")).toBeNull();
  });

  it("renders a localized installed empty state and supports refresh", async () => {
    await render({ plugins: [office] }, "en-US");
    expect(container.querySelector("h2")?.textContent).toBe("Task plugins");
    await search("no match", "Search task plugins");
    expect(container.textContent).toContain("No task plugins match your search");
    await search("", "Search task plugins");
    await click("Installed (0)");
    expect(container.textContent).toContain("No plugins installed");
    await click("Refresh");
    expect(props.onRefresh).toHaveBeenCalledOnce();
  });

  it("blocks mutations after a list error while allowing refresh", async () => {
    await render();
    await click("文献综述更多操作");
    await click("卸载");
    await render({ actionsDisabled: true, error: "插件列表加载失败，请重试。" });
    expect(button("卸载", document.querySelector("[role=dialog]")!).disabled).toBe(true);
    await click("卸载", document.querySelector("[role=dialog]")!);
    expect(props.onUninstall).not.toHaveBeenCalled();
    await click("取消", document.querySelector("[role=dialog]")!);
    expect(button("安装Office").disabled).toBe(true);
    await click("文献综述更多操作");
    expect(button("卸载", container.querySelector("[role=menu]")!).disabled).toBe(true);
    expect(button("刷新").disabled).toBe(false);
    await click("刷新");
    expect(props.onRefresh).toHaveBeenCalledOnce();
    await render({ plugins: [installed(literature, "pending_approval")] });
    expect(button("重试安装文献综述").disabled).toBe(true);
  });

  it("does not mistake an unknown model state for missing configuration or block uninstall", async () => {
    await render({ officialModelReady: undefined });
    expect(container.querySelector('article[aria-label="文献综述"] [aria-label="将文献综述加入对话"]')).not.toBeNull();
    expect(container.textContent).not.toContain("需配置模型");
    expect(container.textContent).not.toContain("配置官方模型");
    await click("查看文献综述详情");
    const dialog = document.querySelector("[role=dialog]")!;
    expect(dialog.textContent).not.toContain("暂未获取模型状态");
    expect(button("卸载", dialog).disabled).toBe(false);
    await click("卸载", dialog);
    await click("卸载", document.querySelector("[role=dialog]")!);
    expect(props.onUninstall).toHaveBeenCalledExactlyOnceWith(props.plugins[0]);
    expect(props.onConfigureModel).not.toHaveBeenCalled();
  });

  it("adds an installed plugin to chat from the catalog and from details", async () => {
    await render();
    await click("将文献综述加入对话");
    expect(props.onAddToChat).toHaveBeenCalledExactlyOnceWith(props.plugins[0]);
    await click("查看文献综述详情");
    await click("加入对话", document.querySelector("[role=dialog]")!);
    expect(props.onAddToChat).toHaveBeenCalledTimes(2);
    expect(props.onAddToChat).toHaveBeenLastCalledWith(props.plugins[0]);
    expect(document.querySelector("[role=dialog]")).toBeNull();
  });

  it("gates only login-required plugins when signed out and leaves others installable", async () => {
    await render({ signedIn: false });
    // The catalog stays browsable; there is no section-wide login wall.
    expect(container.textContent).not.toContain("请先登录");
    expect(container.querySelectorAll("article")).toHaveLength(2);
    // Office declares no login requirement, so it installs without signing in.
    const officeCard = container.querySelector('article[aria-label="Office"]')!;
    await click("安装Office", officeCard);
    expect(props.onInstall).toHaveBeenCalledExactlyOnceWith(office);
    // Literature explicitly requires login; its model recommendation is independent.
    const reviewCard = container.querySelector('article[aria-label="文献综述"]')!;
    expect(reviewCard.querySelector('[aria-label="将文献综述加入对话"]')).toBeNull();
    await click("去登录", reviewCard);
    expect(props.onSignIn).toHaveBeenCalledOnce();
  });

  it("prompts sign-in from details for a login-required plugin without offering add-to-chat", async () => {
    await render({ signedIn: false });
    await click("查看文献综述详情");
    const dialog = document.querySelector("[role=dialog]")!;
    expect(dialog.textContent).toContain("需登录");
    expect(button("去登录", dialog)).toBeDefined();
    expect(Array.from(dialog.querySelectorAll("button")).some((item) => item.textContent === "加入对话")).toBe(false);
    await click("去登录", dialog);
    expect(props.onSignIn).toHaveBeenCalledOnce();
    expect(props.onInstall).not.toHaveBeenCalled();
  });
});

describe("plugin composer command", () => {
  it("uses the plugin command when present and otherwise the plugin id", () => {
    expect(pluginComposerCommand(literature)).toBeNull();
    expect(pluginComposerCommand(installed(literature, "failed"))).toBeNull();
    expect(pluginComposerCommand(installed(literature))).toBe("/literature-review");
    const withCommand = installed(literature);
    withCommand.installed = {
      ...withCommand.installed!,
      manifest: {
        ...withCommand.installed!.manifest,
        commands: [{ command: "/review", name: "Review", description: "Create a review", capabilityId: "run" }]
      }
    };
    expect(pluginComposerCommand(withCommand)).toBe("/review");
  });

  it("prepends a plugin command without duplicating it or replacing the draft", () => {
    expect(addPluginCommandToDraft("/literature-review", "")).toBe("/literature-review  ");
    expect(addPluginCommandToDraft("/literature-review", "比较两篇论文")).toBe("/literature-review  比较两篇论文");
    expect(addPluginCommandToDraft("/literature-review", "/literature-review")).toBe("/literature-review  ");
    expect(addPluginCommandToDraft("/literature-review", "/literature-review  比较两篇论文")).toBe("/literature-review  比较两篇论文");
  });
});
