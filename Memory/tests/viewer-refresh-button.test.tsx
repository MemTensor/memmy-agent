// @vitest-environment happy-dom
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RefreshButton } from "../viewer/src/components/RefreshButton";
import { locale } from "../viewer/src/stores/i18n";

describe("Viewer RefreshButton", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    locale.value = "zh";
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(() => {
    act(() => render(null, container));
    container.remove();
    vi.useRealTimers();
  });

  it("spins while refreshing, shows success, then returns to idle", async () => {
    let resolveRefresh!: () => void;
    const onRefresh = vi.fn(() => new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    }));

    act(() => render(h(RefreshButton, { onRefresh }), container));
    const button = container.querySelector<HTMLButtonElement>("button")!;

    act(() => button.click());
    expect(button.classList.contains("refresh-feedback--pending")).toBe(true);
    expect(button.querySelector(".spin")).not.toBeNull();
    expect(button.getAttribute("aria-label")).toBe("刷新中…");

    await act(async () => {
      resolveRefresh();
      await Promise.resolve();
    });
    expect(button.classList.contains("refresh-feedback--success")).toBe(true);
    expect(button.getAttribute("aria-label")).toBe("已刷新");
    expect(button.querySelector("svg polyline")).not.toBeNull();
    expect(button.querySelector("svg circle")).toBeNull();

    act(() => vi.advanceTimersByTime(1_400));
    expect(button.classList.contains("refresh-feedback--idle")).toBe(true);
    expect(button.getAttribute("aria-label")).toBe("刷新");
  });
});
