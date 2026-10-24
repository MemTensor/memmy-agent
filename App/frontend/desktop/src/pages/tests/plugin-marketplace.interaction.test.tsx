// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstalledPluginSchema, type PluginPermission } from "@memmy/local-api-contracts";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { PluginMarketplace } from "../plugin-marketplace.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const context = vi.hoisted(() => ({
  clients: null as unknown,
  dispatch: vi.fn(),
  state: {
    account: { userId: "account-a" as string | null },
    agent: { currentChatId: null as string | null, newChatRequestId: 0, composerDraftsByScope: {} as Record<string, string> }
  }
}));
vi.mock("../../app/providers.js", () => ({ useApiClients: () => ({ clients: context.clients }) }));
vi.mock("../../state/app-state.js", () => ({ useAppState: () => ({ state: context.state, dispatch: context.dispatch }) }));

const pending = InstalledPluginSchema.parse({
  id: "literature-review", version: "0.5.18", state: "pending_approval", config: {},
  approvedPermissions: [], lastError: null, createdAt: "2026-09-14T00:00:00Z", updatedAt: "2026-09-14T00:00:00Z",
  manifest: { apiVersion: "memmy/v1", id: "literature-review", name: "文献综述", version: "0.5.18",
    runtime: { adapter: "command" }, permissions: [{ type: "network", hosts: ["arxiv.org"] }],
    capabilities: [{ id: "review", name: "Review", description: "Review", inputSchema: {}, outputSchema: {}, execution: "job" }] }
});

const legal = InstalledPluginSchema.parse({
  id: "legal-labor", version: "0.1.0-test.1", state: "active", config: {},
  approvedPermissions: [], lastError: null, createdAt: "2026-10-22T00:00:00Z", updatedAt: "2026-10-22T00:00:00Z",
  manifest: { apiVersion: "memmy/v1", id: "legal-labor", name: "用工合规诊断", version: "0.1.0-test.1",
    requiredEntitlement: "plugin:legal-labor", runtime: { adapter: "command" }, permissions: [],
    capabilities: [{ id: "session-start", name: "开始诊断", description: "收集材料并生成用工合规诊断报告。", inputSchema: {}, outputSchema: {}, execution: "request" }] }
});

