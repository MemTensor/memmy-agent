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
beforeEach(() => {
  window.memmy = { guideMemmyPermission: vi.fn().mockResolvedValue(true),
    restartForComputerHistoryPermissions: vi.fn().mockResolvedValue(undefined) } as unknown as NonNullable<Window["memmy"]>;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); document.body.replaceChildren(); Reflect.deleteProperty(window, "memmy"); });
async function render(status: { supported: boolean; accessibility: boolean; inputMonitoring: boolean } = denied) {
  const client = {
    checkComputerHistoryPermissions: vi.fn().mockResolvedValue(status),
    openComputerHistoryPermission: vi.fn().mockResolvedValue(status),
  };
  const onDismiss = vi.fn();
  await act(async () => { root.render(<I18nProvider language="zh-CN"><TeachModePermissionPrompt
    client={client as unknown as MemmyAgentClient} onDismiss={onDismiss} /></I18nProvider>); });
  return { client, onDismiss };
}
const card = () => container.querySelector('.teach-permission-card')!;
async function click(label: string) {
  const button = Array.from(card().querySelectorAll("button")).find(button => button.textContent === label);
  expect(button).toBeDefined(); await act(async () => button!.click());
}
async function clickPermission(index: number) {
  const button = card().querySelectorAll<HTMLButtonElement>(".teach-permission-card__open")[index];
  expect(button).toBeDefined(); await act(async () => button.click());
}
describe("Teach Mode permission prompt", () => {
  it("guides each missing macOS grant through the native window", async () => {
    const { client } = await render();
    expect(card().querySelectorAll(".teach-permission-card__row")).toHaveLength(2);
    expect(card().textContent).toContain("辅助功能");
    expect(card().textContent).toContain("输入监控");
    await clickPermission(0);
    expect(client.openComputerHistoryPermission).toHaveBeenCalledExactlyOnceWith("accessibility", "request");
    expect(window.memmy!.guideMemmyPermission).toHaveBeenCalledExactlyOnceWith("accessibility");
    await clickPermission(1);
    expect(client.openComputerHistoryPermission).toHaveBeenLastCalledWith("inputMonitoring", "request");
    expect(window.memmy!.guideMemmyPermission).toHaveBeenLastCalledWith("inputMonitoring");
  });
  it("requires a restart after both grants become visible", async () => {
    const { client } = await render();
    expect(Array.from(card().querySelectorAll("button")).some(button => button.textContent === "开始录制")).toBe(false);
    client.checkComputerHistoryPermissions.mockResolvedValue(granted);
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(card().querySelectorAll(".teach-permission-card__granted")).toHaveLength(2);
    expect(card().textContent).toContain("请重启 Memmy");
    expect(Array.from(card().querySelectorAll("button")).some(button => button.textContent === "开始录制")).toBe(false);
    await click("退出并重启");
    expect(window.memmy!.restartForComputerHistoryPermissions).toHaveBeenCalledOnce();
  });
  it("can be dismissed without restarting", async () => {
    const { onDismiss } = await render();
    expect(card().textContent).toContain("开启后请重启 Memmy");
    await click("稍后");
    expect(onDismiss).toHaveBeenCalledOnce();
  });
  it("renders as an inline conversation card with a recheck action", async () => {
    await render();
    expect(container.querySelector('.teach-permission-card')).not.toBeNull();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(card().textContent).toContain('重新检查');
  });
  it("matches Computer History: Input Monitoring waits for a restart and Quit & Reopen is offered", async () => {    const { client } = await render({ supported: true, accessibility: true, inputMonitoring: false });
    expect(Array.from(card().querySelectorAll("button")).some(button => button.textContent === "退出并重启")).toBe(false);
    await clickPermission(0);
    expect(window.memmy!.guideMemmyPermission).toHaveBeenCalledExactlyOnceWith("inputMonitoring");
    expect(card().textContent).toContain("重启后确认");
    expect(card().textContent).toContain("请退出并重启 Memmy");
    expect(Array.from(card().querySelectorAll("button")).some(button => button.textContent === "开始录制")).toBe(false);
    await click("退出并重启");
    expect(client.checkComputerHistoryPermissions).toHaveBeenCalled();
    expect(window.memmy!.restartForComputerHistoryPermissions).toHaveBeenCalledOnce();
  });
  it("still offers Quit & Reopen when the grants read as present", async () => {
    await render(granted);
    await click("退出并重启");
    expect(window.memmy!.restartForComputerHistoryPermissions).toHaveBeenCalledOnce();
  });
  it("requires a restart instead of offering start when the recorder rejected visible grants", async () => {
    await render(granted);
    expect(card().textContent).toContain("请退出并重启 Memmy");
    expect(Array.from(card().querySelectorAll("button")).some(button => button.textContent === "开始录制")).toBe(false);
    await click("退出并重启");
    expect(window.memmy!.restartForComputerHistoryPermissions).toHaveBeenCalledOnce();
  });
});
