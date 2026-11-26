// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemmyAgentClient } from "../../api/memmy-agent-client.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { TeachModePermissionPrompt } from "../teach-mode-permission-prompt.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const denied = { supported: true, accessibility: false, inputMonitoring: false };
const granted = { supported: true, accessibility: true, inputMonitoring: true };
const noExtensions = { chrome: { installed: false, enabled: false }, edge: { installed: false, enabled: false } };

beforeEach(() => {
  window.memmy = {
    guideMemmyPermission: vi.fn().mockResolvedValue(true),
    restartForComputerHistoryPermissions: vi.fn().mockResolvedValue(undefined),
    getBrowserExtensionInstallation: vi.fn().mockResolvedValue(noExtensions),
    prepareBrowserExtension: vi.fn().mockResolvedValue({ status: "browser-opened", directory: "/tmp/extension" }),
    dragBrowserExtension: vi.fn().mockReturnValue(true),
  } as unknown as NonNullable<Window["memmy"]>;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); document.body.replaceChildren(); Reflect.deleteProperty(window, "memmy"); });

async function render(status = denied) {
  const client = {
    checkComputerHistoryPermissions: vi.fn().mockResolvedValue(status),
    openComputerHistoryPermission: vi.fn().mockResolvedValue(status),
  };
  const onDismiss = vi.fn();
  await act(async () => { root.render(<I18nProvider language="zh-CN"><TeachModePermissionPrompt
    client={client as unknown as MemmyAgentClient} onDismiss={onDismiss} /></I18nProvider>); });
  return { client, onDismiss };
}
const card = () => container.querySelector(".teach-permission-card")!;
async function click(label: string) {
  const button = Array.from(card().querySelectorAll("button")).find(item => item.textContent?.trim() === label);
  expect(button).toBeDefined(); await act(async () => button!.click());
}

describe("Teach Mode permission prompt", () => {
  it("lists both system grants and the extension row", async () => {
    await render();
    expect(card().textContent).toContain("辅助功能");
    expect(card().textContent).toContain("输入监控");
    expect(card().textContent).toContain("浏览器扩展");
  });

  it("starts recording from the close button without another user message", async () => {
    const { onDismiss } = await render();
    await act(async () => (card().querySelector('button[aria-label="关闭"]') as HTMLButtonElement).click());
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("lets the user skip the extension and start recording", async () => {
    const { onDismiss } = await render(granted);
    await click("跳过并开始录制");
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("opens the chosen browser extensions page from the whole browser row", async () => {
    await render();
    await click("去安装");
    const rows = card().querySelectorAll<HTMLButtonElement>(".teach-permission-card__browser");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Google Chrome");
    expect(rows[1].textContent).toContain("Microsoft Edge");
    await act(async () => rows[1].click());
    expect(window.memmy!.prepareBrowserExtension).toHaveBeenCalledExactlyOnceWith("edge", false);
    expect(card().textContent).toContain("开启「开发者模式」");
  });

  it("stops offering installation once a browser extension is enabled", async () => {
    window.memmy!.getBrowserExtensionInstallation = vi.fn().mockResolvedValue({
      chrome: { installed: true, enabled: true }, edge: { installed: false, enabled: false },
    });
    await render();
    const row = Array.from(card().querySelectorAll(".teach-permission-card__row"))
      .find(item => item.textContent?.includes("浏览器扩展"));
    expect(row!.textContent).toContain("已启用");
    expect(row!.textContent).toContain("管理");
  });
});