describe("live marketplace controller", () => {
  let root: Root;
  let container: HTMLDivElement;
  let records: typeof pending[];
  let clients: ReturnType<typeof createClients>;

  function createClients() {
    return {
      plugins: {
        list: vi.fn(async () => [...records]),
        catalog: vi.fn(async () => [{ manifest: { ...pending.manifest, name: "文献综述", version: "0.5.18",
          rules: { requiresLogin: true, recommendsOfficialModel: true } },
          eligibility: { visible: true, canInstall: Boolean(context.state.account.userId), canUse: Boolean(context.state.account.userId), reason: context.state.account.userId ? null : "login_required" } }]),
        install: vi.fn(async () => { records = [pending]; return pending; }),
        update: vi.fn(async (_id: string, version: string) => {
          records = [{ ...records[0], version, manifest: { ...records[0].manifest, version } }];
          return records[0];
        }),
        approvePermissions: vi.fn(async (_pluginId: string, permissions: PluginPermission[]) => {
          records = [{ ...records[0], approvedPermissions: permissions, state: "installed" }];
          return records[0];
        }),
        enable: vi.fn(async () => { records = [{ ...records[0], state: "active" }]; return records[0]; }),
        uninstall: vi.fn(async () => { records = []; })
      },
      config: { getModelConfig: vi.fn(async () => ({ catalog: { effectiveCandidates: { account: [
        { source: "account", ownerAccountId: "account-a", available: true, capabilities: ["agent"] }
      ] } } })) }
    };
  }

  beforeEach(() => {
    records = [];
    clients = createClients(); context.clients = clients;
    context.dispatch.mockReset();
    context.state.account.userId = "account-a";
    context.state.agent = { currentChatId: null, newChatRequestId: 0, composerDraftsByScope: {} };
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); document.body.replaceChildren(); });
  async function render() {
    await act(async () => root.render(<I18nProvider language="zh-CN"><PluginMarketplace /></I18nProvider>));
  }
  function button(label: string, scope: ParentNode = container) {
    const found = [...scope.querySelectorAll("button")].find((item) => item.textContent === label || item.getAttribute("aria-label") === label);
    if (!found) throw new Error(`Missing button ${label}`);
    return found;
  }
  async function click(label: string, scope?: ParentNode) { await act(async () => button(label, scope).click()); }

  function addToChatButton() {
    return container.querySelector('article[aria-label="文献综述"] [aria-label="将文献综述加入对话"]');
  }

  it.each(["list", "details"])("updates from %s and reads back the host version before removing the update action", async (source) => {
    records = [{ ...pending, version: "0.5.17", manifest: { ...pending.manifest, version: "0.5.17" }, state: "active" }];
    await render();
    if (source === "details") await click("查看文献综述详情");
    await click("更新文献综述", source === "details" ? document.querySelector("[role=dialog]")! : container);
    expect(clients.plugins.update).toHaveBeenCalledExactlyOnceWith("literature-review", "0.5.18");
    expect(clients.plugins.install).not.toHaveBeenCalled();
    expect(clients.plugins.enable).not.toHaveBeenCalled();
    expect(records[0].state).toBe("active");
    expect(container.querySelector('[aria-label="更新文献综述"]')).toBeNull();
    expect(addToChatButton()).not.toBeNull();
    if (source === "details") expect(document.querySelector(".plugin-marketplace-detail-status")?.textContent).toContain("已安装 · v0.5.18");
  });

  it.each(["active", "disabled"] as const)("handles new update permissions and preserves the previous %s state", async (state) => {
    records = [{ ...pending, version: "0.5.17", state }];
    clients.plugins.update.mockImplementationOnce(async () => { records = [pending]; return pending; });
    await render();
    await click("更新文献综述");
    expect(clients.plugins.approvePermissions).toHaveBeenCalledExactlyOnceWith(pending.id, pending.manifest.permissions);
    expect(clients.plugins.enable).toHaveBeenCalledTimes(state === "active" ? 1 : 0);
  });

  it("blocks duplicate updates and refreshes the old version after a failed download", async () => {
    records = [{ ...pending, version: "0.5.17", state: "active" }];
    let rejectUpdate!: (error: Error) => void;
    clients.plugins.update.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectUpdate = reject; }));
    await render();
    await click("查看文献综述详情");
    const dialog = document.querySelector("[role=dialog]")!;
    await act(async () => { button("更新文献综述", dialog).click(); button("更新文献综述", dialog).click(); });
    expect(clients.plugins.update).toHaveBeenCalledTimes(1);
    expect(button("更新文献综述", dialog).disabled).toBe(true);
    expect(button("刷新").disabled).toBe(true);
    await act(async () => rejectUpdate(new Error("download failed")));
    expect(dialog.querySelector("[role=alert]")?.textContent).toContain("操作未完成，请重试");
    expect(dialog.querySelector(".plugin-marketplace-detail-status")?.textContent).toContain("已安装 · v0.5.17");
    expect(button("更新文献综述", dialog).disabled).toBe(false);
    await click("更新文献综述", dialog);
    expect(records[0].version).toBe("0.5.18");
    expect(dialog.querySelector("[role=alert]")).toBeNull();
  });

  it("makes the catalog usable while the model configuration request is still pending", async () => {
    let resolveModel!: (value: Awaited<ReturnType<typeof clients.config.getModelConfig>>) => void;
    clients.config.getModelConfig.mockImplementationOnce(() => new Promise((resolve) => { resolveModel = resolve; }));
    await render();
    expect(clients.plugins.list).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain("正在加载插件");
    expect(button("安装文献综述").disabled).toBe(false);
    await act(async () => resolveModel({ catalog: { effectiveCandidates: { account: [] } } }));
    expect(button("安装文献综述").disabled).toBe(false);
  });

  it.each(["list", "details"])("installs and activates an official plugin with one click from %s", async (source) => {
    const hostPermissions: PluginPermission[] = [{ type: "network", hosts: ["arxiv.org", "api.crossref.org"] }];
    const hostPlugin = { ...pending, manifest: { ...pending.manifest, permissions: hostPermissions } };
    clients.plugins.install.mockImplementationOnce(async () => { records = [hostPlugin]; return hostPlugin; });
    await render();
    if (source === "details") await click("查看文献综述详情");
    await click("安装文献综述", source === "details" ? document.querySelector("[role=dialog]")! : container);
    expect(clients.plugins.install).toHaveBeenCalledExactlyOnceWith("literature-review", "0.5.18");
    expect(container.querySelector(".confirm-dialog")).toBeNull();
    expect(document.querySelector("[role=dialog]")).toBeNull();
    expect(clients.plugins.approvePermissions).toHaveBeenCalledExactlyOnceWith("literature-review", hostPermissions);
    expect(clients.plugins.enable).toHaveBeenCalledExactlyOnceWith("literature-review");
    expect(clients.plugins.install.mock.invocationCallOrder[0]).toBeLessThan(clients.plugins.approvePermissions.mock.invocationCallOrder[0]);
    expect(clients.plugins.approvePermissions.mock.invocationCallOrder[0]).toBeLessThan(clients.plugins.enable.mock.invocationCallOrder[0]);
    expect(clients.plugins.enable.mock.invocationCallOrder[0]).toBeLessThan(clients.plugins.list.mock.invocationCallOrder.at(-1)!);
    expect(records[0].state).toBe("active");
    expect(addToChatButton()).not.toBeNull();
    expect(container.textContent).not.toContain("需授权");
  });

  it.each(["approvePermissions", "enable"] as const)("reads back partial state after %s fails and retries without reinstalling", async (stage) => {
    if (stage === "approvePermissions") {
      clients.plugins.approvePermissions.mockRejectedValueOnce(new Error("approval failed"));
    } else {
      clients.plugins.enable.mockImplementationOnce(async () => {
        records = [{ ...records[0], state: "failed", lastError: "activation failed" }];
        throw new Error("activation failed");
      });
    }
    await render();
    await click("安装文献综述");
    expect(records[0].state).toBe(stage === "approvePermissions" ? "pending_approval" : "failed");
    expect(addToChatButton()).toBeNull();
    expect(container.textContent).toContain("操作未完成，请重试");
    expect(button("重试安装文献综述").disabled).toBe(false);
    if (stage === "approvePermissions") expect(clients.plugins.enable).not.toHaveBeenCalled();

    await click("重试安装文献综述");
    expect(clients.plugins.install).toHaveBeenCalledTimes(1);
    expect(clients.plugins.approvePermissions).toHaveBeenCalledTimes(2);
    expect(records[0].state).toBe("active");
    expect(addToChatButton()).not.toBeNull();
    expect(container.textContent).not.toContain("操作未完成");
  });

  it("completes a historical pending installation without another install request", async () => {
    records = [pending];
    await render();
    await click("重试安装文献综述");
    expect(clients.plugins.install).not.toHaveBeenCalled();
    expect(clients.plugins.approvePermissions).toHaveBeenCalledExactlyOnceWith("literature-review", pending.manifest.permissions);
    expect(clients.plugins.enable).toHaveBeenCalledExactlyOnceWith("literature-review");
    expect(addToChatButton()).not.toBeNull();
  });

  it("holds one busy transaction through installation and activation", async () => {
    let finishInstall!: (plugin: typeof pending) => void;
    let finishEnable!: (plugin: typeof pending) => void;
    clients.plugins.install.mockImplementationOnce(() => new Promise((resolve) => { finishInstall = resolve; }));
    clients.plugins.enable.mockImplementationOnce(() => new Promise((resolve) => { finishEnable = resolve; }));
    await render();
    const installButton = button("安装文献综述");
    await act(async () => { installButton.click(); installButton.click(); });
    expect(clients.plugins.install).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[aria-label="安装文献综述"]')).toBeNull();
    expect(button("刷新").disabled).toBe(true);
    expect(clients.plugins.approvePermissions).not.toHaveBeenCalled();
    await act(async () => { records = [pending]; finishInstall(pending); });
    expect(clients.plugins.approvePermissions).toHaveBeenCalledTimes(1);
    expect(clients.plugins.enable).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[aria-label="正在处理文献综述"]')).not.toBeNull();
    expect(button("刷新").disabled).toBe(true);
    await act(async () => { records = [{ ...records[0], state: "active" }]; finishEnable(records[0]); });
    expect(addToChatButton()).not.toBeNull();
  });

  it("does not publish active state when final readback fails", async () => {
    await render();
    clients.plugins.list.mockRejectedValueOnce(new Error("readback failed"));
    await click("安装文献综述");
    expect(clients.plugins.enable).toHaveBeenCalledTimes(1);
    expect(addToChatButton()).toBeNull();
    expect(container.textContent).toContain("插件列表加载失败");
    expect(button("安装文献综述").disabled).toBe(true);
    await click("刷新");
    expect(clients.plugins.install).toHaveBeenCalledTimes(1);
    expect(addToChatButton()).not.toBeNull();
  });

  it("does not turn an API failure into a forthcoming release and refresh recovers", async () => {
    clients.plugins.list.mockRejectedValueOnce(new Error("offline"));
    await render();
    expect(container.textContent).toContain("插件列表加载失败");
    expect(button("安装文献综述").disabled).toBe(true);
    expect(container.querySelector('article[aria-label="文献综述"]')?.textContent).not.toContain("即将上线");
    // The server catalog remains visible when reading installation state fails.
    expect(container.textContent).not.toContain("即将上线");
    await click("刷新");
    expect(button("安装文献综述").disabled).toBe(false);
    expect(container.textContent).not.toContain("插件列表加载失败");
  });

  it("keeps uninstall available when model settings cannot be read", async () => {
    records = [{ ...pending, state: "active" }];
    clients.config.getModelConfig.mockRejectedValue(new Error("offline"));
    await render();
    expect(container.textContent).toContain("无法读取模型配置");
    expect(container.textContent).not.toContain("配置官方模型");
    await click("文献综述更多操作"); await click("卸载");
    await click("卸载", document.querySelector("[role=dialog]")!);
    expect(clients.plugins.uninstall).toHaveBeenCalledWith("literature-review");
    expect(button("安装文献综述").disabled).toBe(false);
    expect(addToChatButton()).toBeNull();
  });

  it("keeps an entitled legal plugin visible after uninstall and allows reinstall", async () => {
    records = [legal];
    clients.plugins.catalog.mockResolvedValue([{
      manifest: legal.manifest,
      eligibility: { visible: true, canInstall: true, canUse: true, reason: null }
    }]);
    clients.plugins.install.mockImplementationOnce(async () => {
      records = [{ ...legal, state: "installed" }];
      return records[0];
    });
    await render();

    const legalCard = container.querySelector('article[aria-label="用工合规诊断"]')!;
    expect(legalCard).not.toBeNull();
    expect(legalCard.querySelector(".plugin-marketplace-icon--legal")).not.toBeNull();
    await click("用工合规诊断更多操作");
    await click("卸载");
    await click("卸载", document.querySelector("[role=dialog]")!);

    expect(clients.plugins.uninstall).toHaveBeenCalledWith("legal-labor");
    expect(container.querySelector('article[aria-label="用工合规诊断"]')).not.toBeNull();
    expect(button("安装用工合规诊断").disabled).toBe(false);

    await click("安装用工合规诊断");
    expect(clients.plugins.install).toHaveBeenCalledWith("legal-labor", "0.1.0-test.1");
    expect(clients.plugins.enable).toHaveBeenCalledWith("legal-labor");
    expect(container.querySelector('article[aria-label="用工合规诊断"] [aria-label="将用工合规诊断加入对话"]')).not.toBeNull();
  });

  it("adds the plugin command to the current chat composer and opens the chat", async () => {
    records = [{ ...pending, state: "active" }];
    context.state.agent = {
      currentChatId: "chat-1",
      newChatRequestId: 3,
      composerDraftsByScope: { "chat-1": "比较两篇论文" }
    };
    await render();
    await click("将文献综述加入对话");
    expect(context.dispatch).toHaveBeenCalledWith({
      type: "agent/composerDraftUpdated",
      scopeKey: "chat-1",
      value: "/literature-review  比较两篇论文"
    });
    expect(context.dispatch).toHaveBeenCalledWith({ type: "navigation/changed", path: "/main" });
  });

  it("shows per-plugin sign-in prompts instead of a catalog-wide wall when signed out", async () => {
    context.state.account.userId = null;
    await render();
    // No section-wide login wall: the catalog stays visible and gating is per plugin.
    expect(container.textContent).not.toContain("请先登录");
    expect(container.querySelector("article")).not.toBeNull();
    expect(button("登录后使用文献综述")).toBeTruthy();
    await click("登录后使用文献综述");
    expect(context.dispatch).toHaveBeenCalledWith({ type: "navigation/changed", path: "/welcome" });
    expect(clients.plugins.install).not.toHaveBeenCalled();
  });
});
