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
beforeEach(() => {
  window.localStorage.clear();
  saveHistoryPermissionSetup("start", "current-app");
  window.memmy = {
    getComputerHistoryPermissionSessionId: vi.fn().mockResolvedValue("current-app"),
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
describe("Computer History permission dialog", () => {
  it("renders a modal with only the two permissions, and opens the requested settings", async () => {
    const { client, onStart } = await render();
    expect(dialog().getAttribute("aria-modal")).toBe("true");
    expect(container.querySelector('[role="dialog"]')).toBeNull(); // portal
    expect(dialog().querySelectorAll('.ch__permission-row')).toHaveLength(2);
    expect(dialog().textContent).toContain("辅助功能"); expect(dialog().textContent).toContain("输入监控");
    expect(dialog().textContent).not.toMatch(/检查并开始|重新检测|重启 Memmy|屏幕录制/);
    expect(client.openComputerHistoryPermission).not.toHaveBeenCalled();
    await click("去开启"); expect(client.openComputerHistoryPermission).toHaveBeenCalledExactlyOnceWith("accessibility", "settings");
    const half = { ...denied, accessibility: true };
    client.checkComputerHistoryPermissions.mockResolvedValue(half); client.openComputerHistoryPermission.mockResolvedValue(half);
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(dialog().querySelectorAll('.ch__permission-granted')).toHaveLength(1);
    expect(dialog().textContent).not.toContain("退出并重启");
    await click("去开启"); expect(client.openComputerHistoryPermission).toHaveBeenLastCalledWith("inputMonitoring", "settings");
    expect(onStart).not.toHaveBeenCalled();
  });
  it("opens settings directly on every click and never navigates again on focus", async () => {
    const { client } = await render();
    await click("去开启");
    expect(client.openComputerHistoryPermission).toHaveBeenCalledExactlyOnceWith("accessibility", "settings");
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(client.openComputerHistoryPermission).toHaveBeenCalledTimes(1);
    await click("去开启");
    expect(client.openComputerHistoryPermission).toHaveBeenLastCalledWith("accessibility", "settings");
    expect(client.openComputerHistoryPermission).toHaveBeenCalledTimes(2);
  });
  it("preserves the close button while opening settings and prevents dismissal until complete", async () => {
    const { client, onCancel } = await render();
    let finish!: (value: typeof denied) => void;
    client.openComputerHistoryPermission.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
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
  it("shows Quit & Reopen when both grants are ready, without starting before restart", async () => {
    const { client, onStart } = await render(granted);
    expect(dialog().querySelectorAll('.ch__permission-granted')).toHaveLength(2);
    expect(dialog().textContent).not.toContain("去开启");
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(onStart).not.toHaveBeenCalled();
    await click("退出并重启");
    expect(window.memmy!.restartForComputerHistoryPermissions).toHaveBeenCalledOnce();
    expect(readHistoryPermissionIntent()).toEqual({ action: "start", sessionId: "current-app" });
    expect(client.checkComputerHistoryPermissions).toHaveBeenCalledTimes(3);
  });
  it("does not restart if a permission was revoked after the last check", async () => {
    const { client, onStart } = await render(granted);
    client.checkComputerHistoryPermissions.mockResolvedValue(denied);
    await click("退出并重启");
    expect(window.memmy!.restartForComputerHistoryPermissions).not.toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();
    expect(dialog().textContent).not.toContain("退出并重启");
  });
  it.each([false, true])("automatically resumes the pending enable action once after an app restart (StrictMode=%s)", async (strict) => {
    saveHistoryPermissionSetup("start", "previous-app");
    const { onStart } = await render(granted, strict);
    expect(onStart).toHaveBeenCalledOnce();
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(onStart).toHaveBeenCalledOnce();
  });
  it("does not start after a restart if one permission is still missing", async () => {
    saveHistoryPermissionSetup("start", "previous-app");
    const { client, onStart } = await render({ ...granted, inputMonitoring: false });
    expect(onStart).not.toHaveBeenCalled();
    expect(readHistoryPermissionIntent()?.sessionId).toBe("current-app");
    client.checkComputerHistoryPermissions.mockResolvedValue(granted);
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(dialog().textContent).toContain("退出并重启"); expect(onStart).not.toHaveBeenCalled();
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
