// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../i18n/i18n-provider.js";
import { MemoryRefreshButton } from "../memory-refresh-button.js";

describe("MemoryRefreshButton interaction", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("shows pending, success, then returns to the refresh icon state", async () => {
    let resolveRefresh!: () => void;
    const onClick = vi.fn(() => new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    }));

    act(() => {
      root.render(
        <I18nProvider language="zh-CN">
          <MemoryRefreshButton onClick={onClick} />
        </I18nProvider>
      );
    });

    const button = container.querySelector<HTMLButtonElement>("button")!;
    act(() => button.click());
    expect(button.classList.contains("memory-refresh-button--pending")).toBe(true);
    expect(button.getAttribute("aria-label")).toBe("刷新中");

    await act(async () => {
      resolveRefresh();
      await Promise.resolve();
    });
    expect(button.classList.contains("memory-refresh-button--success")).toBe(true);
    expect(button.getAttribute("aria-label")).toBe("已刷新");
    expect(button.querySelector("[data-icon='check']")).not.toBeNull();

    act(() => vi.advanceTimersByTime(1_400));
    expect(button.classList.contains("memory-refresh-button--idle")).toBe(true);
    expect(button.getAttribute("aria-label")).toBe("刷新本页");
  });
});
