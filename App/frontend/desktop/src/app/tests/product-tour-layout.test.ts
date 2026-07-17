/** Product tour layout tests. */
import { describe, expect, it } from "vitest";
import {
  resolveProductTourStepLayout,
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
      bubblePosition: { top: "204px", left: "324px", transform: "translateY(-50%)" }
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
      bubblePosition: { top: "169px", right: "28px" }
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
