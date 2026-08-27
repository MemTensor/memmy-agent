// @vitest-environment happy-dom

/** Product tour interaction tests. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { ProductTourGuide, type ProductTourTab } from "../product-tour.js";

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
});

function renderGuide(onTabChange: (tab: ProductTourTab) => void) {
  return (
    <I18nProvider language="zh-CN">
      <ProductTourGuide onDismiss={() => undefined} onTabChange={onTabChange} />
    </I18nProvider>
  );
}
