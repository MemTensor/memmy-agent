// @vitest-environment happy-dom

/**
 * 邀请方的审核弹窗：有人通过我的邀请链接申请加入项目时，直接弹在屏幕上。
 *
 * 申请是对方在别的电脑上提交的，本机没有推送通道：组件挂上就先读一次，之后按固定间隔再读。
 * 这里只验界面行为（读到就弹、同意/拒绝打对接口、关掉不再打扰），轮询间隔本身由常量约定。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollabManagedJoinRequest } from "../../api/collab-client.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { CollabJoinRequestHost } from "../collab-join-request-host.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
  }
}

function button(label: string): HTMLButtonElement | null {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .find((candidate) => candidate.textContent?.trim() === label) ?? null;
}

function hasText(text: string): boolean {
  return document.body.textContent?.includes(text) ?? false;
}

const request: CollabManagedJoinRequest = {
  projectId: "cloud-1",
  projectName: "Memmy 开发",
  userId: "10",
  name: "用户D",
  inviterName: "用户A",
  createdAt: "2026-11-17T02:00:00Z"
};

describe("collab join request host", () => {
  let container: HTMLDivElement;
  let root: Root;
  const collab = { joinRequests: vi.fn(), approveRequest: vi.fn(), rejectRequest: vi.fn() };
  const onApproved = vi.fn();
  const onNotice = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    collab.joinRequests.mockResolvedValue([request]);
    collab.approveRequest.mockResolvedValue({});
    collab.rejectRequest.mockResolvedValue(undefined);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function mount(enabled = true) {
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <CollabJoinRequestHost
            collab={collab as never}
            enabled={enabled}
            onApproved={onApproved}
            onNotice={onNotice}
          />
        </I18nProvider>
      );
    });
    await flush();
  }

  it("pops up as soon as a request is waiting, with who and which project", async () => {
    await mount();

    expect(hasText("「Memmy 开发」成员申请")).toBe(true);
    expect(hasText("用户D")).toBe(true);
    expect(hasText("通过 用户A 的邀请链接提交")).toBe(true);
    expect(button("同意加入")).toBeTruthy();
    expect(button("拒绝")).toBeTruthy();
  });

  it("approves through the cloud and tells the caller to refresh the project", async () => {
    await mount();
    await act(async () => button("同意加入")!.click());
    await flush();

    expect(collab.approveRequest).toHaveBeenCalledWith("cloud-1", "10");
    expect(onApproved).toHaveBeenCalledWith(request);
    expect(hasText("「Memmy 开发」成员申请")).toBe(false);
  });

  it("declines through the cloud and says so", async () => {
    await mount();
    await act(async () => button("拒绝")!.click());
    await flush();

    expect(collab.rejectRequest).toHaveBeenCalledWith("cloud-1", "10");
    expect(collab.approveRequest).not.toHaveBeenCalled();
    expect(onNotice).toHaveBeenCalledWith("已拒绝 用户D 的申请");
  });

  it("never asks the cloud when collaboration is off", async () => {
    await mount(false);
    expect(collab.joinRequests).not.toHaveBeenCalled();
    expect(hasText("「Memmy 开发」成员申请")).toBe(false);
  });
});
