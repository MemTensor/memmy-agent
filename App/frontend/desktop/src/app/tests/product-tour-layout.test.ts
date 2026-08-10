// @vitest-environment happy-dom

/** Product tour layout tests. */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findClosestScrollableAncestor,
  resolveProductTourStepLayout,
  scrollProductTourHighlightIntoView,
  type ProductTourAnchorLookup,
  type ProductTourBubblePlacement,
  type ProductTourHighlightSpec,
  type ProductTourViewport
} from "../product-tour-layout.js";

describe("resolveProductTourStepLayout", () => {
  it("按目标按钮自身 rect 解析 step 1 高亮，并把气泡放到按钮右侧垂直居中", () => {
    const highlight: ProductTourHighlightSpec = {
      anchorId: "memory-nav"
    };
    const bubble: ProductTourBubblePlacement = {
      anchorId: "memory-nav",
      side: "right",
      align: "center",
      gap: 16
    };

    expect(resolveProductTourStepLayout(highlight, bubble, anchors(["memory-nav"]))).toEqual({
      highlight: { top: "184px", left: "8px", width: "300px", height: "40px" },
      extraHighlights: [],
      bubblePosition: { top: "204px", left: "324px", transform: "translateY(-50%)" },
      arrow: "left"
    });
  });

  it("主高亮和额外高亮各自独立解析", () => {
    const highlight: ProductTourHighlightSpec = {
      anchorId: "tools-content",
      padding: { top: 16, left: 16 },
      viewportBottom: 16
    };
    const extra: ProductTourHighlightSpec = { anchorId: "tools-nav" };
    const bubble: ProductTourBubblePlacement = {
      anchorId: "tools-content",
      side: "inside",
      blockAlign: "start",
      inlineAlign: "end",
      offsetX: 4,
      offsetY: 4
    };

    expect(
      resolveProductTourStepLayout(
        highlight,
        bubble,
        anchors(
          [
            ["tools-nav", { top: 120, left: 8, width: 160, height: 36 }],
            ["tools-content", { top: 165, left: 212, width: 964, height: 1913 }]
          ],
          { width: 1200, height: 800 }
        ),
        [extra]
      )
    ).toEqual({
      highlight: { top: "149px", left: "196px", width: "980px", height: "635px" },
      extraHighlights: [{ top: "120px", left: "8px", width: "160px", height: "36px" }],
      bubblePosition: { top: "169px", right: "28px" },
      arrow: "left"
    });
  });

  it("额外高亮锚点缺失时静默跳过", () => {
    const highlight: ProductTourHighlightSpec = {
      anchorId: "tools-content",
      padding: { top: 16, left: 16 },
      viewportBottom: 16
    };
    const bubble: ProductTourBubblePlacement = {
      anchorId: "tools-content",
      side: "inside",
      blockAlign: "start",
      inlineAlign: "end",
      offsetX: 4,
      offsetY: 4
    };

    const result = resolveProductTourStepLayout(
      highlight,
      bubble,
      anchors([["tools-content", { top: 165, left: 212, width: 964, height: 1913 }]], { width: 1200, height: 800 }),
      [{ anchorId: "missing-nav" }]
    );

    expect(result).not.toBeNull();
    expect(result!.extraHighlights).toEqual([]);
  });

  it("找不到锚点时不返回布局，避免用过期坐标画错遮罩", () => {
    const highlight: ProductTourHighlightSpec = {
      anchorId: "missing-anchor"
    };
    const bubble: ProductTourBubblePlacement = {
      anchorId: "missing-anchor",
      side: "right",
      align: "start",
      gap: 16
    };

    expect(resolveProductTourStepLayout(highlight, bubble, anchors())).toBeNull();
  });

  it("above 把气泡放在遮罩上方并朝下指向高亮", () => {
    const highlight: ProductTourHighlightSpec = {
      anchorId: "scan-preferences",
      padding: { top: 8, right: 8, bottom: 8, left: 8 }
    };
    const bubble: ProductTourBubblePlacement = {
      anchorId: "scan-preferences",
      side: "above",
      align: "start",
      gap: 12
    };

    expect(
      resolveProductTourStepLayout(
        highlight,
        bubble,
        anchors(
          [["scan-preferences", { top: 560, left: 220, width: 720, height: 180 }]],
          { width: 1200, height: 800 }
        )
      )
    ).toEqual({
      highlight: { top: "552px", left: "212px", width: "736px", height: "196px" },
      extraHighlights: [],
      // 560 - 12 - 200 = 348
      bubblePosition: { top: "348px", left: "220px" },
      arrow: "bottom"
    });
  });

  it("侧栏气泡锚点远离底部遮罩时，仍贴着遮罩自适应（不钉在导航旁）", () => {
    const highlight: ProductTourHighlightSpec = {
      anchorId: "scan-preferences",
      padding: { top: 8, right: 8, bottom: 8, left: 8 }
    };
    const bubble: ProductTourBubblePlacement = {
      anchorId: "sources-nav",
      side: "right",
      align: "center",
      gap: 12
    };

    // Nav mid-left; Auto sync near bottom — preferred slot does not overlap mask.
    expect(
      resolveProductTourStepLayout(
        highlight,
        bubble,
        anchors(
          [
            ["sources-nav", { top: 280, left: 12, width: 168, height: 36 }],
            ["scan-preferences", { top: 560, left: 220, width: 720, height: 180 }]
          ],
          { width: 1200, height: 800 }
        )
      )
    ).toEqual({
      highlight: { top: "552px", left: "212px", width: "736px", height: "196px" },
      extraHighlights: [],
      // below mask does not fit; pin bottom edge 12px above padded highlight top (552)
      bubblePosition: { bottom: "260px", left: "212px" },
      arrow: "bottom"
    });
  });
});

