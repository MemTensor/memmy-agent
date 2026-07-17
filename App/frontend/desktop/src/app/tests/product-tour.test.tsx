/** Product tour tests. */
import { readFileSync } from "node:fs";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { PRODUCT_TOUR_MEMORY_NAV_ANCHOR, PRODUCT_TOUR_TOOLS_CONTENT_ANCHOR, PRODUCT_TOUR_TOOLS_NAV_ANCHOR } from "../product-tour-layout.js";

import { resolveMainWindowActionRoute, resolveProductTourPath } from "../router.js";
import { ProductTourGuide, productTourSteps, productTourTabRoute, type ProductTourTab } from "../product-tour.js";

describe("ProductTourGuide", () => {
  it("keeps auth routes out of completed pet minimize preferences", () => {
    expect(resolveMainWindowActionRoute("/login")).toBe("login");
    expect(resolveMainWindowActionRoute("/welcome")).toBe("login");
    expect(resolveMainWindowActionRoute("/api-key")).toBe("auth");
    expect(resolveMainWindowActionRoute("/onboarding")).toBe("auth");
    expect(resolveMainWindowActionRoute("/main")).toBe("workspace");
    expect(resolveMainWindowActionRoute("/settings")).toBe("workspace");
  });

  it("原封不动保留 v2 原型 2 步导览内容和相对锚点", () => {
    expect(
      productTourSteps.map((step) => ({
        tab: step.tab,
        title: step.title,
        pose: step.pose,
        description: step.description,
        arrow: step.arrow,
        bubblePlacement: step.bubblePlacement,
        highlight: step.highlight,
        extraHighlights: step.extraHighlights
      }))
    ).toEqual([
      {
        tab: "memory",
        title: "记忆管理",
        pose: "brain",
        description: "查看和管理你的所有记忆，以及各 Agent 的接入状态。扫描完成后你会在这里看到结果",
        arrow: "left",
        bubblePlacement: {
          anchorId: PRODUCT_TOUR_MEMORY_NAV_ANCHOR,
          side: "right",
          align: "center",
          gap: 16
        },
        highlight: {
          anchorId: PRODUCT_TOUR_MEMORY_NAV_ANCHOR
        },
        extraHighlights: undefined
      },
      {
        tab: "tools",
        title: "连接与工具",
        pose: "chat",
        description: "在这里绑定 Telegram、Discord、微信、飞书等消息渠道，并启用 GitHub、Notion、Slack 等工具集成，让 Agent 跨平台、跨工具为你服务",
        arrow: "bottom",
        bubblePlacement: {
          anchorId: PRODUCT_TOUR_TOOLS_CONTENT_ANCHOR,
          side: "inside",
          blockAlign: "start",
          inlineAlign: "end",
          offsetX: 4,
          offsetY: 4
        },
        highlight: {
          anchorId: PRODUCT_TOUR_TOOLS_CONTENT_ANCHOR,
          padding: { top: 16, left: 16 },
          viewportBottom: 16
        },
        extraHighlights: [
          { anchorId: PRODUCT_TOUR_TOOLS_NAV_ANCHOR }
        ]
      }
    ]);
  });

  it("导览缺少 DOM 锚点时不在 SSR 阶段输出错误遮罩", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <ProductTourGuide onDismiss={() => undefined} onTabChange={() => undefined} />
      </I18nProvider>
    );

    expect(html).toBe("");
  });

  it("导览步骤配置在组件内保持稳定引用，避免布局测量循环清空气泡", () => {
    const source = readFileSync(new URL("../product-tour.tsx", import.meta.url), "utf8");

    expect(source).toContain("const steps = useMemo(() => createProductTourSteps(t)");
    expect(source).not.toContain("const steps = createProductTourSteps(t) as [ProductTourStep, ...ProductTourStep[]];");
  });

  it("只允许原型导览使用的页面 tab", () => {
    const tabs = new Set<ProductTourTab>(productTourSteps.map((step) => step.tab));

    expect([...tabs]).toEqual(["memory", "tools"]);
  });

  it("把原型内部 tab 映射到当前状态路由", () => {
    expect(resolveProductTourPath("chat")).toBe("/main");
    expect(resolveProductTourPath("tools")).toBe("/tools");
    expect(resolveProductTourPath("memory")).toBe("/main");
    expect(resolveProductTourPath("settings")).toBe("/settings");
  });

  it("导览 tab→路由映射为单一来源，memory 步骤留在主工作台而非跳独立记忆页", () => {
    expect(productTourTabRoute("chat")).toBe("/main");
    expect(productTourTabRoute("memory")).toBe("/main");
    expect(productTourTabRoute("tools")).toBe("/tools");
    expect(productTourTabRoute("settings")).toBe("/settings");
    expect(resolveProductTourPath("memory")).toBe(productTourTabRoute("memory"));
  });

  it("导览步骤索引落 sessionStorage，跨 AppFrame 重挂载续展而非重置回第一步", () => {
    const source = readFileSync(new URL("../product-tour.tsx", import.meta.url), "utf8");
    expect(source).toContain("readProductTourStep");
    expect(source).toContain("writeProductTourStep");
  });
});
