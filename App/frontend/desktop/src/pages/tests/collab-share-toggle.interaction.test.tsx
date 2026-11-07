// @vitest-environment happy-dom

/**
 * 输入框旁的共享开关：已有任务读写本机接口；草稿先记下选择，发送第一条消息后由新会话接手。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollabClient } from "../../api/collab-client.js";
import { resetShareIntents, shareIntentFor, takeShareIntent } from "../../app/collab-share-intent.js";
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

  it("remembers the choice made before the first message and hands it to the new session", async () => {
    const collab = client();
    const button = await render({
      collab,
      projectId: "cloud-1",
      conversationId: null,
      draftScopeKey: "draft-7",
      onError: vi.fn()
    });
    // 还没有会话，不能直接写云端。
    expect(collab.taskSharing).not.toHaveBeenCalled();
    await act(async () => button.click());
    await flush();
    expect(collab.setTaskSharing).not.toHaveBeenCalled();
    expect(shareIntentFor("draft-7")).toBe(true);
    expect(takeShareIntent("draft-7")).toBe(true);
    expect(shareIntentFor("draft-7")).toBe(false);
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
    expect(shareIntentFor("chat-1")).toBe(false);
  });
});
