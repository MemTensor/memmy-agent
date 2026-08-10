/** Product tour tests. */
import { readFileSync } from "node:fs";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import {
  PRODUCT_TOUR_MEMORY_AGENTS_LIST_ANCHOR,
  PRODUCT_TOUR_MEMORY_LOGS_LIST_ANCHOR,
  PRODUCT_TOUR_MEMORY_OVERVIEW_COUNTS_ANCHOR,
  PRODUCT_TOUR_MEMORY_SCAN_PREFERENCES_ANCHOR,
  PRODUCT_TOUR_TOOLS_CONTENT_ANCHOR
} from "../product-tour-layout.js";

import { resolveMainWindowActionRoute, resolveProductTourPath } from "../router.js";
import {
  createProductTourSteps,
  productTourIncludesLogs,
  productTourStartMemorySubPage,
  productTourStartRoute,
  productTourSteps,
  productTourTabRoute,
  ProductTourGuide,
  type ProductTourTab
} from "../product-tour.js";
import { zhCNMessages } from "../../i18n/messages.js";

describe("ProductTourGuide", () => {
  it("keeps auth routes out of completed pet minimize preferences", () => {
    expect(resolveMainWindowActionRoute("/login")).toBe("login");
    expect(resolveMainWindowActionRoute("/welcome")).toBe("login");
    expect(resolveMainWindowActionRoute("/api-key")).toBe("auth");
    expect(resolveMainWindowActionRoute("/onboarding")).toBe("auth");
    expect(resolveMainWindowActionRoute("/main")).toBe("workspace");
    expect(resolveMainWindowActionRoute("/settings")).toBe("workspace");
  });

  it("默认 5 步导览：日志 → Agent ×2 → 记忆 → 工具", () => {
    expect(productTourSteps.map((step) => step.tab)).toEqual([
      "logs",
      "agents",
      "agentsScan",
      "overview",
      "tools"
    ]);
    expect(productTourSteps[0]?.highlight.anchorId).toBe(PRODUCT_TOUR_MEMORY_LOGS_LIST_ANCHOR);
    expect(productTourSteps[1]?.highlight.anchorId).toBe(PRODUCT_TOUR_MEMORY_AGENTS_LIST_ANCHOR);
    expect(productTourSteps[2]?.highlight.anchorId).toBe(PRODUCT_TOUR_MEMORY_SCAN_PREFERENCES_ANCHOR);
    expect(productTourSteps[2]?.bubblePlacement.side).toBe("right");
    expect(productTourSteps[3]?.highlight.anchorId).toBe(PRODUCT_TOUR_MEMORY_OVERVIEW_COUNTS_ANCHOR);
    expect(productTourSteps[4]?.highlight.anchorId).toBe(PRODUCT_TOUR_TOOLS_CONTENT_ANCHOR);
  });

  it("拒绝扫描授权时去掉日志步，变成 4 步导览", () => {
    const steps = createProductTourSteps((key) => zhCNMessages[key], { includeLogs: false });
    expect(steps.map((step) => step.tab)).toEqual([
      "agents",
      "agentsScan",
      "overview",
      "tools"
    ]);
    expect(productTourIncludesLogs("none")).toBe(false);
    expect(productTourIncludesLogs("unset")).toBe(false);
    expect(productTourIncludesLogs("scan_only")).toBe(true);
    expect(productTourIncludesLogs("scan_and_write_skill")).toBe(true);
    expect(productTourStartRoute(false)).toBe("/memory-sources");
    expect(productTourStartRoute(true)).toBe("/memory");
    expect(productTourStartMemorySubPage(false)).toBe("sources");
    expect(productTourStartMemorySubPage(true)).toBe("logs");
  });

  it("导览缺少 DOM 锚点时不在 SSR 阶段输出错误遮罩", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <ProductTourGuide onDismiss={() => undefined} onTabChange={() => undefined} />
      </I18nProvider>
    );

    expect(html).toBe("");
  });

  it("导览区分走完与跳过，并在气泡就绪后回调 step viewed", () => {
    const source = readFileSync(new URL("../product-tour.tsx", import.meta.url), "utf8");
    expect(source).toContain('onDismiss("completed", stepInfo)');
    expect(source).toContain('onDismiss("skipped", stepInfo)');
    expect(source).toContain("onStepViewed");
    expect(source).toContain("lastViewedStepKeyRef");
  });

  it("导览步骤配置在组件内保持稳定引用，避免布局测量循环清空气泡", () => {
    const source = readFileSync(new URL("../product-tour.tsx", import.meta.url), "utf8");

    expect(source).toContain("const steps = useMemo(");
    expect(source).toContain("createProductTourSteps(t, { includeLogs })");
    expect(source).not.toContain("const steps = createProductTourSteps(t) as [ProductTourStep, ...ProductTourStep[]];");
  });

  it("拒绝授权末步 CTA 用开始使用，扫描用户用进入首次对话", () => {
    const source = readFileSync(new URL("../product-tour.tsx", import.meta.url), "utf8");
    expect(source).toContain('includeLogs ? t("onboarding.featureDig.startChat") : t("productTour.start")');
  });

  it("导览 tab 覆盖日志、跨 Agent、概览与工具", () => {
    const tabs = new Set<ProductTourTab>(productTourSteps.map((step) => step.tab));

    expect([...tabs]).toEqual(["logs", "agents", "agentsScan", "overview", "tools"]);
  });

  it("把导览 tab 映射到当前状态路由", () => {
    expect(resolveProductTourPath("chat")).toBe("/main");
    expect(resolveProductTourPath("tools")).toBe("/tools");
    expect(resolveProductTourPath("logs")).toBe("/memory");
    expect(resolveProductTourPath("overview")).toBe("/memory");
    expect(resolveProductTourPath("agents")).toBe("/memory-sources");
    expect(resolveProductTourPath("settings")).toBe("/settings");
  });

  it("导览 tab→路由映射为单一来源", () => {
    expect(productTourTabRoute("chat")).toBe("/main");
    expect(productTourTabRoute("logs")).toBe("/memory");
    expect(productTourTabRoute("overview")).toBe("/memory");
    expect(productTourTabRoute("agents")).toBe("/memory-sources");
    expect(productTourTabRoute("tools")).toBe("/tools");
    expect(productTourTabRoute("settings")).toBe("/settings");
    expect(resolveProductTourPath("logs")).toBe(productTourTabRoute("logs"));
  });

  it("导览步骤索引落 sessionStorage，跨 AppFrame 重挂载续展而非重置回第一步", () => {
    const source = readFileSync(new URL("../product-tour.tsx", import.meta.url), "utf8");
    expect(source).toContain("readProductTourStep");
    expect(source).toContain("writeProductTourStep");
  });

  it("记忆页导览回顶保留标题；agentsScan 把滚动容器滚到最底高亮自动同步", () => {
    const source = readFileSync(new URL("../product-tour.tsx", import.meta.url), "utf8");
    expect(source).toContain("scrollProductTourHighlightIntoView");
    expect(source).toContain('current.tab === "agentsScan"');
    expect(source).toContain('"page-end"');
    expect(source).toContain('"page-start"');
    expect(source).not.toContain('scrollIntoView({ block: "center"');
  });
});
