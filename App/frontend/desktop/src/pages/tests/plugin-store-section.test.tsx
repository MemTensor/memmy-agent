// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { PluginStoreSection } from "../plugin-store-section.js";
import type { PluginsClient } from "../../api/plugins-client.js";

let root: Root, node: HTMLDivElement;
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; node = document.createElement("div"); document.body.appendChild(node); root = createRoot(node); });
afterEach(async () => { await act(async () => root.unmount()); node.remove(); });
const item = { id: "fixture.capture", name: "Capture Plugin", description: "事件采集插件", version: "0.1.0", platforms: ["win32"], installMode: "manual", updateMode: "automatic" };
function fixture() {
  let installed: any[] = [];
  const plugin = { id: item.id, version: item.version, state: "pending_approval", manifest: { ...item,
    permissions: [{ type: "host-service", services: ["native-execution"], description: "读取已授权事件并保留本机插件数据。" }] } };
  const entry = { manifest: plugin.manifest, eligibility: { visible: true, canInstall: true, canUse: true, reason: null as string | null } };
  const client = { catalog: vi.fn(async () => [entry]), list: vi.fn(async () => installed),
    install: vi.fn(async () => { installed = [plugin]; return plugin; }),
    approvePermissions: vi.fn(async () => { plugin.state = "installed"; return plugin; }),
    enable: vi.fn(async () => { plugin.state = "active"; return plugin; }), disable: vi.fn(async () => { plugin.state = "disabled"; return plugin; }),
    uninstall: vi.fn(async () => { installed = []; }) };
  return { client: client as unknown as PluginsClient, mocks: client, entry };
}
async function render(client: PluginsClient, platform = "win32") {
  await act(async () => root.render(<I18nProvider language="zh-CN"><PluginStoreSection client={client} platform={platform} /></I18nProvider>));
}
function button(text: string) { return [...node.querySelectorAll("button")].find(b => b.textContent === text)!; }
describe("plugin store", () => {
  it("honors official account eligibility before installation", async () => {
    const f = fixture();
    f.entry.eligibility = { visible: true, canInstall: false, canUse: false, reason: "login_required" };
    await render(f.client);
    expect(node.textContent).toContain("登录后可用");
    expect(button("安装").disabled).toBe(true);
    expect(f.mocks.install).not.toHaveBeenCalled();
  });
  it("shows a manual install without requiring an account, then requires explicit permission approval", async () => {
    const f = fixture(); await render(f.client); expect(node.textContent).toContain("Capture Plugin");
    await act(async () => button("安装").click()); expect(f.mocks.install).toHaveBeenCalledWith("fixture.capture", "0.1.0");
    expect(f.mocks.enable).not.toHaveBeenCalled(); expect(document.body.textContent).toContain("读取已授权事件");
    const approve = [...document.querySelectorAll("button")].filter(b => b.textContent === "授权并启用").at(-1)!;
    await act(async () => approve.click()); expect(f.mocks.approvePermissions).toHaveBeenCalledOnce(); expect(f.mocks.enable).toHaveBeenCalledOnce();
    expect(node.textContent).toContain("active");
  });
  it("shows unsupported platforms and disables installation", async () => {
    const f = fixture(); await render(f.client, "darwin"); expect(button("安装").disabled).toBe(true);
    expect(node.textContent).toContain("当前平台暂不支持"); expect(f.mocks.install).not.toHaveBeenCalled();
  });
  it("keeps download failures visible and does not enable the plugin", async () => {
    const f = fixture(); f.mocks.install.mockRejectedValueOnce(new Error("checksum mismatch")); await render(f.client);
    await act(async () => button("安装").click()); expect(node.textContent).toContain("checksum mismatch"); expect(f.mocks.enable).not.toHaveBeenCalled();
  });
  it("does not start multiple downloads on rapid repeated clicks", async () => {
    const f = fixture(); await render(f.client); const install = button("安装");
    await act(async () => { install.click(); install.click(); }); expect(f.mocks.install).toHaveBeenCalledOnce();
  });
});
