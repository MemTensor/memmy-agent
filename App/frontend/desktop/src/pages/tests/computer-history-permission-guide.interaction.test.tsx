// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemmyAgentClient } from "../../api/memmy-agent-client.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { ComputerHistoryPermissionGuide } from "../memory/computer-history-permission-guide.js";
import { readHistoryPermissionIntent, saveHistoryPermissionSetup } from "../memory/computer-history-permission-state.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const denied = { supported: true, accessibility: false, inputMonitoring: false };
const granted = { supported: true, accessibility: true, inputMonitoring: true };
const accessibilityGranted = { ...granted, inputMonitoring: false };
beforeEach(() => {
  window.localStorage.clear();
  saveHistoryPermissionSetup("start", "current-app");
  window.memmy = {
    getComputerHistoryPermissionSessionId: vi.fn().mockResolvedValue("current-app"),
    guideMemmyPermission: vi.fn().mockResolvedValue(true),
    restartForComputerHistoryPermissions: vi.fn().mockResolvedValue(undefined),
  } as unknown as NonNullable<Window["memmy"]>;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); document.body.replaceChildren(); Reflect.deleteProperty(window, "memmy"); });
async function render(status = denied, strict = false, start = vi.fn().mockResolvedValue(undefined)) {
  const client = {
    checkComputerHistoryPermissions: vi.fn().mockResolvedValue(status),
    openComputerHistoryPermission: vi.fn().mockResolvedValue(status),
  };
  const onStart = start;
  const onCancel = vi.fn();
  const view = <I18nProvider language="zh-CN"><ComputerHistoryPermissionGuide client={client as unknown as MemmyAgentClient} onStart={onStart} onCancel={onCancel}/></I18nProvider>;
  await act(async () => { root.render(strict ? <StrictMode>{view}</StrictMode> : view); });
  return { client, onStart, onCancel };
}
const dialog = () => document.querySelector('[role="dialog"]')!;
async function click(label: string) {
  const button = Array.from(dialog().querySelectorAll("button")).find((button) => button.textContent === label);
  expect(button).toBeDefined(); await act(async () => button!.click());
}
const rowLabels = () => Array.from(dialog().querySelectorAll(".ch__permission-row > span:first-child")).map((label) => label.textContent);
describe("Computer History permission dialog", () => {
  it("guides Accessibility first, then Input Monitoring, and holds the restart until both are on", async () => {
    const { client, onStart } = await render();
    expect(dialog().getAttribute("aria-modal")).toBe("true");
    expect(container.querySelector('[role="dialog"]')).toBeNull(); // portal
    expect(rowLabels()).toEqual(["辅助功能"]);
    expect(dialog().textContent).not.toMatch(/检查并开始|重新检测|重启 Memmy|屏幕录制/);
    expect(dialog().textContent).not.toContain("退出并重启");
    expect(client.openComputerHistoryPermission).not.toHaveBeenCalled();
    expect(window.memmy!.guideMemmyPermission).not.toHaveBeenCalled();
    await click("去开启"); expect(window.memmy!.guideMemmyPermission).toHaveBeenCalledExactlyOnceWith("accessibility");
    expect(client.openComputerHistoryPermission).toHaveBeenCalledExactlyOnceWith("accessibility", "request");
    client.checkComputerHistoryPermissions.mockResolvedValue(accessibilityGranted);
    await act(async () => window.dispatchEvent(new Event("focus")));
    // Accessibility stays to confirm it; listening is guided only now.
    expect(rowLabels()).toEqual(["辅助功能", "输入监控"]);
    expect(dialog().querySelectorAll('.ch__permission-granted')).toHaveLength(1);
    expect(dialog().querySelectorAll('.ch__permission-open')).toHaveLength(1);
    expect(dialog().textContent).not.toContain("退出并重启");
    client.checkComputerHistoryPermissions.mockResolvedValue(granted);
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(dialog().querySelectorAll('.ch__permission-granted')).toHaveLength(2);
    expect(dialog().textContent).toContain("退出并重启");
    expect(onStart).not.toHaveBeenCalled();
  });
  it("guides Input Monitoring right away when Accessibility is already on", async () => {
    const { client, onStart } = await render(accessibilityGranted);
    expect(rowLabels()).toEqual(["辅助功能", "输入监控"]);
    expect(dialog().querySelectorAll('.ch__permission-granted')).toHaveLength(1);
    expect(dialog().querySelector('[role="alert"]')).toBeNull();
    expect(dialog().textContent).not.toContain("退出并重启");
    expect(dialog().textContent).not.toContain("重试");
    await click("去开启");
    expect(window.memmy!.guideMemmyPermission).toHaveBeenCalledExactlyOnceWith("inputMonitoring");
    expect(client.openComputerHistoryPermission).toHaveBeenCalledExactlyOnceWith("inputMonitoring", "request");
    expect(window.memmy!.restartForComputerHistoryPermissions).not.toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();
  });
  it("resumes after the relaunch that follows granting Input Monitoring, without a second restart", async () => {
    await render(accessibilityGranted);
    await click("去开启");
    expect(readHistoryPermissionIntent()).toEqual({ action: "start", sessionId: "current-app" });
    await act(async () => root.render(null));
    // macOS quits and reopens Memmy once the switch is turned on.
    window.memmy!.getComputerHistoryPermissionSessionId = vi.fn().mockResolvedValue("relaunched-app");
    const { onStart } = await render(granted);
    expect(onStart).toHaveBeenCalledOnce();
    expect(window.memmy!.restartForComputerHistoryPermissions).not.toHaveBeenCalled();
  });
  it("opens settings directly on every click and never navigates again on focus", async () => {
    const { client } = await render();
    await click("去开启");
    expect(window.memmy!.guideMemmyPermission).toHaveBeenCalledExactlyOnceWith("accessibility");
    expect(client.openComputerHistoryPermission).toHaveBeenCalledExactlyOnceWith("accessibility", "request");
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(window.memmy!.guideMemmyPermission).toHaveBeenCalledTimes(1);
    await click("去开启");
    expect(window.memmy!.guideMemmyPermission).toHaveBeenLastCalledWith("accessibility");
    expect(window.memmy!.guideMemmyPermission).toHaveBeenCalledTimes(2);
    expect(client.openComputerHistoryPermission).toHaveBeenCalledTimes(2);
  });
  it("preserves the close button while opening settings and prevents dismissal until complete", async () => {
    const { client, onCancel } = await render();
    let finish!: (value: typeof denied) => void;
    window.memmy!.guideMemmyPermission = vi.fn().mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const closeButton = dialog().querySelector<HTMLButtonElement>(".modal-header button")!;
    expect(closeButton.disabled).toBe(false);
    await click("去开启");
    expect(dialog().querySelector(".modal-header button")).toBe(closeButton);
    expect(closeButton.disabled).toBe(true);
    await act(async () => {
      closeButton.click();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      (document.querySelector(".modal-backdrop") as HTMLElement).click();
    });
    expect(onCancel).not.toHaveBeenCalled();
    await act(async () => { finish(denied); });
    expect(dialog().querySelector(".modal-header button")).toBe(closeButton);
    expect(closeButton.disabled).toBe(false);
    await act(async () => closeButton.click());
    expect(onCancel).toHaveBeenCalledOnce();
  });
  it("refreshes grants on focus while the native settings guide is still open", async () => {
    const { client, onStart } = await render();
    let closeGuide!: (value: boolean) => void;
    window.memmy!.guideMemmyPermission = vi.fn().mockReturnValueOnce(new Promise<boolean>((resolve) => { closeGuide = resolve; }));
    await click("去开启");
    expect(window.memmy!.guideMemmyPermission).toHaveBeenCalledOnce();
    expect(client.checkComputerHistoryPermissions).toHaveBeenCalledOnce();
    client.checkComputerHistoryPermissions.mockResolvedValue(granted);
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(rowLabels()).toEqual(["辅助功能"]);
    expect(dialog().querySelectorAll('.ch__permission-granted')).toHaveLength(1);
    expect(client.checkComputerHistoryPermissions).toHaveBeenCalledTimes(2);
    const restart = Array.from(dialog().querySelectorAll("button")).find(button => button.textContent === "退出并重启")!;
    expect(restart.disabled).toBe(true);
    expect(onStart).not.toHaveBeenCalled();
    expect(window.memmy!.guideMemmyPermission).toHaveBeenCalledOnce();
    await act(async () => closeGuide(false));
    expect(restart.disabled).toBe(false);
    expect(onStart).not.toHaveBeenCalled();
  });
  it("ignores a settings guide completion after the dialog unmounts", async () => {
    const { client, onStart, onCancel } = await render();
    let closeGuide!: (value: boolean) => void;
    window.memmy!.guideMemmyPermission = vi.fn().mockReturnValueOnce(new Promise<boolean>((resolve) => { closeGuide = resolve; }));
    await click("去开启");
    await act(async () => root.render(null));
    client.checkComputerHistoryPermissions.mockResolvedValue(granted);
    await act(async () => closeGuide(true));
    expect(client.checkComputerHistoryPermissions).toHaveBeenCalledOnce();
    expect(onStart).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });
  it("shows Quit & Reopen when both grants are ready, without starting before restart", async () => {
    const { client, onStart } = await render(granted);
    expect(rowLabels()).toEqual(["辅助功能"]);
    expect(dialog().querySelectorAll('.ch__permission-granted')).toHaveLength(1);
    expect(dialog().querySelectorAll('.ch__permission-open')).toHaveLength(0);
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(onStart).not.toHaveBeenCalled();
    await click("退出并重启");
    expect(window.memmy!.restartForComputerHistoryPermissions).toHaveBeenCalledOnce();
    expect(readHistoryPermissionIntent()).toEqual({ action: "start", sessionId: "current-app" });
    expect(client.checkComputerHistoryPermissions).toHaveBeenCalledTimes(3);
  });
  it("does not restart if Input Monitoring is off on a fresh check", async () => {
    const { client, onStart } = await render(granted);
    client.checkComputerHistoryPermissions.mockResolvedValue(accessibilityGranted);
    await click("退出并重启");
    expect(client.checkComputerHistoryPermissions).toHaveBeenCalledTimes(2);
    expect(window.memmy!.restartForComputerHistoryPermissions).not.toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();
    expect(dialog().textContent).not.toContain("退出并重启");
    expect(rowLabels()).toEqual(["辅助功能", "输入监控"]);
  });
  it("does not restart if Accessibility was revoked after the last check", async () => {
    const { client, onStart } = await render(granted);
    client.checkComputerHistoryPermissions.mockResolvedValue(denied);
    await click("退出并重启");
    expect(window.memmy!.restartForComputerHistoryPermissions).not.toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();
    expect(dialog().textContent).not.toContain("退出并重启");
    expect(rowLabels()).toEqual(["辅助功能"]);
  });
  it("keeps the enable intent and allows another restart attempt if restarting fails", async () => {
    const { onStart } = await render(granted);
    window.memmy!.restartForComputerHistoryPermissions = vi.fn()
      .mockRejectedValueOnce(new Error("restart failed"))
      .mockResolvedValue(undefined);
    await click("退出并重启");
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain("restart failed");
    expect(readHistoryPermissionIntent()).toEqual({ action: "start", sessionId: "current-app" });
    expect(onStart).not.toHaveBeenCalled();
    await click("退出并重启");
    expect(window.memmy!.restartForComputerHistoryPermissions).toHaveBeenCalledTimes(2);
    expect(dialog().querySelector('[role="alert"]')).toBeNull();
    expect(onStart).not.toHaveBeenCalled();
  });
  it.each([false, true])("automatically resumes the pending enable action once after an app restart (StrictMode=%s)", async (strict) => {
    saveHistoryPermissionSetup("start", "previous-app");
    const { onStart } = await render(granted, strict);
    expect(onStart).toHaveBeenCalledOnce();
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(onStart).toHaveBeenCalledOnce();
  });
  it.each([false, true])("waits for listening after restart without losing the pending enable action (StrictMode=%s)", async (strict) => {
    saveHistoryPermissionSetup("start", "previous-app");
    const { client, onStart } = await render(accessibilityGranted, strict);
    expect(onStart).not.toHaveBeenCalled();
    expect(readHistoryPermissionIntent()?.sessionId).toBe("previous-app");
    expect(dialog().querySelector('[role="alert"]')).toBeNull();
    // Another restart cannot fix a switched-off grant; guide it instead.
    expect(dialog().textContent).not.toContain("退出并重启");
    expect(rowLabels()).toEqual(["辅助功能", "输入监控"]);
    expect(dialog().textContent).not.toContain("重试");
    client.checkComputerHistoryPermissions.mockResolvedValue(granted);
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(onStart).toHaveBeenCalledOnce();
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(onStart).toHaveBeenCalledOnce();
  });
  it("requires another restart if Accessibility is still missing after the previous restart", async () => {
    saveHistoryPermissionSetup("start", "previous-app");
    const { client, onStart } = await render(denied);
    expect(onStart).not.toHaveBeenCalled();
    expect(readHistoryPermissionIntent()?.sessionId).toBe("current-app");
    client.checkComputerHistoryPermissions.mockResolvedValue(granted);
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(dialog().textContent).toContain("退出并重启");
    expect(onStart).not.toHaveBeenCalled();
  });
  it("does not infer restart from a legacy intent or a page reload in the same app", async () => {
    window.localStorage.setItem("memmy.computerHistory.permissionSetup", "start");
    const { onStart } = await render(granted);
    expect(readHistoryPermissionIntent()?.sessionId).toBe("current-app");
    expect(onStart).not.toHaveBeenCalled();
  });
  it("supports dismissal with Escape and restores body scrolling", async () => {
    const { onCancel, onStart } = await render();
    expect(document.body.style.overflow).toBe("hidden");
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(onCancel).toHaveBeenCalledOnce(); expect(onStart).not.toHaveBeenCalled();
    act(() => root.render(null));
    expect(document.body.style.overflow).toBe("");
  });
  it("keeps a failed automatic start visible and retries only on user request", async () => {
    saveHistoryPermissionSetup("start", "previous-app");
    const onStart = vi.fn().mockRejectedValueOnce(new Error("start failed")).mockResolvedValue(undefined);
    await render(granted, false, onStart);
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain("start failed");
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(onStart).toHaveBeenCalledOnce();
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain("start failed");
    await click("重试");
    expect(onStart).toHaveBeenCalledTimes(2);
    expect(dialog().querySelector('[role="alert"]')).toBeNull();
  });
  it("offers a retry after a failed permission check", async () => {
    const { client } = await render();
    client.checkComputerHistoryPermissions.mockRejectedValueOnce(new Error("offline"));
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain("offline");
    await click("重试"); expect(dialog().querySelector('[role="alert"]')).toBeNull();
  });
});
