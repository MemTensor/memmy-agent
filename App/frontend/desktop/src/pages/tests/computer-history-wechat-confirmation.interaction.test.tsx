// @vitest-environment happy-dom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { ComputerHistoryWeChatConfirmation } from "../memory/computer-history-wechat-confirmation.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Props = ComponentProps<typeof ComputerHistoryWeChatConfirmation>;
const ready = { ready: true, appPath: null, error: null };
const denied = { ...ready, ready: false, error: "wechat_data_access_required" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("WeChat connection preparation and Memmy permission guide", () => {
  let root: Root;
  let props: Props;
  let getFullDiskAccessStatus: ReturnType<typeof vi.fn>;
  let openExternal: ReturnType<typeof vi.fn>;
  let restart: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.replaceChildren();
    document.body.className = "";
    window.localStorage.clear();
    window.sessionStorage.clear();
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    getFullDiskAccessStatus = vi.fn().mockResolvedValue(true);
    openExternal = vi.fn().mockResolvedValue(undefined);
    restart = vi.fn().mockResolvedValue(undefined);
    window.memmy = { getFullDiskAccessStatus, openExternal, restartForComputerHistoryPermissions: restart } as unknown as NonNullable<Window["memmy"]>;
    props = {
      open: true, busy: false, connection: "disabled", phase: null, error: null,
      onCancel: vi.fn(), onClose: vi.fn(), onLoggedIn: vi.fn(),
      onPrepareReader: vi.fn().mockResolvedValue(ready),
    };
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    document.body.className = "";
    Reflect.deleteProperty(window, "memmy");
  });

  async function render(overrides: Partial<Props> = {}) {
    props = { ...props, ...overrides };
    await act(async () => {
      root.render(<I18nProvider language="zh-CN"><ComputerHistoryWeChatConfirmation {...props} /></I18nProvider>);
    });
  }

  async function click(label: string) {
    const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((candidate) => candidate.textContent === label);
    expect(button, `button ${label}`).toBeDefined();
    await act(async () => { button!.click(); });
  }

  it("uses the Memmy permission guide and requires a fresh confirmation after restarting", async () => {
    const prepare = vi.fn().mockResolvedValueOnce(denied).mockResolvedValue(ready);
    await render({ onPrepareReader: prepare });
    expect(document.body.textContent).toContain("Memmy 需要完全磁盘访问");
    expect(document.body.textContent).toContain("当前打开的 Memmy 无法访问微信数据");
    expect(document.body.textContent).toContain("1. 打开系统设置");
    expect(document.body.textContent).toContain("2. 开启 Memmy");
    expect(document.body.textContent).toContain("3. 退出并重新打开 Memmy");
    expect(document.body.textContent).not.toMatch(/Reader|Finder|助手/u);
    expect(props.onLoggedIn).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
    await click("打开 Memmy 的完全磁盘访问");
    expect(openExternal).toHaveBeenCalledWith("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles");
    expect(props.onLoggedIn).not.toHaveBeenCalled();
    await click("重启 Memmy");
    expect(restart).toHaveBeenCalledOnce();
    expect(props.onLoggedIn).not.toHaveBeenCalled();
    await render({ open: false });
    await render({ open: true });
    expect(document.body.textContent).toContain("先登录微信");
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(props.onLoggedIn).not.toHaveBeenCalled();
    await click("我已登录");
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(props.onLoggedIn).toHaveBeenCalledOnce();
  });

  it("does not prepare or connect automatically when returning from System Settings", async () => {
    await render({ onPrepareReader: vi.fn().mockResolvedValue(denied) });
    await click("打开 Memmy 的完全磁盘访问");
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(document.body.textContent).toContain("Memmy 需要完全磁盘访问");
    expect(document.body.textContent).toContain("重启 Memmy");
    expect(props.onLoggedIn).not.toHaveBeenCalled();
    expect(props.onPrepareReader).toHaveBeenCalledOnce();
    expect(restart).not.toHaveBeenCalled();
  });

  it("reuses successful preparation and checks Full Disk Access again before connecting", async () => {
    await render();
    expect(props.onPrepareReader).toHaveBeenCalledOnce();
    await click("我已登录");
    expect(getFullDiskAccessStatus).toHaveBeenCalledTimes(2);
    expect(props.onPrepareReader).toHaveBeenCalledOnce();
    expect(props.onLoggedIn).toHaveBeenCalledOnce();
  });

  it("catches revoked Full Disk Access before connecting after successful preparation", async () => {
    getFullDiskAccessStatus.mockResolvedValueOnce(true).mockResolvedValue(false);
    await render();
    await click("我已登录");
    expect(getFullDiskAccessStatus).toHaveBeenCalledTimes(2);
    expect(props.onPrepareReader).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain("Memmy 需要完全磁盘访问");
    expect(openExternal).not.toHaveBeenCalled();
    expect(props.onLoggedIn).not.toHaveBeenCalled();
  });

  it("keeps the existing Memmy permission guide ahead of connection preparation", async () => {
    getFullDiskAccessStatus.mockResolvedValue(false);
    await render();
    expect(document.body.textContent).toContain("Memmy 需要完全磁盘访问");
    expect(props.onPrepareReader).not.toHaveBeenCalled();
    expect(props.onLoggedIn).not.toHaveBeenCalled();
  });

  it.each(["cancel", "close"])("ignores preparation completion after %s", async (action) => {
    const pending = deferred<typeof ready>();
    await render({ onPrepareReader: vi.fn().mockReturnValue(pending.promise) });
    if (action === "cancel") await click("取消");
    else await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!.click(); });
    await act(async () => { pending.resolve(ready); });
    expect(props.onCancel).toHaveBeenCalledOnce();
    expect(props.onLoggedIn).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("先登录微信");
  });

  it("does not connect when canceled while the final permission check is pending", async () => {
    const pending = deferred<boolean>();
    getFullDiskAccessStatus.mockResolvedValueOnce(true).mockReturnValueOnce(pending.promise);
    await render();
    await click("我已登录");
    await click("取消");
    await act(async () => { pending.resolve(true); });
    expect(props.onLoggedIn).not.toHaveBeenCalled();
  });

  it("ignores preparation from a previous opening of the dialog", async () => {
    const old = deferred<typeof ready>();
    const prepare = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(denied);
    await render({ onPrepareReader: prepare });
    await render({ open: false });
    await render({ open: true });
    await act(async () => { old.resolve(ready); });
    expect(document.body.textContent).toContain("Memmy 需要完全磁盘访问");
    expect(document.body.textContent).not.toContain("先登录微信");
    expect(props.onLoggedIn).not.toHaveBeenCalled();
  });

  it("does not repeat preparation when polling replaces callback props", async () => {
    const prepare = vi.fn().mockResolvedValue(denied);
    await render({ onPrepareReader: prepare });
    await render({ phase: "snapshot_updated", onPrepareReader: async () => prepare() });
    expect(prepare).toHaveBeenCalledOnce();
  });

  it.each([
    ["/private/unexpected", "微信连接准备失败，请重试。"],
    ["python_unavailable", "微信读取组件不完整，请重新安装 Memmy"],
  ])("shows a readable error and allows retry when preparation rejects with %s", async (error, message) => {
    await render({ onPrepareReader: vi.fn().mockRejectedValueOnce(new Error(error)).mockResolvedValue(ready) });
    expect(document.body.textContent).toContain(message);
    expect(document.body.textContent).not.toContain("/private/unexpected");
    await click("重试");
    expect(document.body.textContent).toContain("先登录微信");
    expect(props.onLoggedIn).not.toHaveBeenCalled();
  });
  it.each([
    ["wechat_private_storage_unsafe_path", "微信连接准备失败，请重试。"],
    ["wechat_private_storage_source_changed", "微信数据正在更新，连接未完成。请稍后重试。"],
  ])("explains storage connection failure %s without claiming the user was not logged in", async (error, message) => {
    await render();
    await click("我已登录");
    await render({ connection: "error", error });
    expect(document.body.textContent).toContain(message);
    expect(document.body.textContent).not.toMatch(/未登录|确认微信已经登录|wechat_private_storage/);
    expect(props.onLoggedIn).toHaveBeenCalledOnce();
    await render({ connection: "error", error });
    expect(props.onLoggedIn).toHaveBeenCalledOnce();
  });

  it.each([
    ["wechat_data_access_probe_failed", "微信连接准备失败，请重试。"],
    ["wechat_permission_helper_unavailable", "微信连接准备失败，请重试。"],
    ["python_unavailable", "微信读取组件不完整，请重新安装 Memmy"],
    ["wechat_private_storage_source_changed", "微信数据正在更新，连接未完成。请稍后重试。"],
    ["unknown_error:/private/path", "微信连接准备失败，请重试。"],
  ])(
    "explains preparation failure %s without permission changes", async (error, message) => {
      await render({ onPrepareReader: vi.fn().mockResolvedValue({ ...ready, ready: false, error }) });
      expect(document.body.textContent).toContain(message);
      expect(document.body.textContent).not.toContain(error);
      expect(document.body.textContent).not.toMatch(/Reader|Finder|助手|完全磁盘访问/u);
      expect(openExternal).not.toHaveBeenCalled();
      expect(restart).not.toHaveBeenCalled();
      expect(props.onLoggedIn).not.toHaveBeenCalled();
    },
  );

  it("preserves the Windows flow without preparing a Mac connection", async () => {
    document.body.classList.add("memmy-platform-windows");
    await render();
    expect(document.body.textContent).toContain("先保持微信登录");
    expect(getFullDiskAccessStatus).not.toHaveBeenCalled();
    expect(props.onPrepareReader).not.toHaveBeenCalled();
    await click("我已登录");
    expect(props.onLoggedIn).toHaveBeenCalledOnce();
    expect(props.onPrepareReader).not.toHaveBeenCalled();
  });
});
