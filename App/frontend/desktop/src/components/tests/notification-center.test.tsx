// @vitest-environment happy-dom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import {
  NOTIFICATION_STACK_MAX_VISIBLE,
  NotificationCenterProvider,
  useNotificationCenter,
  type NotificationCenterValue
} from "../notification-center.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let center: NotificationCenterValue | null = null;

function CenterHandle() {
  center = useNotificationCenter();
  return null;
}

function stackItems(): Element[] {
  const stack = document.body.querySelector(".memmy-notification-stack");
  return stack ? Array.from(stack.querySelectorAll(".memmy-notification")) : [];
}

describe("NotificationCenter", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    center = null;
    act(() => {
      root.render(
        <StrictMode>
          <I18nProvider language="zh-CN">
            <NotificationCenterProvider>
              <CenterHandle />
            </NotificationCenterProvider>
          </I18nProvider>
        </StrictMode>
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  it("caps visible notifications and queues the overflow", () => {
    act(() => {
      for (let i = 1; i <= NOTIFICATION_STACK_MAX_VISIBLE + 1; i += 1) {
        center?.notify({ title: `通知 ${i}` });
      }
    });

    expect(stackItems()).toHaveLength(NOTIFICATION_STACK_MAX_VISIBLE);
    // The 4th is queued, not shown yet.
    expect(document.body.textContent).not.toContain("通知 4");
  });

  it("runs onClose on dismiss and reveals the next queued notification", () => {
    const onClose = vi.fn();
    act(() => {
      center?.notify({ title: "通知 1", onClose });
      for (let i = 2; i <= NOTIFICATION_STACK_MAX_VISIBLE + 1; i += 1) {
        center?.notify({ title: `通知 ${i}` });
      }
    });
    expect(document.body.textContent).not.toContain("通知 4");

    // Oldest visible ("通知 1") is rendered at the bottom; dismiss it via its close button.
    const closeButtons = document.body.querySelectorAll('.memmy-notification [aria-label="关闭"]');
    act(() => (closeButtons[closeButtons.length - 1] as HTMLButtonElement).click());

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(stackItems()).toHaveLength(NOTIFICATION_STACK_MAX_VISIBLE);
    expect(document.body.textContent).toContain("通知 4");
  });

  it("runs the action then dismisses the notification", () => {
    const onAction = vi.fn();
    act(() => {
      center?.notify({ title: "带链接的通知", actionLabel: "打开详情", onAction });
    });

    const action = document.body.querySelector(".memmy-notification__action");
    expect(action?.textContent).toContain("打开详情");
    act(() => (action as HTMLButtonElement).click());

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(stackItems()).toHaveLength(0);
  });
});
