// @vitest-environment happy-dom

/**
 * 输入框旁的共享开关：已有任务读写本机接口，没有记录时按未共享显示；草稿默认开启，
 * 先记下选择，发送第一条消息后由新会话接手。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollabClient } from "../../api/collab-client.js";
import {
  draftShareIntent,
  handOffDraftShare,
  isSharePending,
  resetShareIntents,
  takeDraftShareIntent
} from "../../app/collab-share-intent.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { CollabShareToggle } from "../collab-share-toggle.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function client(overrides: Partial<CollabClient> = {}): CollabClient {
  return {
    taskSharing: vi.fn().mockResolvedValue({ shared: false, synced: false, started: 0 }),
    setTaskSharing: vi.fn().mockResolvedValue({ shared: true, synced: false, started: 1 }),
    ...overrides
  } as unknown as CollabClient;
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
  }
}

describe("CollabShareToggle", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetShareIntents();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    resetShareIntents();
  });

  async function render(props: Parameters<typeof CollabShareToggle>[0]): Promise<HTMLButtonElement> {
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <CollabShareToggle {...props} />
        </I18nProvider>
      );
    });
    await flush();
    const button = container.querySelector<HTMLButtonElement>("button[role=switch]");
    expect(button, "共享开关应渲染成一个 switch").toBeTruthy();
    return button!;
  }

  it("shows the state this computer recorded and turns sharing on", async () => {
    const collab = client();
    const button = await render({
      collab,
      projectId: "cloud-1",
      conversationId: "chat-1",
      draftScopeKey: "chat-1",
      onError: vi.fn()
    });
    expect(collab.taskSharing).toHaveBeenCalledWith("cloud-1", "chat-1");
    expect(button.getAttribute("aria-checked")).toBe("false");
    expect(button.textContent).toContain("共享给成员");

    await act(async () => button.click());
    await flush();
    expect(collab.setTaskSharing).toHaveBeenCalledWith("cloud-1", "chat-1", true);
    expect(container.querySelector("button")!.getAttribute("aria-checked")).toBe("true");
    expect(container.textContent).toContain("已共享给成员");
  });

  it("starts a new task as shared without touching the local record", async () => {
    const collab = client();
    const button = await render({
      collab,
      projectId: "cloud-1",
      conversationId: null,
      draftScopeKey: "draft-7",
      onError: vi.fn()
    });
    // 还没有会话，不能直接写本机记录；草稿默认开启，但还没有共享任何内容，所以不写「已共享」。
    expect(collab.taskSharing).not.toHaveBeenCalled();
    expect(button.getAttribute("aria-checked")).toBe("true");
    expect(button.textContent).toBe("共享给成员");
    expect(button.getAttribute("title")).toBe("发送第一条消息后，这条任务会共享给项目成员");
    expect(takeDraftShareIntent("draft-7", true)).toBe(true);
  });

  it("keeps a new task unshared when the person turns it off before sending", async () => {
    const collab = client();
    const button = await render({
      collab,
      projectId: "cloud-1",
      conversationId: null,
      draftScopeKey: "draft-8",
      onError: vi.fn()
    });
    await act(async () => button.click());
    await flush();
    expect(collab.setTaskSharing).not.toHaveBeenCalled();
    expect(container.querySelector("button")!.getAttribute("aria-checked")).toBe("false");
    expect(draftShareIntent("draft-8")).toBe(false);
    // 发送时交给新会话：关掉的草稿不共享。
    expect(handOffDraftShare({ collab, onlineProjectId: "cloud-1", draftScopeKey: "draft-8", chatId: "chat-8" })).toBeNull();
    expect(collab.setTaskSharing).not.toHaveBeenCalled();
  });

  it("does not turn an existing task with no record into a shared one", async () => {
    const collab = client();
    const button = await render({
      collab,
      projectId: "cloud-1",
      conversationId: "chat-old",
      draftScopeKey: "chat-old",
      onError: vi.fn()
    });
    expect(collab.taskSharing).toHaveBeenCalledWith("cloud-1", "chat-old");
    expect(button.getAttribute("aria-checked")).toBe("false");
    expect(collab.setTaskSharing).not.toHaveBeenCalled();
  });

  it("shows a just-created task as shared while the draft's choice is being saved", async () => {
    let finish: (value: { shared: boolean; synced: boolean; started: number }) => void = () => undefined;
    const collab = client({
      setTaskSharing: vi.fn().mockImplementation(() => new Promise((resolve) => { finish = resolve; }))
    });
    const handed = handOffDraftShare({ collab, onlineProjectId: "cloud-1", draftScopeKey: "draft-9", chatId: "chat-9" });
    expect(collab.setTaskSharing).toHaveBeenCalledWith("cloud-1", "chat-9", true);
    // 本机记录还没写好：读到的是未共享，开关仍按草稿交过来的选择显示。
    const button = await render({
      collab,
      projectId: "cloud-1",
      conversationId: "chat-9",
      draftScopeKey: "chat-9",
      onError: vi.fn()
    });
    expect(button.getAttribute("aria-checked")).toBe("true");
    expect(button.textContent).toBe("已共享给成员");
    await act(async () => finish({ shared: true, synced: false, started: 0 }));
    await handed;
    expect(isSharePending("chat-9")).toBe(false);
  });

  it("keeps the switch off and reports the failure when saving does not work", async () => {
    const onError = vi.fn();
    const collab = client({
      setTaskSharing: vi.fn().mockRejectedValue(new Error("cloud down"))
    });
    const button = await render({
      collab,
      projectId: "cloud-1",
      conversationId: "chat-1",
      draftScopeKey: "chat-1",
      onError
    });

    await act(async () => button.click());
    await flush();
    expect(onError).toHaveBeenCalled();
    expect(container.querySelector("button")!.getAttribute("aria-checked")).toBe("false");
    expect(isSharePending("chat-1")).toBe(false);
  });
});