describe("scrollProductTourHighlightIntoView", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("page-start 把最近可滚动祖先滚回顶部，而不是把高亮居中", () => {
    const scroller = document.createElement("div");
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1200 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });
    scroller.style.overflowY = "auto";
    scroller.scrollTop = 320;
    const scrollTo = vi.fn();
    scroller.scrollTo = scrollTo as unknown as typeof scroller.scrollTo;

    const highlight = document.createElement("div");
    scroller.appendChild(highlight);
    document.body.appendChild(scroller);

    const originalGetComputedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
      if (element === scroller) {
        return { overflowY: "auto" } as CSSStyleDeclaration;
      }
      return originalGetComputedStyle(element);
    });

    scrollProductTourHighlightIntoView(highlight, "page-start");

    expect(findClosestScrollableAncestor(highlight)).toBe(scroller);
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "auto" });
  });

  it("nearest 模式只做最近对齐，不强制回顶", () => {
    const highlight = document.createElement("div");
    const scrollIntoView = vi.fn();
    highlight.scrollIntoView = scrollIntoView;
    document.body.appendChild(highlight);

    scrollProductTourHighlightIntoView(highlight, "nearest");

    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest", behavior: "auto" });
  });

  it("page-end 把滚动容器滚到最底，用于自动同步等页底锚点", () => {
    const scroller = document.createElement("div");
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1200 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });
    scroller.style.overflowY = "auto";
    const scrollTo = vi.fn();
    scroller.scrollTo = scrollTo as unknown as typeof scroller.scrollTo;

    const highlight = document.createElement("div");
    scroller.appendChild(highlight);
    document.body.appendChild(scroller);

    const originalGetComputedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
      if (element === scroller) {
        return { overflowY: "auto" } as CSSStyleDeclaration;
      }
      return originalGetComputedStyle(element);
    });

    scrollProductTourHighlightIntoView(highlight, "page-end");

    expect(scrollTo).toHaveBeenCalledWith({ top: 800, behavior: "auto" });
  });
});

/** Handles anchors. */
function anchors(
  entries: Array<[string, { top: number; left: number; width: number; height: number }] | string> = [],
  viewport: ProductTourViewport = { width: 1024, height: 768 }
): ProductTourAnchorLookup {
  const rectMap = new Map<string, { top: number; left: number; right: number; bottom: number; width: number; height: number }>();

  entries.forEach((entry) => {
    if (typeof entry === "string") {
      const top = 184;
      const left = 8;
      const width = 300;
      const height = 40;
      rectMap.set(entry, { top, left, width, height, right: left + width, bottom: top + height });
      return;
    }

    const [anchorId, rect] = entry;
    rectMap.set(anchorId, {
      ...rect,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height
    });
  });

  return {
    getAnchorRect(anchorId) {
      return rectMap.get(anchorId) ?? null;
    },
    getViewport() {
      return viewport;
    }
  };
}
