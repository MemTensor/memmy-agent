// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorNoticeDetail } from "../error-notice-detail.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ErrorNoticeDetail", () => {
  let container: HTMLDivElement;
  let root: Root;
  let animate: ReturnType<typeof vi.fn>;
  let originalAnimate: PropertyDescriptor | undefined;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({ matches: false })
    });
    animate = vi.fn(() => ({
      cancel: vi.fn(),
      finished: Promise.resolve()
    }));
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      value: animate
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    if (originalAnimate) {
      Object.defineProperty(HTMLElement.prototype, "animate", originalAnimate);
    } else {
      delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
    }
    vi.restoreAllMocks();
  });

  it("starts expanded and uses separate smooth collapse and expand timings", async () => {
    await act(async () => root.render(
      <ErrorNoticeDetail showLabel="查看详情" hideLabel="收起详情">
        raw detail
      </ErrorNoticeDetail>
    ));
    const button = container.querySelector("button")!;
    const shell = container.querySelector<HTMLElement>(".error-notice-detail__shell")!;
    expect(button.getAttribute("aria-expanded")).toBe("true");

    await act(async () => button.click());
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(shell.hidden).toBe(true);
    expect(animate.mock.calls[0]?.[1]).toMatchObject({
      duration: 200,
      easing: "cubic-bezier(0.4, 0, 1, 1)"
    });

    await act(async () => button.click());
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(shell.hidden).toBe(false);
    expect(animate.mock.calls[2]?.[1]).toMatchObject({
      duration: 240,
      easing: "cubic-bezier(0, 0, 0.2, 1)"
    });
  });

  it("cancels the active animation when the direction reverses", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ height: 37 } as DOMRect);
    const active: Array<{ cancel: ReturnType<typeof vi.fn>; finished: Promise<void> }> = [];
    animate.mockImplementation(() => {
      const animation = { cancel: vi.fn(), finished: new Promise<void>(() => undefined) };
      active.push(animation);
      return animation;
    });
    await act(async () => root.render(
      <ErrorNoticeDetail showLabel="查看详情" hideLabel="收起详情">raw detail</ErrorNoticeDetail>
    ));
    const button = container.querySelector("button")!;

    act(() => button.click());
    act(() => button.click());

    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(active[0]?.cancel).toHaveBeenCalledOnce();
    expect(active[1]?.cancel).toHaveBeenCalledOnce();
    expect((animate.mock.calls[2]?.[0] as Keyframe[])[0]).toMatchObject({ height: "37px" });
  });

  it("switches immediately when reduced motion is requested", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({ matches: true })
    });
    await act(async () => root.render(
      <ErrorNoticeDetail showLabel="查看详情" hideLabel="收起详情">raw detail</ErrorNoticeDetail>
    ));
    const button = container.querySelector("button")!;
    const shell = container.querySelector<HTMLElement>(".error-notice-detail__shell")!;

    act(() => button.click());

    expect(shell.hidden).toBe(true);
    expect(animate).not.toHaveBeenCalled();
  });
});
