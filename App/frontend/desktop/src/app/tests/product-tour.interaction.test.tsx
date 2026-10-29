// @vitest-environment happy-dom

/** Product tour interaction tests. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { PRODUCT_TOUR_MEMORY_SCAN_PREFERENCES_ANCHOR, PRODUCT_TOUR_MEMORY_SOURCES_NAV_ANCHOR } from "../product-tour-layout.js";
import { ProductTourGuide, type ProductTourTab } from "../product-tour.js";
import { writeProductTourStep } from "../routes.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ProductTourGuide interactions", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    window.sessionStorage.clear();
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    window.sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("does not navigate again when its parent re-renders with a new callback", () => {
    const firstOnTabChange = vi.fn<(tab: ProductTourTab) => void>();
    const nextOnTabChange = vi.fn<(tab: ProductTourTab) => void>();

    act(() => {
      root.render(renderGuide(firstOnTabChange));
    });

    expect(firstOnTabChange).toHaveBeenCalledOnce();
    expect(firstOnTabChange).toHaveBeenCalledWith("logs");

    act(() => {
      root.render(renderGuide(nextOnTabChange));
    });

    expect(nextOnTabChange).not.toHaveBeenCalled();
  });

  it("scrolls to a resumed scan step after its lazy page mounts", async () => {
    writeProductTourStep(window.sessionStorage, 2);
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const id = ++nextFrameId;
      frames.set(id, callback);
      return id;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      frames.delete(id);
    });
    const flushFrame = () => {
      const callbacks = [...frames.values()];
      frames.clear();
      act(() => callbacks.forEach((callback) => callback(0)));
    };

    const onTabChange = vi.fn<(tab: ProductTourTab) => void>();
    act(() => root.render(renderGuide(onTabChange)));
    expect(onTabChange).toHaveBeenCalledWith("agentsScan");
    flushFrame();

    const scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 200 }
    });
    const scrollTo = vi.fn();
    Object.defineProperty(scroller, "scrollTo", { configurable: true, value: scrollTo });
    const scanAnchor = document.createElement("div");
    scanAnchor.dataset.tourAnchor = PRODUCT_TOUR_MEMORY_SCAN_PREFERENCES_ANCHOR;
    const navAnchor = document.createElement("div");
    navAnchor.dataset.tourAnchor = PRODUCT_TOUR_MEMORY_SOURCES_NAV_ANCHOR;
    scroller.append(scanAnchor, navAnchor);
    await act(async () => {
      document.body.append(scroller);
      await Promise.resolve();
    });
    flushFrame();

    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 800, behavior: "auto" });

    window.dispatchEvent(new Event("scroll"));
    flushFrame();
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });
});

function renderGuide(onTabChange: (tab: ProductTourTab) => void) {
  return (
    <I18nProvider language="zh-CN">
      <ProductTourGuide onDismiss={() => undefined} onTabChange={onTabChange} />
    </I18nProvider>
  );
}
